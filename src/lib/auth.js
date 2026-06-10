/* ============================================================
   AG Lex — session helpers backed by the FastAPI auth API.
   Phase 2.1: replaces the localStorage-only demo with real
   register / login / me calls against /api/auth/*.

   Caller surface preserved for App.jsx + Auth.jsx:
     - lxLoadSession()           sync, returns cached user or null
     - lxLogout()                clears local cache (no server roundtrip)
     - LX_TEST                   test-account constants (for the demo button)
     - initialsOf(name), hueOf(str)   pure UI helpers
   Plus new async API:
     - apiRegister({name,email,password,role}) → user
     - apiLogin({email,password})              → user
     - apiLoginTest()                          → user (uses LX_TEST creds)
     - getToken()                              → JWT string or null
     - authHeaders()                           → { Authorization: 'Bearer …' } | {}
   ============================================================ */

const SESSION_KEY = 'aglex_session_v2';

// JWT TTL is 24h per backend config; we also clear locally on any 401.
function readSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.token || !parsed.user) return null;
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

// Constants surface kept for screens/Auth.jsx (the test-login affordance).
export const LX_TEST = {
  name: 'Тестовий Користувач',
  email: 'test@aglex.ua',
  pass: 'test1234',
  role: 'partner',
};

export async function apiLoginTest() {
  return apiLogin({ email: LX_TEST.email, password: LX_TEST.pass });
}

// Optional: refresh the cached user from /api/auth/me. Clears the session if
// the token is no longer valid. App.jsx doesn't need to call this for MVP;
// kept exported so screens that hit the API can revalidate cheaply.
export async function refreshSession() {
  const token = getToken();
  if (!token) return null;
  const r = await fetch('/api/auth/me', { headers: authHeaders() });
  if (r.status === 401) { clearSession(); return null; }
  if (!r.ok) return readSession()?.user || null;
  const user = await r.json();
  const s = readSession();
  if (s) writeSession(s.token, user);
  return user;
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
