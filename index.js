"use strict";

const express = require("express");
const http = require("http");
const path = require("path");
const WebSocket = require("ws");
const { WebSocketServer } = require("ws");

// ── Startup validation ──────────────────────────────────────────────────────
// Ensure all necessary environment variables are set for Alpaca API access.
const missing = ["ALPACA_API_KEY", "ALPACA_SECRET_KEY"].filter(
  (k) => !process.env[k] || process.env[k].trim() === "",
);
if (missing.length) {
  console.error("STARTUP FAILED — Missing or empty Replit Secrets:");
  missing.forEach((k) => console.error("  ✗", k));
  console.error("Add them via the Secrets tab (lock icon) in Replit");
  process.exit(1);
}

const API_KEY = process.env.ALPACA_API_KEY;
const API_SECRET = process.env.ALPACA_SECRET_KEY;
const PORT = parseInt(process.env.PORT ?? "3000", 10);

// ── Logger ──────────────────────────────────────────────────────────────────
// Centralized logging utility for consistent output formatting and level control.
const log = {
  info: (...a) => console.log(new Date().toISOString(), "[INFO ]", ...a),
  warn: (...a) => console.log(new Date().toISOString(), "[WARN ]", ...a),
  error: (...a) => console.log(new Date().toISOString(), "[ERROR]", ...a),
  debug: (...a) =>
    process.env.LOG_LEVEL === "DEBUG" &&
    console.log(new Date().toISOString(), "[DEBUG]", ...a),
};

// ── Symbols ─────────────────────────────────────────────────────────────────
// Hardcoded symbols for market data subscription. Consider externalizing this for flexibility.
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
// Manages the WebSocket connection to Alpaca for real-time market data.
const ALPACA_URL = "wss://stream.data.alpaca.markets/v2/iex";
const alpaca = {
  ws: null,
  ready: false,
  reconnMs: 1000,
  reconnTimer: null,
  lastTick: new Map(), // Used for rate-limiting tick broadcasts.
};

/**
 * Establishes and maintains a WebSocket connection to Alpaca.
 * Includes authentication, subscription, and reconnection logic.
 */
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
    } catch (e) {
      log.error("Failed to parse Alpaca message:", e.message, "Raw:", raw);
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
        alpaca.reconnMs = 1000; // Reset reconnection delay on successful connection.
        broadcastSystem("alpaca_connected", { symbols: SYMBOLS });
      } else if (msg.T === "success" && msg.msg === "connected") {
        log.info("Alpaca connected");
      } else if (msg.T === "subscription") {
        log.info("Subscription confirmed");
      } else if (msg.T === "error") {
        log.error("Alpaca error code=" + msg.code + ":", msg.msg);
        if (msg.code === 401 || msg.code === 402) {
          log.error("Auth failed — check API keys in Secrets");
          ws.terminate(); // Terminate connection on authentication failure.
        }
      } else if (msg.T === "t") {
        // Rate-limit tick broadcasts to prevent overwhelming clients.
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
    // Implement exponential backoff for reconnection attempts.
    const delay = alpaca.reconnMs;
    alpaca.reconnTimer = setTimeout(() => {
      alpaca.reconnMs = Math.min(delay * 2, 60000); // Max 1 minute delay.
      connectAlpaca();
    }, delay);
  });

  ws.on("error", (err) => log.error("Alpaca error:", err.message));
}

// ── Client registry ──────────────────────────────────────────────────────────
// Manages connected WebSocket clients and their subscriptions.
const clients = new Map();
let clientId = 1;

/**
 * Broadcasts a market tick to all interested connected clients.
 * @param {object} tick - The market tick data.
 */
function broadcastTick(tick) {
  const p = JSON.stringify(tick);
  clients.forEach((meta, ws) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    // Only send tick if client is subscribed to the symbol or has no specific subscriptions.
    if (meta.symbols.size > 0 && !meta.symbols.has(tick.symbol)) return;
    try {
      ws.send(p);
    } catch (e) {
      log.warn("Failed to send tick to client #" + meta.id + ":", e.message);
      // Consider terminating client if send consistently fails.
    }
  });
}

/**
 * Broadcasts a system message to all connected clients.
 * @param {string} type - The type of system message.
 * @param {object} data - Additional data for the system message.
 */
function broadcastSystem(type, data = {}) {
  const p = JSON.stringify({ type, ...data, ts: new Date().toISOString() });
  clients.forEach((meta, ws) => {
    if (ws.readyState === WebSocket.OPEN)
      try {
        ws.send(p);
      } catch (e) {
        log.warn("Failed to send system message to client #" + meta.id + ":", e.message);
      }
  });
}

// ── Express ──────────────────────────────────────────────────────────────────
// Sets up the Express server for static file serving and API endpoints.
const app = express();
const server = http.createServer(app);

// CORS configuration: Restrict to specific origins in production.
// For development, '*' might be acceptable, but it's a security risk in production.
app.use((req, res, next) => {
  // Example: res.setHeader("Access-Control-Allow-Origin", "https://yourfrontend.com");
  res.setHeader("Access-Control-Allow-Origin", "*"); 
  res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,PUT,PATCH,POST,DELETE");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
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
// Catch-all route for serving the single-page application.
app.get("*", (_, res) =>
  res.sendFile(path.join(__dirname, "public", "index.html")),
);

// ── WebSocket server ─────────────────────────────────────────────────────────
// Handles WebSocket connections from clients.
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws, req) => {
  const id = clientId++;
  // Store client metadata including subscribed symbols and heartbeat status.
  const meta = { id, symbols: new Set(), alive: true };
  clients.set(ws, meta);
  log.info("Client #" + id + " connected (" + clients.size + " total)");

  // Send initial connection details to the client.
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
    } catch (e) {
      log.warn("Client #" + id + " sent malformed JSON:", e.message, "Raw:", raw);
      return;
    }
    // Handle client subscription requests.
    if (msg.action === "subscribe" && Array.isArray(msg.symbols))
      msg.symbols.forEach((s) => meta.symbols.add(s.toUpperCase()));
    // Respond to client pings.
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
// Periodically checks client liveness and terminates unresponsive connections.
setInterval(() => {
  clients.forEach((meta, ws) => {
    if (!meta.alive) {
      log.info("Terminating unresponsive client #" + meta.id);
      clients.delete(ws);
      ws.terminate();
      return;
    }
    meta.alive = false;
    try {
      ws.ping();
    } catch (e) {
      log.warn("Failed to ping client #" + meta.id + ":", e.message);
    }
  });
}, 20000); // 20-second interval for heartbeat.

// ── Graceful shutdown ────────────────────────────────────────────────────────
// Handles process signals for graceful server termination.
function shutdown(sig) {
  log.info(sig + " — shutting down");
  broadcastSystem("server_shutdown", { signal: sig });
  try {
    alpaca.ws?.close();
  } catch (e) {
    log.error("Error closing Alpaca WebSocket:", e.message);
  }
  server.close(() => process.exit(0));
  // Force exit after a timeout to prevent hanging processes.
  setTimeout(() => {
    log.error("Server did not shut down gracefully within 5 seconds. Forcing exit.");
    process.exit(1);
  }, 5000);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (r) => log.error("Unhandled Rejection:", r));
process.on("uncaughtException", (e) => log.error("Uncaught Exception:", e)); // Catch uncaught exceptions.

// ── Start ────────────────────────────────────────────────────────────────────
// Initializes the server and connects to Alpaca.
server.listen(PORT, () => {
  log.info("════════════════════════════════════");
  log.info("  TREND_FOLLOWER_PRO  Backend v2");
  log.info("  http://localhost:" + PORT);
  log.info("  ws://localhost:" + PORT + "/ws");
  log.info("════════════════════════════════════");
  connectAlpaca();
});
