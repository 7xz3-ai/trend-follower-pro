const express = require('express');
const http = require('http');
const https = require('https');
const path = require('path');
const WebSocket = require('ws');
const { WebSocketServer } = require('ws');

const API_KEY    = process.env.ALPACA_API_KEY    || '';
const API_SECRET = process.env.ALPACA_SECRET_KEY || '';
const PORT       = parseInt(process.env.PORT || '3000', 10);

const SYMBOLS = [
  'NVDA','TSLA','AAPL','MSFT','AMZN','META','GOOGL',
  'AMD','SMCI','MSTR','SOXL',
  'SPY','QQQ','TQQQ',
  'PLTR','NFLX','COIN','MARA','SOFI','RIVN'
];

const alpaca = { ws:null, ready:false, reconnMs:1000, timer:null, lastTick:new Map() };

function connectAlpaca() {
  if (alpaca.timer) { clearTimeout(alpaca.timer); alpaca.timer = null; }
  if (!API_KEY || !API_SECRET) { console.log('No Alpaca keys — live data disabled'); return; }
  console.log('Connecting to Alpaca...');
  const ws = new WebSocket('wss://stream.data.alpaca.markets/v2/iex');
  alpaca.ws = ws;
  ws.on('open', () => {
    console.log('Alpaca open — authenticating');
    ws.send(JSON.stringify({ action:'auth', key:API_KEY, secret:API_SECRET }));
  });
  ws.on('message', (raw) => {
    let msgs;
    try { msgs = JSON.parse(raw); if (!Array.isArray(msgs)) msgs = [msgs]; } catch(e) { return; }
    msgs.forEach(msg => {
      if (msg.T === 'success' && msg.msg === 'authenticated') {
        console.log('Alpaca authenticated — subscribing to', SYMBOLS.length, 'symbols');
        ws.send(JSON.stringify({ action:'subscribe', trades:SYMBOLS, quotes:[], bars:[] }));
        alpaca.ready = true; alpaca.reconnMs = 1000;
        broadcast({ type:'alpaca_connected', symbols:SYMBOLS });
      }
      if (msg.T === 'subscription') console.log('Subscription confirmed');
      if (msg.T === 'error') console.log('Alpaca error:', msg.code, msg.msg);
      if (msg.T === 't') {
        const now = Date.now();
        if (now - (alpaca.lastTick.get(msg.S) || 0) < 50) return;
        alpaca.lastTick.set(msg.S, now);
        broadcast({ type:'tick', symbol:msg.S, price:msg.p, size:msg.s, timestamp:msg.t });
      }
    });
  });
  ws.on('close', (code) => {
    alpaca.ready = false;
    const delay = alpaca.reconnMs;
    alpaca.timer = setTimeout(() => { alpaca.reconnMs = Math.min(delay*2,60000); connectAlpaca(); }, delay);
  });
  ws.on('error', (err) => console.log('Alpaca WS error:', err.message));
}

const clients = new Map();
let cid = 1;

function broadcast(data) {
  const p = JSON.stringify(data);
  clients.forEach((meta, ws) => {
    if (ws.readyState === WebSocket.OPEN) try { ws.send(p); } catch(e) {}
  });
}

const app = express();
const server = http.createServer(app);

app.use((req, res, next) => { res.setHeader('Access-Control-Allow-Origin', '*'); next(); });
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.json({ ok:true }));
app.get('/status', (req, res) => res.json({ alpaca:alpaca.ready, clients:clients.size }));

// Historical bars proxy
app.get('/api/bars/:symbol', (req, res) => {
  const { symbol } = req.params;
  const { timeframe = '5Min', limit = '300', start, end } = req.query;
  if (!API_KEY || !API_SECRET) return res.status(401).json({ error:'No API keys' });
  let apiPath = '/v2/stocks/' + encodeURIComponent(symbol) + '/bars?timeframe=' + timeframe + '&limit=' + limit + '&adjustment=raw&feed=iex';
  if (start) apiPath += '&start=' + encodeURIComponent(start);
  if (end)   apiPath += '&end='   + encodeURIComponent(end);
  const options = {
    hostname: 'data.alpaca.markets', path: apiPath, method: 'GET',
    headers: { 'APCA-API-KEY-ID': API_KEY, 'APCA-API-SECRET-KEY': API_SECRET, 'Accept': 'application/json' }
  };
  const request = https.request(options, (response) => {
    let data = '';
    response.on('data', chunk => { data += chunk; });
    response.on('end', () => { try { res.json(JSON.parse(data)); } catch(e) { res.status(500).json({ error:'Parse error' }); } });
  });
  request.on('error', (e) => res.status(500).json({ error: e.message }));
  request.setTimeout(15000, () => { request.destroy(); res.status(408).json({ error:'Timeout' }); });
  request.end();
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const wss = new WebSocketServer({ server, path:'/ws' });
wss.on('connection', (ws) => {
  const id = cid++;
  clients.set(ws, { id });
  ws.send(JSON.stringify({ type:'connected', clientId:id, symbols:SYMBOLS, alpacaReady:alpaca.ready, ts:new Date().toISOString() }));
  ws.on('message', (raw) => { try { const msg = JSON.parse(raw); if (msg.action === 'ping') ws.send(JSON.stringify({ type:'pong' })); } catch(e) {} });
  ws.on('close', () => { clients.delete(ws); });
  ws.on('error', () => clients.delete(ws));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('TREND_FOLLOWER_PRO running on port', PORT);
  connectAlpaca();
});
