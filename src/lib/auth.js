/* ============================================================
   AG Lex — session helpers backed by the FastAPI auth API.

   Surface:
     - lxLoadSession()           sync, returns cached user or null
     - lxLogout()                clears local cache (no server roundtrip)
     - apiRegister({name,email,password,role}) → user
     - apiLogin({email,password})              → user
     - refreshSession()                        → user from /api/auth/me
     - getToken() / authHeaders()              → JWT helpers
     - initialsOf(name), hueOf(str)            → pure UI helpers
   ============================================================ */

const SESSION_KEY = 'aglex_session_v2';

// Event name fired whenever the cached session is cleared. App.jsx listens so
// it can reset its React `user` state — without this, lxLogout() from a 401
// handler leaves the UI rendering the protected app while every subsequent
// request fails with "Missing bearer token".
export const AUTH_LOGOUT_EVENT = 'aglex:auth:logout';

// JWT TTL is 24h per backend config; we also clear locally on any 401.
function readSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.token || !parsed.user) return null;
    if (isJwtExpired(parsed.token)) return null;
    return parsed;
  } catch (e) {
    return null;
  }
}

function writeSession(token, user) {
  localStorage.setItem(SESSION_KEY, JSON.stringify({ token, user }));
}

function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}

function emitLogout() {
  if (typeof window === 'undefined') return;
  try { window.dispatchEvent(new CustomEvent(AUTH_LOGOUT_EVENT)); } catch (_e) { /* noop */ }
}

// Best-effort client-side JWT expiry check. Decodes the payload's `exp` claim
// without verifying the signature — server is still authoritative. Used so a
// stale token cached in localStorage doesn't pretend the user is logged in.
function isJwtExpired(token) {
  if (typeof token !== 'string') return true;
  const parts = token.split('.');
  if (parts.length !== 3) return false; // unknown shape — let the server decide
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
    const json = JSON.parse(atob(b64 + pad));
    if (typeof json.exp !== 'number') return false;
    // 30s skew so a token that just expired doesn't bounce mid-request.
    return json.exp * 1000 <= Date.now() - 30_000;
  } catch (_e) {
    return false; // can't decode → defer to the server
  }
}

export function getToken() {
  const s = readSession();
  return s ? s.token : null;
}

export function authHeaders() {
  const t = getToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

export function lxLoadSession() {
  const s = readSession();
  return s ? s.user : null;
}

export function lxLogout() {
  clearSession();
}

// Same effect as lxLogout() but also notifies the app that the session was
// dropped *unexpectedly* (token expired, 401 from a protected endpoint, …).
// App.jsx listens on AUTH_LOGOUT_EVENT and resets React state so the user
// lands on /auth instead of staring at a broken protected screen.
export function lxSessionExpired() {
  const had = (typeof localStorage !== 'undefined') && localStorage.getItem(SESSION_KEY) != null;
  clearSession();
  if (had) emitLogout();
}

async function postJSON(path, body) {
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let data = null;
  try { data = await r.json(); } catch (e) { /* non-JSON error */ }
  if (!r.ok) {
    const msg =
      (data && typeof data.detail === 'string' && data.detail) ||
      (data && Array.isArray(data.detail) && data.detail[0] && data.detail[0].msg) ||
      `${r.status} ${r.statusText}`;
    const err = new Error(msg);
    err.status = r.status;
    throw err;
  }
  return data;
}

export async function apiRegister({ name, email, password, role }) {
  const data = await postJSON('/api/auth/register', { name, email, password, role });
  writeSession(data.access_token, data.user);
  return data.user;
}

export async function apiLogin({ email, password }) {
  const data = await postJSON('/api/auth/login', { email, password });
  writeSession(data.access_token, data.user);
  return data.user;
}

// Rolling refresh: hit POST /api/auth/refresh to get a fresh JWT for the
// current user and overwrite the cached one. Called on every App.jsx mount
// (and opportunistically when the token is older than half its TTL) so the
// cached token's `exp` keeps moving forward — the session effectively never
// expires as long as the user keeps opening the app.
export async function refreshSession() {
  const token = getToken();
  if (!token) return null;
  let r;
  try {
    r = await fetch('/api/auth/refresh', { method: 'POST', headers: authHeaders() });
  } catch (_e) {
    // Network error — keep the existing cached session.
    return readSession()?.user || null;
  }
  if (r.status === 401) { clearSession(); return null; }
  if (!r.ok) return readSession()?.user || null;
  try {
    const data = await r.json();
    if (data && data.access_token && data.user) {
      writeSession(data.access_token, data.user);
      return data.user;
    }
  } catch (_e) { /* non-JSON — fall through */ }
  return readSession()?.user || null;
}

// ---- pure UI helpers (no auth state, just kept here to preserve imports) ----

export function initialsOf(name) {
  const p = (name || '').trim().split(/\s+/);
  return (((p[0] || '')[0] || '') + ((p[1] || '')[0] || '')).toUpperCase() || '?';
}

export function hueOf(str) {
  let h = 0;
  for (let i = 0; i < (str || '').length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
  return h;
}
