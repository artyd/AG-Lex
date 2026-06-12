/* ============================================================
   AG Lex — WebSocket realtime client.
   Singleton connection to /ws with JWT in the query string, with
   exponential-backoff auto-reconnect and a tiny event bus.

   Subscribers register by event type (e.g. "case.updated") and
   optionally filter by case_id. On reconnect we emit a synthetic
   "realtime:reconnected" event so views can refetch and close the
   gap of any missed broadcasts.
   ============================================================ */
import { getToken, lxLogout } from './auth';

const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000];
const HEARTBEAT_MS = 25000;

// ---- event bus -----------------------------------------------------------

class EventBus {
  constructor() {
    this._handlers = new Map(); // type → Set<handler>
  }
  on(type, handler) {
    if (!this._handlers.has(type)) this._handlers.set(type, new Set());
    this._handlers.get(type).add(handler);
    return () => this.off(type, handler);
  }
  off(type, handler) {
    const set = this._handlers.get(type);
    if (set) set.delete(handler);
  }
  emit(type, payload) {
    const set = this._handlers.get(type);
    if (!set || set.size === 0) return;
    // Snapshot — handlers may unsubscribe mid-iteration.
    for (const h of [...set]) {
      try { h(payload); } catch (e) { console.error('realtime handler error', e); }
    }
  }
}

// ---- connection state ----------------------------------------------------

let ws = null;
let reconnectAttempt = 0;
let reconnectTimer = null;
let heartbeatTimer = null;
let intentionallyClosed = false;
let isConnected = false;
const bus = new EventBus();

function wsUrl() {
  const token = getToken();
  if (!token) return null;
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  // Same origin as the HTTP API (vite proxy forwards /ws → backend in dev).
  return `${proto}//${window.location.host}/ws?token=${encodeURIComponent(token)}`;
}

function scheduleReconnect() {
  if (intentionallyClosed) return;
  const delay = RECONNECT_DELAYS[Math.min(reconnectAttempt, RECONNECT_DELAYS.length - 1)];
  reconnectAttempt += 1;
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    try {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping' }));
      }
    } catch (_e) { /* ignore */ }
  }, HEARTBEAT_MS);
}

function stopHeartbeat() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
}

function handleMessage(raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch (_e) { return; }
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'pong') return;
  if (msg.type) bus.emit(msg.type, msg);
}

export function connect() {
  if (typeof window === 'undefined') return; // SSR guard
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }
  const url = wsUrl();
  if (!url) return; // no token yet — caller will retry on next mount

  intentionallyClosed = false;
  try {
    ws = new WebSocket(url);
  } catch (_e) {
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    const wasReconnect = reconnectAttempt > 0;
    reconnectAttempt = 0;
    isConnected = true;
    startHeartbeat();
    bus.emit('realtime:connected', { reconnected: wasReconnect });
    if (wasReconnect) {
      // Tell subscribers to refetch — they missed events while we were
      // offline. Server doesn't replay; we close the gap on the client.
      bus.emit('realtime:reconnected', {});
    }
  };

  ws.onmessage = (ev) => handleMessage(ev.data);

  ws.onclose = (ev) => {
    isConnected = false;
    stopHeartbeat();
    ws = null;
    // 1008 = JWT rejected (see backend WS endpoint). Don't churn the
    // reconnect loop against a permanently invalid token.
    if (ev.code === 1008) {
      lxLogout();
      return;
    }
    if (!intentionallyClosed) scheduleReconnect();
  };

  ws.onerror = () => {
    // The 'close' handler will fire too — let it own the reconnect logic.
  };
}

export function disconnect() {
  intentionallyClosed = true;
  reconnectAttempt = 0;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  stopHeartbeat();
  if (ws) {
    try { ws.close(1000, 'client-disconnect'); } catch (_e) { /* ignore */ }
    ws = null;
  }
  isConnected = false;
}

/**
 * Subscribe to an event type. Optionally pass a `filter` function that
 * receives the event payload and returns true if it should be delivered.
 * Returns an unsubscribe function.
 */
export function subscribe(type, handler, { filter } = {}) {
  const wrapped = filter
    ? (payload) => { if (filter(payload)) handler(payload); }
    : handler;
  return bus.on(type, wrapped);
}

/** True when the socket is currently OPEN. */
export function connected() { return isConnected; }
