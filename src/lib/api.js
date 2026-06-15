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

// Matters: hybrid of the generic CRUD helpers (list/get/create/update/remove)
// plus Phase 2.4 child + member endpoints. `get(id)` returns the hydrated
// case (members, parties, notes, hearings, timeline); `list()` returns the
// trimmed card shape scoped to the current user's case_members.
const _matters = entity('matters');
const matters = {
  ..._matters,
  addMember: (caseId, body) =>
    request(`/api/matters/${encodeURIComponent(caseId)}/members`, { method: 'POST', body }),
  removeMember: (caseId, userTextId) =>
    request(`/api/matters/${encodeURIComponent(caseId)}/members/${encodeURIComponent(userTextId)}`, { method: 'DELETE' }),
  addTask: (caseId, body) =>
    request(`/api/matters/${encodeURIComponent(caseId)}/tasks`, { method: 'POST', body }),
  addHearing: (caseId, body) =>
    request(`/api/matters/${encodeURIComponent(caseId)}/hearings`, { method: 'POST', body }),
  addNote: (caseId, body) =>
    request(`/api/matters/${encodeURIComponent(caseId)}/notes`, { method: 'POST', body }),
  addParty: (caseId, body) =>
    request(`/api/matters/${encodeURIComponent(caseId)}/parties`, { method: 'POST', body }),
  addTimeEntry: (caseId, body) =>
    request(`/api/matters/${encodeURIComponent(caseId)}/time-entries`, { method: 'POST', body }),
};

const notifications = {
  list: ({ unread = 0, limit = 50 } = {}) =>
    request(`/api/notifications?unread=${unread ? 1 : 0}&limit=${limit}`),
  markRead: (id) => request(`/api/notifications/${encodeURIComponent(id)}/read`, { method: 'POST' }),
  markAllRead: () => request('/api/notifications/read-all', { method: 'POST' }),
};

const calendar = {
  events: ({ from, to, onlyMine = false } = {}) => {
    const qs = new URLSearchParams();
    if (from) qs.set('from_', from);
    if (to) qs.set('to', to);
    if (onlyMine) qs.set('only_mine', '1');
    const s = qs.toString();
    return request(`/api/calendar/events${s ? '?' + s : ''}`);
  },
};

const team = {
  members: () => request('/api/team/members'),
};

// Single-document pipeline (Phase 3.1 — see legal_app/backend/main.py).
// `upload` turns a real PDF/DOCX into markdown + section list + token-stats.
// `analyzeContract` then turns the markdown (or sections) into the findings /
// comparison / legal_basis / score structure ContractAnalysis already renders.
function upload(file) {
  const fd = new FormData();
  fd.append('file', file);
  return multipart('/api/upload', fd);
}
function analyzeContract({ markdown, sections } = {}) {
  return request('/api/analyze/contract', { method: 'POST', body: { markdown, sections } });
}

export const api = {
  request,
  matters,
  notifications,
  calendar,
  team,
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
  contracts: entity('contracts'),
  reconcile: (formData) => multipart('/api/reconcile', formData),
  upload,
  analyzeContract,
};

export { ApiError };
