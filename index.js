"use strict";

const express = require("express");
const http = require("http");
const path = require("path");
const WebSocket = require("ws");
const { WebSocketServer } = require("ws");

// ── Startup validation ──────────────────────────────────────────────────────
const missing = ["ALPACA_API_KEY", "ALPACA_SECRET_KEY"].filter(
  (k) => !process.env[k],
);
if (missing.length) {
  console.error("STARTUP FAILED — Missing Replit Secrets:");
  missing.forEach((k) => console.error("  ✗", k));
  console.error("Add them via the Secrets tab (lock icon) in Replit");
  process.exit(1);
}

const API_KEY = process.env.ALPACA_API_KEY;
const API_SECRET = process.env.ALPACA_SECRET_KEY;
const PORT = parseInt(process.env.PORT ?? "3000", 10);

// ── Logger ──────────────────────────────────────────────────────────────────
const log = {
  info: (...a) => console.log(new Date().toISOString(), "[INFO ]", ...a),
  warn: (...a) => console.log(new Date().toISOString(), "[WARN ]", ...a),
  error: (...a) => console.log(new Date().toISOString(), "[ERROR]", ...a),
  debug: (...a) =>
    process.env.LOG_LEVEL === "DEBUG" &&
    console.log(new Date().toISOString(), "[DEBUG]", ...a),
};

// ── Symbols ─────────────────────────────────────────────────────────────────
const SYMBOLS = [
  "NVDA",
  "TSLA",
  "AAPL",
  "MSFT",
  "AMZN",
  "META",
  "GOOGL",
  "AMD",
  "SMCI",
  "MSTR",
  "SOXL",
  "SPY",
  "QQQ",
  "TQQQ",
  "PLTR",
  "NFLX",
  "COIN",
  "MARA",
  "SOFI",
  "RIVN",
];

// ── Alpaca stream ────────────────────────────────────────────────────────────
const ALPACA_URL = "wss://stream.data.alpaca.markets/v2/iex";
const alpaca = {
  ws: null,
  ready: false,
  reconnMs: 1000,
  reconnTimer: null,
  lastTick: new Map(),
};

function connectAlpaca() {
  if (alpaca.reconnTimer) {
    clearTimeout(alpaca.reconnTimer);
    alpaca.reconnTimer = null;
  }
  log.info("Connecting to Alpaca IEX:", ALPACA_URL);
  const ws = new WebSocket(ALPACA_URL);
  alpaca.ws = ws;
  alpaca.ready = false;

  ws.on("open", () => {
    log.info("Alpaca socket open — authenticating");
    ws.send(
      JSON.stringify({ action: "auth", key: API_KEY, secret: API_SECRET }),
    );
  });

  ws.on("message", (raw) => {
    let msgs;
    try {
      msgs = JSON.parse(raw);
      if (!Array.isArray(msgs)) msgs = [msgs];
    } catch {
      return;
    }
    msgs.forEach((msg) => {
      if (msg.T === "success" && msg.msg === "authenticated") {
        log.info(
          "Alpaca authenticated — subscribing to",
          SYMBOLS.length,
          "symbols",
        );
        ws.send(
          JSON.stringify({
            action: "subscribe",
            trades: SYMBOLS,
            quotes: [],
            bars: [],
          }),
        );
        alpaca.ready = true;
        alpaca.reconnMs = 1000;
        broadcastSystem("alpaca_connected", { symbols: SYMBOLS });
      } else if (msg.T === "success" && msg.msg === "connected") {
        log.info("Alpaca connected");
      } else if (msg.T === "subscription") {
        log.info("Subscription confirmed");
      } else if (msg.T === "error") {
        log.error("Alpaca error code=" + msg.code + ":", msg.msg);
        if (msg.code === 401 || msg.code === 402) {
          log.error("Auth failed — check API keys in Secrets");
          ws.terminate();
        }
      } else if (msg.T === "t") {
        const now = Date.now();
        if (now - (alpaca.lastTick.get(msg.S) || 0) < 50) return;
        alpaca.lastTick.set(msg.S, now);
        broadcastTick({
          type: "tick",
          symbol: msg.S,
          price: msg.p,
          size: msg.s,
          timestamp: msg.t,
        });
      }
    });
  });

  ws.on("close", (code) => {
    alpaca.ready = false;
    log.warn("Alpaca closed code=" + code);
    broadcastSystem("alpaca_disconnected", { code });
    const delay = alpaca.reconnMs;
    alpaca.reconnTimer = setTimeout(() => {
      alpaca.reconnMs = Math.min(delay * 2, 60000);
      connectAlpaca();
    }, delay);
  });

  ws.on("error", (err) => log.error("Alpaca error:", err.message));
}

// ── Client registry ──────────────────────────────────────────────────────────
const clients = new Map();
let clientId = 1;

function broadcastTick(tick) {
  const p = JSON.stringify(tick);
  clients.forEach((meta, ws) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (meta.symbols.size > 0 && !meta.symbols.has(tick.symbol)) return;
    try {
      ws.send(p);
    } catch (_) {}
  });
}

function broadcastSystem(type, data = {}) {
  const p = JSON.stringify({ type, ...data, ts: new Date().toISOString() });
  clients.forEach((_, ws) => {
    if (ws.readyState === WebSocket.OPEN)
      try {
        ws.send(p);
      } catch (_) {}
  });
}

// ── Express ──────────────────────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (_, res) =>
  res.json({ ok: true, ts: new Date().toISOString() }),
);
app.get("/status", (_, res) =>
  res.json({
    alpaca: { ready: alpaca.ready, symbols: SYMBOLS },
    clients: { count: clients.size },
    uptime: process.uptime().toFixed(0) + "s",
  }),
);
app.get("/symbols", (_, res) => res.json({ symbols: SYMBOLS }));
app.get("*", (_, res) =>
  res.sendFile(path.join(__dirname, "public", "index.html")),
);

// ── WebSocket server ─────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws, req) => {
  const id = clientId++;
  const meta = { id, symbols: new Set(), alive: true };
  clients.set(ws, meta);
  log.info("Client #" + id + " connected (" + clients.size + " total)");

  ws.send(
    JSON.stringify({
      type: "connected",
      clientId: id,
      symbols: SYMBOLS,
      alpacaReady: alpaca.ready,
      ts: new Date().toISOString(),
    }),
  );

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.action === "subscribe" && Array.isArray(msg.symbols))
      msg.symbols.forEach((s) => meta.symbols.add(s.toUpperCase()));
    if (msg.action === "ping")
      ws.send(JSON.stringify({ type: "pong", ts: Date.now() }));
  });

  ws.on("pong", () => {
    meta.alive = true;
  });
  ws.on("close", () => {
    clients.delete(ws);
    log.info("Client #" + id + " disconnected");
  });
  ws.on("error", (err) => log.warn("Client #" + id + " error:", err.message));
});

// ── Heartbeat ────────────────────────────────────────────────────────────────
setInterval(() => {
  clients.forEach((meta, ws) => {
    if (!meta.alive) {
      clients.delete(ws);
      ws.terminate();
      return;
    }
    meta.alive = false;
    try {
      ws.ping();
    } catch (_) {}
  });
}, 20000);

// ── Graceful shutdown ────────────────────────────────────────────────────────
function shutdown(sig) {
  log.info(sig + " — shutting down");
  broadcastSystem("server_shutdown", { signal: sig });
  try {
    alpaca.ws?.close();
  } catch (_) {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (r) => log.error("Unhandled:", r));

// ── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  log.info("════════════════════════════════════");
  log.info("  TREND_FOLLOWER_PRO  Backend v2");
  log.info("  http://localhost:" + PORT);
  log.info("  ws://localhost:" + PORT + "/ws");
  log.info("════════════════════════════════════");
  connectAlpaca();
});
