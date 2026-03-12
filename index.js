'use strict';
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

// orderId -> {symbol, qty, sl, tp, entryPrice, isAuto, enteredAt}
// Child leg IDs (stop_loss/take_profit) also stored so closing fills are enriched.
const orderMeta = new Map();

function storeOrderMeta(order, sl, tp, qty, isAuto) {
  const meta = { symbol: order.symbol, qty, sl, tp, entryPrice: null, isAuto: !!isAuto, enteredAt: Date.now() };
  orderMeta.set(order.id, meta);
  if (Array.isArray(order.legs)) {
    order.legs.forEach(leg => orderMeta.set(leg.id, { ...meta, parentId: order.id, legType: leg.type }));
  }
  setTimeout(() => orderMeta.delete(order.id), 86400000);
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
        let parsed;
        try { parsed = JSON.parse(raw); } catch { return reject(new Error('JSON parse error')); }
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
    alpaca.timer = setTimeout(() => { alpaca.reconnMs = Math.min(d * 2, 60000); connectAlpaca(); }, d);
  });
  ws.on('error', err => console.log('[DATA] Error:', err.message));
}

// Trade updates stream - fires when SL/TP hit or orders fill on Alpaca's side
const tradeStream = { ws: null, ready: false, reconnMs: 1000, timer: null };
function connectTradeUpdates() {
  if (tradeStream.timer) { clearTimeout(tradeStream.timer); tradeStream.timer = null; }
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
        setTimeout(() => orderMeta.delete(order.id), 120000);
      }
    }
  });
  ws.on('close', () => {
    tradeStream.ready = false;
    const d = tradeStream.reconnMs;
    tradeStream.timer = setTimeout(() => { tradeStream.reconnMs = Math.min(d * 2, 30000); connectTradeUpdates(); }, d);
  });
  ws.on('error', err => console.log('[TRADE] WS error:', err.message));
}

const app    = express();
const server = http.createServer(app);

app.use(express.json());
app.use((_, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});
app.options('*', (_, res) => res.sendStatus(204));
app.use(express.static(path.join(__dirname, 'public')));

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

// Close a position by submitting market sell via Alpaca
app.delete('/api/position/:symbol', async (req, res) => {
  if (!API_KEY) return res.status(401).json({ error: 'No Alpaca API keys configured' });
  const { symbol } = req.params;
  try {
    const result = await broker('DELETE', `/v2/positions/${encodeURIComponent(symbol)}`);
    console.log('[CLOSE]', symbol, 'close order submitted');
    res.json({ success: true, symbol, order_id: result.id });
  } catch(e) {
    res.status(e.status || 500).json({ error: e.message, symbol });
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
  connectAlpaca();
  connectTradeUpdates();
});
