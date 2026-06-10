/* ============================================================
   AG Lex — fetch helper for /api/*.
   Phase 2.2: workspace entities live behind /api/<entity> and
   require the Bearer token from auth.js.
   ============================================================ */
import { authHeaders, lxLogout } from './auth';

class ApiError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

async function request(path, { method = 'GET', body, signal } = {}) {
  const opts = {
    method,
    headers: { ...authHeaders() },
    signal,
  };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const r = await fetch(path, opts);

  // A stale token invalidates the local session. Caller can decide whether
  // to redirect to /auth; we just clear so the next render reflects reality.
  if (r.status === 401) lxLogout();

  let payload = null;
  if (r.status !== 204) {
    try { payload = await r.json(); } catch (_e) { /* non-JSON */ }
  }

  if (!r.ok) {
    const msg =
      (payload && typeof payload.detail === 'string' && payload.detail) ||
      (payload && Array.isArray(payload.detail) && payload.detail[0]?.msg) ||
      `${r.status} ${r.statusText}`;
    throw new ApiError(msg, { status: r.status, body: payload });
  }
  return payload;
}

function entity(slug) {
  const base = `/api/${slug}`;
  return {
    list: (opts) => request(base, opts),
    get: (id, opts) => request(`${base}/${encodeURIComponent(id)}`, opts),
    create: (data, opts) => request(base, { ...opts, method: 'POST', body: data }),
    update: (id, data, opts) => request(`${base}/${encodeURIComponent(id)}`, { ...opts, method: 'PATCH', body: data }),
    remove: (id, opts) => request(`${base}/${encodeURIComponent(id)}`, { ...opts, method: 'DELETE' }),
  };
}

async function multipart(path, formData) {
  // Plain fetch — we deliberately omit Content-Type so the browser sets the
  // multipart boundary itself. Same error/401 handling as request().
  const r = await fetch(path, {
    method: 'POST',
    headers: { ...authHeaders() },
    body: formData,
  });
  if (r.status === 401) lxLogout();
  let payload = null;
  if (r.status !== 204) {
    try { payload = await r.json(); } catch (_e) { /* non-JSON */ }
  }
  if (!r.ok) {
    const msg =
      (payload && typeof payload.detail === 'string' && payload.detail) ||
      (payload && Array.isArray(payload.detail) && payload.detail[0]?.msg) ||
      `${r.status} ${r.statusText}`;
    throw new ApiError(msg, { status: r.status, body: payload });
  }
  return payload;
}

export const api = {
  request,
  matters: entity('matters'),
  tasks: entity('tasks'),
  clients: entity('clients'),
  templates: entity('templates'),
  invoices: entity('invoices'),
  timeEntries: entity('time-entries'),
  clauseLib: entity('clause-lib'),
  laws: entity('laws'),
  comments: entity('comments'),
  approval: entity('approval'),
  deadlines: entity('deadlines'),
  obligations: entity('obligations'),
  versions: entity('versions'),
  reconciliations: entity('reconciliations'),
  reconcile: (formData) => multipart('/api/reconcile', formData),
};

export { ApiError };
