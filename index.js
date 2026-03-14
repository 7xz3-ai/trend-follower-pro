'use strict';
const fs        = require('fs');
const express   = require('express');
const http      = require('http');
const https     = require('https');
const path      = require('path');
const WebSocket = require('ws');
const { WebSocketServer } = require('ws');

const API_KEY    = process.env.ALPACA_API_KEY    || '';
const API_SECRET = process.env.ALPACA_SECRET_KEY || '';
const PORT       = parseInt(process.env.PORT || '3000', 10);

const BROKER_HOST = 'paper-api.alpaca.markets';
const DATA_HOST   = 'data.alpaca.markets';

const SYMBOLS = [
  'NVDA','TSLA','AAPL','MSFT','AMZN','META','GOOGL',
  'AMD','SMCI','MSTR','SOXL',
  'SPY','QQQ','TQQQ',
  'PLTR','NFLX','COIN','MARA','SOFI','RIVN'
];

// orderId -> {symbol, qty, sl, tp, entryPrice, isAuto, enteredAt, legs:[]}
// Child leg IDs (stop_loss/take_profit) are derived in memory; only parents written to disk.
const orderMeta = new Map();

// Persistent JSON store -- survives Railway restarts and sleep cycles.
// We write atomically (tmp file then rename) to prevent corruption on crash.
const META_FILE = path.join(__dirname, 'metadata.json');

function loadMeta() {
  try {
    if (!fs.existsSync(META_FILE)) { console.log('[META] No metadata.json yet -- fresh start'); return; }
    const entries = JSON.parse(fs.readFileSync(META_FILE, 'utf8'));
    let loaded = 0;
    for (const [id, meta] of Object.entries(entries)) {
      orderMeta.set(id, meta);
      // Re-derive child leg entries from stored leg list so enrichment works after restart
      if (Array.isArray(meta.legs)) {
        meta.legs.forEach(leg => orderMeta.set(leg.id, { ...meta, parentId: id, legType: leg.type }));
      }
      loaded++;
    }
    console.log('[META] Loaded', loaded, 'order record(s) from metadata.json');
  } catch(e) {
    console.log('[META] Load error (safe on first run):', e.message);
  }
}

function saveMeta() {
  try {
    const toWrite = {};
    // Only persist parent entries -- child leg copies are re-derived on load
    for (const [id, meta] of orderMeta) {
      if (!meta.parentId) toWrite[id] = meta;
    }
    const tmp = META_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(toWrite, null, 2), 'utf8');
    fs.renameSync(tmp, META_FILE); // atomic replace
  } catch(e) {
    console.log('[META] Save error:', e.message);
  }
}

function storeOrderMeta(order, sl, tp, qty, isAuto) {
  // Capture leg IDs so we can re-derive them after a restart
  const legs = Array.isArray(order.legs)
    ? order.legs.map(leg => ({ id: leg.id, type: leg.type }))
    : [];
  const meta = { symbol: order.symbol, qty, sl, tp, entryPrice: null, isAuto: !!isAuto, enteredAt: Date.now(), legs };
  orderMeta.set(order.id, meta);
  // Index child legs in memory (not written to disk -- re-derived on load)
  legs.forEach(leg => orderMeta.set(leg.id, { ...meta, parentId: order.id, legType: leg.type }));
  saveMeta();
  // Auto-expire after 24 h; remove from file too
  setTimeout(() => { orderMeta.delete(order.id); saveMeta(); }, 86400000);
}

function httpsReq(hostname, method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const opts = {
      hostname, path: apiPath, method,
      headers: {
        'APCA-API-KEY-ID': API_KEY, 'APCA-API-SECRET-KEY': API_SECRET,
        'Accept': 'application/json', 'Content-Type': 'application/json',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {})
      }
    };
    const req = https.request(opts, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        // 204 No Content and similar empty bodies are valid success responses
        if (!raw.trim()) return resolve({});
        let parsed;
        try { parsed = JSON.parse(raw); } catch { return reject(new Error(`JSON parse error (HTTP ${res.statusCode}): ${raw.slice(0,120)}`)); }
        if (res.statusCode >= 400) {
          const err = new Error(parsed.message || `HTTP ${res.statusCode}`);
          err.status = res.statusCode; err.alpacaCode = parsed.code; err.body = parsed;
          return reject(err);
        }
        resolve(parsed);
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('Timeout')); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

const broker  = (method, p, body) => httpsReq(BROKER_HOST, method, p, body);
const dataApi = p => httpsReq(DATA_HOST, 'GET', p, null);

async function fetchAllBars(symbol, timeframe, start, end, maxBars = 10000) {
  let bars = [], pageToken = null, pages = 0;
  while (pages < 10 && bars.length < maxBars) {
    let p = `/v2/stocks/${encodeURIComponent(symbol)}/bars?timeframe=${timeframe}&limit=1000&adjustment=raw&feed=iex`;
    if (start) p += `&start=${encodeURIComponent(start)}`;
    if (end)   p += `&end=${encodeURIComponent(end)}`;
    if (pageToken) p += `&page_token=${encodeURIComponent(pageToken)}`;
    const data = await dataApi(p);
    if (data.bars && data.bars.length) bars = bars.concat(data.bars);
    if (data.next_page_token) { pageToken = data.next_page_token; pages++; } else break;
  }
  return bars;
}

const clients = new Map();
let cid = 1;
function broadcast(data) {
  const p = JSON.stringify(data);
  clients.forEach((_, ws) => { if (ws.readyState === WebSocket.OPEN) try { ws.send(p); } catch {} });
}

// Market data stream (price ticks)
const alpaca = { ws: null, ready: false, reconnMs: 1000, timer: null, lastTick: new Map() };
function connectAlpaca() {
  if (alpaca.timer) { clearTimeout(alpaca.timer); alpaca.timer = null; }
  // Tear down previous socket to prevent leaked connections on rapid reconnect
  if (alpaca.ws) { try { alpaca.ws.removeAllListeners(); alpaca.ws.terminate(); } catch {} alpaca.ws = null; }
  if (!API_KEY) { console.log('[DATA] No API keys'); return; }
  const ws = new WebSocket('wss://stream.data.alpaca.markets/v2/iex');
  alpaca.ws = ws;
  ws.on('open', () => ws.send(JSON.stringify({ action: 'auth', key: API_KEY, secret: API_SECRET })));
  ws.on('message', raw => {
    let msgs; try { msgs = JSON.parse(raw); if (!Array.isArray(msgs)) msgs = [msgs]; } catch { return; }
    msgs.forEach(msg => {
      if (msg.T === 'success' && msg.msg === 'authenticated') {
        ws.send(JSON.stringify({ action: 'subscribe', trades: SYMBOLS, quotes: [], bars: [] }));
        alpaca.ready = true; alpaca.reconnMs = 1000;
        broadcast({ type: 'alpaca_connected', symbols: SYMBOLS });
        console.log('[DATA] Authenticated and subscribed');
      }
      if (msg.T === 't') {
        const now = Date.now();
        if (now - (alpaca.lastTick.get(msg.S) || 0) < 50) return;
        alpaca.lastTick.set(msg.S, now);
        broadcast({ type: 'tick', symbol: msg.S, price: msg.p });
      }
    });
  });
  ws.on('close', () => {
    alpaca.ready = false;
    const d = alpaca.reconnMs;
    // Cap at 60s so weekend disconnects don't build up unbounded backoff
    alpaca.timer = setTimeout(() => { alpaca.reconnMs = Math.min(d * 2, 60000); connectAlpaca(); }, d);
    console.log('[DATA] Disconnected, reconnecting in', d, 'ms');
  });
  ws.on('error', err => console.log('[DATA] Error:', err.message));
}

// Trade updates stream - fires when SL/TP hit or orders fill on Alpaca's side
const tradeStream = { ws: null, ready: false, reconnMs: 1000, timer: null };
function connectTradeUpdates() {
  if (tradeStream.timer) { clearTimeout(tradeStream.timer); tradeStream.timer = null; }
  if (tradeStream.ws) { try { tradeStream.ws.removeAllListeners(); tradeStream.ws.terminate(); } catch {} tradeStream.ws = null; }
  if (!API_KEY) return;
  console.log('[TRADE] Connecting trade_updates stream...');
  const ws = new WebSocket('wss://paper-api.alpaca.markets/stream');
  tradeStream.ws = ws;

  ws.on('open', () => ws.send(JSON.stringify({ action: 'auth', key: API_KEY, secret: API_SECRET })));
  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }

    if (msg.stream === 'authorization') {
      if (msg.data && msg.data.status === 'authorized') {
        ws.send(JSON.stringify({ action: 'listen', data: { streams: ['trade_updates'] } }));
        tradeStream.ready = true; tradeStream.reconnMs = 1000;
        console.log('[TRADE] Authorized - listening to trade_updates');
        broadcast({ type: 'trade_stream_ready' });
      } else {
        console.log('[TRADE] Auth failed:', msg.data && msg.data.message);
        broadcast({ type: 'trade_stream_error', reason: (msg.data && msg.data.message) || 'Auth failed' });
      }
    }

    if (msg.stream === 'trade_updates') {
      const update = msg.data;
      const order  = update.order;
      if (!order) return;

      const meta = orderMeta.get(order.id);

      // Record fill price when buy entry executes
      if (update.event === 'fill' && order.side === 'buy' && meta) {
        meta.entryPrice = parseFloat(order.filled_avg_price);
        orderMeta.set(order.id, meta);
        saveMeta(); // persist real fill price so it survives restart
      }

      const payload = {
        type:             'trade_update',
        event:            update.event,
        symbol:           order.symbol,
        order_id:         order.id,
        order_type:       order.type,
        order_class:      order.order_class,
        side:             order.side,
        qty:              parseFloat(order.qty || 0),
        filled_qty:       parseFloat(order.filled_qty || 0),
        filled_avg_price: parseFloat(order.filled_avg_price || 0),
        status:           order.status,
        reject_reason:    order.reject_reason || null,
        position_qty:     parseFloat(update.position_qty || 0),
        timestamp:        update.timestamp,
        sl:               meta ? meta.sl : null,
        tp:               meta ? meta.tp : null,
        isAuto:           meta ? meta.isAuto : false,
        entry_price:      meta ? meta.entryPrice : null,
        entered_at:       meta ? meta.enteredAt : null
      };

      broadcast(payload);
      console.log('[TRADE]', update.event, order.side, order.symbol, order.status, 'filled:', order.filled_qty, '/', order.qty);

      if (['filled','canceled','expired','rejected'].includes(order.status)) {
        // Keep in memory 2 min for late enrichment, then purge from disk too
        setTimeout(() => { orderMeta.delete(order.id); saveMeta(); }, 120000);
      }
    }
  });
  ws.on('close', () => {
    tradeStream.ready = false;
    const d = tradeStream.reconnMs;
    tradeStream.timer = setTimeout(() => { tradeStream.reconnMs = Math.min(d * 2, 30000); connectTradeUpdates(); }, d);
    console.log('[TRADE] Disconnected, reconnecting in', d, 'ms');
  });
  ws.on('error', err => console.log('[TRADE] WS error:', err.message));
}

const app    = express();
const server = http.createServer(app);

app.use(express.json());
// CORS: In production, set FRONTEND_ORIGIN to your Vercel/Netlify URL for tighter security.
// e.g. FRONTEND_ORIGIN=https://my-tfp.vercel.app
const ALLOWED_ORIGIN = process.env.FRONTEND_ORIGIN || '*';
app.use((_, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});
app.options('*', (_, res) => res.sendStatus(204));
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    // Prevent browsers from caching index.html -- ensures code changes deploy immediately.
    // CSS/JS library CDN assets are versioned in the URL and unaffected.
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
    }
  }
}));

app.get('/health', (_, res) => res.json({
  ok: true, paper: true,
  dataStream: alpaca.ready, tradeStream: tradeStream.ready,
  pendingOrders: orderMeta.size, clients: clients.size
}));

// Real paper account balance from Alpaca
app.get('/api/account', async (_, res) => {
  if (!API_KEY) return res.status(401).json({ error: 'No Alpaca API keys configured' });
  try {
    const a = await broker('GET', '/v2/account');
    res.json({
      equity:          parseFloat(a.equity),
      cash:            parseFloat(a.cash),
      buying_power:    parseFloat(a.buying_power),
      portfolio_value: parseFloat(a.portfolio_value),
      daytrade_count:  a.daytrade_count,
      pattern_day_trader: a.pattern_day_trader,
      status:          a.status
    });
  } catch(e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Real open positions enriched with our SL/TP metadata
app.get('/api/positions', async (_, res) => {
  if (!API_KEY) return res.status(401).json({ error: 'No Alpaca API keys configured' });
  try {
    const positions = await broker('GET', '/v2/positions');
    const list = Array.isArray(positions) ? positions : [];
    const enriched = list.map(p => {
      let meta = null;
      for (const [, m] of orderMeta) { if (m.symbol === p.symbol && !m.parentId) { meta = m; break; } }
      return {
        id:              p.asset_id,
        symbol:          p.symbol,
        qty:             parseFloat(p.qty),
        avg_entry_price: parseFloat(p.avg_entry_price),
        current_price:   parseFloat(p.current_price || p.avg_entry_price),
        unrealized_pl:   parseFloat(p.unrealized_pl),
        market_value:    parseFloat(p.market_value),
        sl:              meta ? meta.sl    : null,
        tp:              meta ? meta.tp    : null,
        isAuto:          meta ? meta.isAuto : false,
        entered_at:      meta ? meta.enteredAt : null
      };
    });
    res.json(enriched);
  } catch(e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Submit bracket order to Alpaca Paper API
// Entry (market) + Stop Loss + Take Profit all live on Alpaca's servers
app.post('/api/trade', async (req, res) => {
  if (!API_KEY) return res.status(401).json({ error: 'No Alpaca API keys configured' });

  const { symbol, qty, stopLoss, takeProfit, price, isAuto } = req.body;

  if (!symbol || !qty || !stopLoss || !takeProfit) {
    return res.status(400).json({ error: 'Required fields: symbol, qty, stopLoss, takeProfit' });
  }
  const qtyInt = Math.floor(Number(qty));
  if (qtyInt < 1)             return res.status(400).json({ error: 'qty must be >= 1 share' });
  if (stopLoss >= takeProfit) return res.status(400).json({ error: 'stopLoss must be below takeProfit' });
  if (price && stopLoss >= price)   return res.status(400).json({ error: 'stopLoss must be below entry price' });
  if (price && takeProfit <= price) return res.status(400).json({ error: 'takeProfit must be above entry price' });

  const payload = {
    symbol,
    qty:           String(qtyInt),
    side:          'buy',
    type:          'market',
    time_in_force: 'day',
    order_class:   'bracket',
    stop_loss:   { stop_price:  stopLoss.toFixed(2)  },
    take_profit: { limit_price: takeProfit.toFixed(2) }
  };

  console.log('[TRADE] Submit:', symbol, 'x' + qtyInt, 'SL:' + stopLoss, 'TP:' + takeProfit, isAuto ? 'AUTO' : 'MANUAL');

  try {
    const order = await broker('POST', '/v2/orders', payload);
    storeOrderMeta(order, stopLoss, takeProfit, qtyInt, isAuto);
    console.log('[TRADE] Accepted:', order.id, order.status, 'legs:', order.legs ? order.legs.length : 0);
    res.json({ success: true, order_id: order.id, symbol, qty: qtyInt, status: order.status, sl: stopLoss, tp: takeProfit });
  } catch(e) {
    console.log('[TRADE] Rejected:', e.message);
    res.status(e.status || 500).json({ error: e.message, alpaca_code: e.alpacaCode, symbol, qty: qtyInt });
  }
});

// POST /api/close-position  { symbol: "NVDA" }
// Using POST + body instead of DELETE /:symbol avoids any Express route-param
// ambiguity and is safe for any future symbol format (crypto: BTC/USD, etc.).
// cancel_orders=true cancels the open SL/TP bracket legs before liquidating.
app.post('/api/close-position', async (req, res) => {
  console.log('[CLOSE] Request received, body:', req.body);   // confirm route is hit
  if (!API_KEY) return res.status(401).json({ error: 'No Alpaca API keys configured' });

  const { symbol } = req.body;
  if (!symbol) return res.status(400).json({ error: 'symbol is required in request body' });

  console.log('[CLOSE] Liquidating', symbol, 'with cancel_orders=true');
  try {
    const result = await broker('DELETE', `/v2/positions/${encodeURIComponent(symbol)}?cancel_orders=true`);
    console.log('[CLOSE]', symbol, 'OK - order id:', result.id || '(empty)', 'status:', result.status || '(empty)');
    res.json({ success: true, symbol, order_id: result.id || null, status: result.status || null });
  } catch(e) {
    console.log('[CLOSE] Alpaca error for', symbol, '- HTTP', e.status, '-', e.message, '- body:', JSON.stringify(e.body || {}));
    res.status(e.status || 500).json({ error: e.message, alpaca_code: e.alpacaCode, symbol });
  }
});

// Closed order history from Alpaca
app.get('/api/orders', async (req, res) => {
  if (!API_KEY) return res.status(401).json({ error: 'No Alpaca API keys configured' });
  try {
    const { limit = '100' } = req.query;
    const orders = await broker('GET', `/v2/orders?status=closed&limit=${limit}&direction=desc&nested=true`);
    const list = Array.isArray(orders) ? orders : [];
    res.json(list.filter(o => o.status === 'filled').map(o => {
      const m = orderMeta.get(o.id);
      return {
        order_id: o.id, symbol: o.symbol, side: o.side,
        order_type: o.type, order_class: o.order_class,
        qty: parseFloat(o.qty), filled_qty: parseFloat(o.filled_qty),
        filled_avg_price: parseFloat(o.filled_avg_price),
        submitted_at: o.submitted_at, filled_at: o.filled_at,
        sl: m ? m.sl : null, tp: m ? m.tp : null,
        entry: m ? m.entryPrice : null, isAuto: m ? m.isAuto : false
      };
    }));
  } catch(e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// -- Real ATR endpoint with per-symbol server-side cache ----------------------
// Fetches last 15 five-minute bars and computes true ATR (14 TRs averaged).
// True Range = max(High-Low, |High-PrevClose|, |Low-PrevClose|).
// Result cached 60 seconds so the auto-engine never floods the data API.
const atrCache = new Map(); // symbol -> { atr, price, ts, bars_used }
const ATR_CACHE_TTL = 60000;

function calcATR(bars) {
  if (bars.length < 2) return null;
  let trSum = 0;
  for (let i = 1; i < bars.length; i++) {
    const h = bars[i].h, l = bars[i].l, pc = bars[i - 1].c;
    trSum += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  return trSum / (bars.length - 1);
}

app.get('/api/atr/:symbol', async (req, res) => {
  const { symbol } = req.params;
  if (!API_KEY) return res.status(401).json({ error: 'No API keys' });
  // Serve cache if fresh enough
  const cached = atrCache.get(symbol);
  if (cached && Date.now() - cached.ts < ATR_CACHE_TTL) {
    return res.json({ symbol, atr: cached.atr, price: cached.price, cached: true, bars_used: cached.bars_used });
  }
  try {
    // 15 bars gives us 14 true-range values -- canonical ATR(14)
    const data = await dataApi(`/v2/stocks/${encodeURIComponent(symbol)}/bars?timeframe=5Min&limit=15&adjustment=raw&feed=iex`);
    const bars = data.bars || [];
    if (bars.length < 2) return res.status(400).json({ error: 'Insufficient data for ATR', symbol });
    const atr  = calcATR(bars);
    const price = bars[bars.length - 1].c;
    const entry = { atr: parseFloat(atr.toFixed(4)), price, ts: Date.now(), bars_used: bars.length };
    atrCache.set(symbol, entry);
    console.log(`[ATR] ${symbol} ATR=${entry.atr} price=${price} bars=${bars.length}`);
    res.json({ symbol, atr: entry.atr, price: entry.price, cached: false, bars_used: entry.bars_used });
  } catch(e) {
    console.log('[ATR] Error for', symbol, ':', e.message);
    res.status(500).json({ error: e.message, symbol });
  }
});

// Market data endpoints (unchanged)
app.get('/api/bars/:symbol', (req, res) => {
  const { symbol } = req.params;
  const { timeframe = '5Min', limit = '390', start, end } = req.query;
  if (!API_KEY) return res.status(401).json({ error: 'No API keys' });
  let p = `/v2/stocks/${encodeURIComponent(symbol)}/bars?timeframe=${timeframe}&limit=${limit}&adjustment=raw&feed=iex`;
  if (start) p += `&start=${encodeURIComponent(start)}`;
  if (end)   p += `&end=${encodeURIComponent(end)}`;
  dataApi(p).then(d => res.json(d)).catch(e => res.status(500).json({ error: e.message }));
});

app.get('/api/history/:symbol', async (req, res) => {
  const { symbol } = req.params;
  const { timeframe = '1Day', days = '30' } = req.query;
  if (!API_KEY) return res.status(401).json({ error: 'No API keys' });
  try {
    const end = new Date(), start = new Date();
    start.setDate(start.getDate() - parseInt(days));
    const bars = await fetchAllBars(symbol, timeframe, start.toISOString(), end.toISOString());
    res.json({ symbol, timeframe, days: parseInt(days), count: bars.length, bars });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================================
// BACKTEST ENGINE
// computeSignalBT is an exact server-side mirror of the frontend computeSignal.
// Any change to the live signal engine MUST be mirrored here to keep results
// comparable with live paper-trading performance.
// ============================================================================

const f2bt   = v => Math.round(v * 100) / 100;
const f4bt   = v => Math.round(v * 10000) / 10000;
const clmpBt = (v, mn, mx) => Math.min(mx, Math.max(mn, v));

// ============================================================================
// STRATEGY: Volatility Compression Breakout + Trend Momentum
// ============================================================================
// Edge: exploits the "volatility clustering" phenomenon.  Tight Bollinger Bands
// (squeeze) predict imminent large moves.  We enter on the breakout side with
// trend confirmation, using ATR for risk-calibrated SL/TP.
//
// Three entry modes:
//   SQUEEZE_BREAK  – BB width < its 20-bar avg AND price closes above upper BB
//   TREND_MOMENTUM – price above EMA21 > EMA50, RSI 45-65, positive momentum
//   MEAN_REVERT    – price touches lower BB in uptrend, RSI < 38, bounce candle
// ============================================================================

function computeSignalBT(prev, newPrice, realAtr) {
  const vol  = prev.vol  ?? 0.02;
  const atr  = realAtr != null ? f2bt(realAtr) : f2bt(newPrice * vol);

  // -- EMAs -------------------------------------------------------------------
  const ema9   = f2bt(newPrice * 0.2   + (prev.ema9   ?? newPrice) * 0.8);
  const ema21  = f2bt(newPrice * 0.09  + (prev.ema21  ?? newPrice) * 0.91);
  const ema50  = f2bt(newPrice * 0.038 + (prev.ema50  ?? newPrice) * 0.962);
  const ema200 = f2bt(newPrice * 0.01  + (prev.ema200 ?? newPrice) * 0.99);

  // -- RSI (Wilder 14-period approximation) -----------------------------------
  const chg  = newPrice - (prev.price ?? newPrice);
  const gain = chg > 0 ? chg : 0;
  const loss = chg < 0 ? -chg : 0;
  const avgGain = f4bt((prev.avgGain ?? (atr * 0.5)) * 0.857 + gain * 0.143);
  const avgLoss = f4bt((prev.avgLoss ?? (atr * 0.5)) * 0.857 + loss * 0.143);
  const rs  = avgLoss === 0 ? 100 : avgGain / avgLoss;
  const rsi = f2bt(clmpBt(100 - (100 / (1 + rs)), 5, 95));

  // -- Bollinger Bands (20-period SMA + 2 SD) ---------------------------------
  // Maintain rolling window of last 20 closes in prev.bbWindow
  const bbWindow = [...(prev.bbWindow || []), newPrice].slice(-20);
  const bbLen    = bbWindow.length;
  const bbSma    = bbWindow.reduce((a, v) => a + v, 0) / bbLen;
  const bbStd    = Math.sqrt(bbWindow.reduce((a, v) => a + (v - bbSma) ** 2, 0) / bbLen);
  const bbUpper  = f2bt(bbSma + 2 * bbStd);
  const bbLower  = f2bt(bbSma - 2 * bbStd);
  const bbWidth  = bbSma > 0 ? f4bt((bbUpper - bbLower) / bbSma) : 0.04;

  // -- Keltner Channel (20-period EMA + 1.5 ATR) for squeeze detection --------
  const kcUpper = f2bt(ema21 + 1.5 * atr);
  const kcLower = f2bt(ema21 - 1.5 * atr);
  const squeeze = bbUpper < kcUpper && bbLower > kcLower; // BB inside KC = squeeze

  // -- BB width SMA (track avg width over 20 bars for compression detection) --
  const bbwHistory = [...(prev.bbwHistory || []), bbWidth].slice(-20);
  const bbwAvg     = bbwHistory.reduce((a, v) => a + v, 0) / bbwHistory.length;
  const compressed = bbWidth < bbwAvg * 0.85;  // width 15%+ below avg

  // -- Momentum ---------------------------------------------------------------
  const momentum = prev.price ? (newPrice - prev.price) / prev.price : 0;

  // -- Trend classification ---------------------------------------------------
  const uptrend   = newPrice > ema21 && ema21 > ema50;
  const strongUp  = uptrend && ema50 > ema200;
  const downtrend = newPrice < ema21 && ema21 < ema50;

  // -- Rate of change (5 bars) ------------------------------------------------
  const roc5 = prev.price5ago ? (newPrice - prev.price5ago) / prev.price5ago : 0;
  const priceHist = [...(prev.priceHist || []), newPrice].slice(-6);
  const price5ago = priceHist.length >= 6 ? priceHist[0] : null;

  // ==========================================================================
  // ENTRY STRATEGIES
  // ==========================================================================

  // 1. SQUEEZE BREAKOUT: BB compressed + price breaks above upper BB
  //    This is the highest-edge setup — volatility expansion after compression.
  const sqzBreak = (squeeze || compressed) &&
                   newPrice > bbUpper &&
                   momentum > 0.001 &&
                   rsi >= 45 && rsi <= 75 &&
                   !downtrend;

  // 2. TREND MOMENTUM: riding established trends with momentum confirmation
  //    Enter when trend is established, RSI is mid-range (not exhausted),
  //    and short-term momentum is positive.
  const trendMom = strongUp &&
                   newPrice > ema9 &&
                   rsi >= 42 && rsi <= 64 &&
                   momentum > 0.002 &&
                   roc5 > 0.005 &&
                   bbLen >= 10;

  // 3. MEAN REVERSION: buy the dip in uptrends at BB lower band
  //    Price near lower BB + uptrend intact + RSI washed = high-prob reversal.
  const meanRev = uptrend &&
                  newPrice <= bbLower * 1.005 &&
                  rsi >= 22 && rsi <= 40 &&
                  momentum > -0.02 &&
                  newPrice > ema50;

  // ==========================================================================
  // SCORING — conservative scoring to reduce false signals
  // ==========================================================================
  const s1 = sqzBreak ? (0.65 + clmpBt(momentum / 0.02, 0, 0.20) + (squeeze ? 0.10 : 0.05)) : 0;
  const s2 = trendMom ? (0.58 + clmpBt(roc5 / 0.03, 0, 0.22) + clmpBt((rsi - 42) / 30, 0, 0.10)) : 0;
  const s3 = meanRev  ? (0.62 + clmpBt((40 - rsi) / 30, 0, 0.25) + (strongUp ? 0.08 : 0)) : 0;

  const bestScore = Math.max(s1, s2, s3);
  const entryType = bestScore === s1 ? 'SQUEEZE_BREAK' :
                    bestScore === s2 ? 'TREND_MOMENTUM' : 'MEAN_REVERT';
  const strength  = clmpBt(bestScore * 100, 10, 98);

  // -- Signal decision --------------------------------------------------------
  let signal = 'HOLD';
  if (bestScore >= 0.58 && !downtrend) signal = 'BUY';
  else if (rsi >= 78 || (downtrend && momentum < -0.008)) signal = 'SELL';

  // -- Risk management: ATR-calibrated SL/TP ----------------------------------
  // Tighter stops on squeeze breakouts (high conviction), wider on mean reversion.
  const slMult = { SQUEEZE_BREAK: 1.5, TREND_MOMENTUM: 1.8, MEAN_REVERT: 2.0 }[entryType] || 1.5;
  const tpMult = { SQUEEZE_BREAK: 4.0, TREND_MOMENTUM: 3.5, MEAN_REVERT: 3.0 }[entryType] || 3.5;
  const stopLoss   = signal === 'BUY' ? f2bt(newPrice - atr * slMult) : null;
  const takeProfit = signal === 'BUY' ? f2bt(newPrice + atr * tpMult) : null;
  const riskReward = stopLoss && takeProfit
    ? +((takeProfit - newPrice) / (newPrice - stopLoss)).toFixed(2) : null;

  return {
    atr, ema9, ema21, ema50, ema200, avgGain, avgLoss,
    rsi, momentum, uptrend, strongUp, downtrend,
    bbUpper, bbLower, bbWidth, bbSma: f2bt(bbSma), squeeze, compressed,
    signal, signalStrength: f2bt(strength),
    entryType: signal === 'BUY' ? entryType : null,
    stopLoss, takeProfit, riskReward,
    price: newPrice, vol,
    // Carry forward for next iteration
    bbWindow, bbwHistory, priceHist, price5ago
  };
}

async function runBacktest({ symbols, days, timeframe, initialEquity, posAmt, maxPositions, minStrength, cooldownBars }) {
  // -- 1. Fetch all bars (parallel batches of 4) -------------------------------
  const end   = new Date();
  const start = new Date(); start.setDate(start.getDate() - days);
  console.log(`[BT] Starting: ${symbols.length} symbols, ${days} days, ${timeframe}`);

  const allBars = {};
  const BATCH = 4;
  for (let i = 0; i < symbols.length; i += BATCH) {
    const batch = symbols.slice(i, i + BATCH);
    await Promise.all(batch.map(async sym => {
      try {
        allBars[sym] = await fetchAllBars(sym, timeframe, start.toISOString(), end.toISOString(), 20000);
        console.log(`[BT] ${sym}: ${allBars[sym].length} bars`);
      } catch(e) {
        console.log(`[BT] ${sym}: fetch failed:`, e.message);
        allBars[sym] = [];
      }
    }));
  }

  // -- 2. Build unified chronological timeline --------------------------------
  const timeline = [];
  for (const [sym, bars] of Object.entries(allBars)) {
    for (const bar of bars) timeline.push({ sym, bar });
  }
  timeline.sort((a, b) => new Date(a.bar.t) - new Date(b.bar.t));
  console.log(`[BT] Timeline: ${timeline.length} events`);

  // -- 3. Simulation loop -----------------------------------------------------
  const sigState   = {};   // sym -> last computeSignalBT output
  const barWindow  = {};   // sym -> last 15 bars for true ATR
  const cooldowns  = {};   // sym -> last entry bar index
  const positions  = [];   // active simulated positions
  const trades     = [];   // completed trades
  let   cash       = initialEquity;
  let   barIdx     = 0;

  for (const { sym, bar } of timeline) {
    barIdx++;
    const price = bar.c;
    const ts    = new Date(bar.t).getTime();

    // Maintain rolling 15-bar window for ATR
    if (!barWindow[sym]) barWindow[sym] = [];
    barWindow[sym].push(bar);
    if (barWindow[sym].length > 15) barWindow[sym].shift();

    // -- Evaluate open positions for this symbol on this bar --
    for (let i = positions.length - 1; i >= 0; i--) {
      const pos = positions[i];
      if (pos.symbol !== sym) continue;

      let exitPx = null, exitType = null;
      // Conservative: if both SL and TP hit in the same bar, stop wins.
      if (bar.l <= pos.stopLoss) {
        // Realistic gap fill: if the open is already below SL, exit at open
        exitPx   = Math.min(bar.o, pos.stopLoss);
        exitType = 'STOP_LOSS';
      } else if (bar.h >= pos.takeProfit) {
        exitPx   = pos.takeProfit;
        exitType = 'TAKE_PROFIT';
      }

      if (exitPx !== null) {
        const profit  = f2bt((exitPx - pos.entryPrice) * pos.shares);
        cash         += f2bt(exitPx * pos.shares);
        const heldMs  = ts - pos.enteredAt;
        trades.push({
          symbol:   pos.symbol,
          type:     exitType,
          entry:    pos.entryPrice,
          exit:     exitPx,
          profit,
          rr:       pos.riskReward,
          held:     Math.round(heldMs / 1000) + 's',
          strategy: pos.entryType,
          ts,
          t:        new Date(ts).toLocaleTimeString('en-US', { hour12: false })
        });
        positions.splice(i, 1);
        cooldowns[sym] = barIdx;
      }
    }

    // -- Entry gate checks --
    if (positions.some(p => p.symbol === sym)) {
      // Already holding this symbol; just warm up the signal state
      const prev = sigState[sym] || {};
      sigState[sym] = { ...computeSignalBT(prev, price, calcATR(barWindow[sym]) || null), price };
      continue;
    }
    if ((cooldowns[sym] || 0) && (barIdx - cooldowns[sym]) < cooldownBars) {
      const prev = sigState[sym] || {};
      sigState[sym] = { ...computeSignalBT(prev, price, calcATR(barWindow[sym]) || null), price };
      continue;
    }
    if (positions.length >= maxPositions) {
      const prev = sigState[sym] || {};
      sigState[sym] = { ...computeSignalBT(prev, price, calcATR(barWindow[sym]) || null), price };
      continue;
    }

    // -- Compute signal and optionally enter --
    // Approximate bar-level vol from the close change ratio
    const prevBar = barWindow[sym]?.[barWindow[sym].length - 2];
    const vol = prevBar ? Math.max(0.005, Math.abs(bar.c - prevBar.c) / prevBar.c) : (sigState[sym]?.vol || 0.02);
    const prev = sigState[sym] || {};
    const atr  = calcATR(barWindow[sym]) || null;
    const sig  = computeSignalBT({ ...prev, vol }, price, atr);
    sigState[sym] = { ...sig, price, vol };

    if (sig.signal === 'BUY' && sig.signalStrength >= minStrength && sig.stopLoss && sig.takeProfit) {
      const available = Math.min(posAmt, cash * 0.20);
      const shares    = Math.max(1, Math.floor(available / price));
      const cost      = f2bt(shares * price);
      if (cost > cash * 0.98) continue; // insufficient cash

      cash -= cost;
      positions.push({
        symbol:     sym,
        entryPrice: price,
        shares,
        stopLoss:   sig.stopLoss,
        takeProfit: sig.takeProfit,
        riskReward: sig.riskReward,
        entryType:  sig.entryType,
        enteredAt:  ts
      });
    }
  }

  // -- Force-close any positions still open at end of data --------------------
  for (const pos of positions) {
    const w      = barWindow[pos.symbol];
    const lb     = w?.[w.length - 1];
    const exitPx = lb?.c ?? pos.entryPrice;
    const exitTs = lb  ? new Date(lb.t).getTime() : Date.now();
    trades.push({
      symbol:   pos.symbol,
      type:     'TIME_EXIT',
      entry:    pos.entryPrice,
      exit:     exitPx,
      profit:   f2bt((exitPx - pos.entryPrice) * pos.shares),
      rr:       pos.riskReward,
      held:     Math.round((exitTs - pos.enteredAt) / 1000) + 's',
      strategy: pos.entryType,
      ts:       exitTs,
      t:        new Date(exitTs).toLocaleTimeString('en-US', { hour12: false })
    });
  }

  // Return newest-first (matches live portfolio.history format)
  return {
    trades:  trades.reverse(),
    summary: {
      symbols:        symbols.length,
      days,
      timeframe,
      initialEquity,
      totalBars:      timeline.length,
      tradesGenerated: trades.length,
      symbolsTraded:  [...new Set(trades.map(t => t.symbol))].length,
      finalCash:      f2bt(cash),
      openAtEnd:      positions.length
    }
  };
}

// GET /api/backtest?days=30&timeframe=5Min&posAmt=2000&maxPositions=8&minStrength=45
// Runs the full backtest and returns trade history + summary.
// Expect 10-30s response time depending on number of symbols and days.
app.get('/api/backtest', async (req, res) => {
  if (!API_KEY) return res.status(401).json({ error: 'No API keys configured' });
  const {
    days          = '30',
    timeframe     = '5Min',
    initialEquity = '100000',
    posAmt        = '2000',
    maxPositions  = '8',
    minStrength   = '45',
    cooldownBars  = '3',
    symbols       = SYMBOLS.join(',')
  } = req.query;

  const symList = symbols.split(',').map(s => s.trim().toUpperCase()).filter(s => SYMBOLS.includes(s));
  if (!symList.length) return res.status(400).json({ error: 'No valid symbols' });

  const t0 = Date.now();
  console.log(`[BT] Request: ${symList.length} symbols, ${days}d, ${timeframe}, minStr=${minStrength}`);
  try {
    const result = await runBacktest({
      symbols:       symList,
      days:          parseInt(days),
      timeframe,
      initialEquity: parseFloat(initialEquity),
      posAmt:        parseFloat(posAmt),
      maxPositions:  parseInt(maxPositions),
      minStrength:   parseFloat(minStrength),
      cooldownBars:  parseInt(cooldownBars)
    });
    const ms = Date.now() - t0;
    console.log(`[BT] Complete: ${result.trades.length} trades in ${ms}ms`);
    res.json({ ...result, timing_ms: ms });
  } catch(e) {
    console.log('[BT] Fatal error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));



const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', ws => {
  const id = cid++;
  clients.set(ws, { id });
  ws.send(JSON.stringify({
    type: 'connected', clientId: id, symbols: SYMBOLS,
    alpacaReady: alpaca.ready, tradeStreamReady: tradeStream.ready,
    paper: true, ts: new Date().toISOString()
  }));
  ws.on('message', raw => {
    try { const m = JSON.parse(raw); if (m.action === 'ping') ws.send(JSON.stringify({ type: 'pong' })); } catch {}
  });
  ws.on('close',  () => clients.delete(ws));
  ws.on('error',  () => clients.delete(ws));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('[TFP] Server running on port', PORT, '(paper trading)');
  loadMeta();          // restore orderMeta from disk before accepting connections
  connectAlpaca();
  connectTradeUpdates();
});
