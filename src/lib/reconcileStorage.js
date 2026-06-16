/* ============================================================
   Reconcile localStorage helpers. Split out from src/screens/Reconcile.jsx
   (PR-1 of the analyze-unification work) so Library / Dashboard can write
   to these keys without importing the soon-to-be-deleted screen module.
   ============================================================ */

export const RECON_HISTORY_KEY = 'lex.recon.history';
export const RECON_OPEN_KEY = 'lex.recon.open';

/** Pop the id of a reconcile run the user clicked in Library/Dashboard. The
 *  consumer (analyze screen) then fetches the full run via
 *  api.reconciliations.get(id). One-shot — removed after the read. */
export function popReconOpenId() {
  if (typeof localStorage === 'undefined') return null;
  const raw = localStorage.getItem(RECON_OPEN_KEY);
  if (!raw) return null;
  try { localStorage.removeItem(RECON_OPEN_KEY); } catch (_e) {}
  return raw;
}

/** Library fallback when the backend list is empty / unreachable. Last 20
 *  runs persist client-side so a refresh after an offline analyze still
 *  surfaces the row. */
export function loadHistory() {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(RECON_HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (_e) { return []; }
}

export function saveHistory(run) {
  if (typeof localStorage === 'undefined' || !run || !run.id) return;
  const prev = loadHistory().filter((r) => r.id !== run.id);
  const next = [run, ...prev].slice(0, 20);
  try { localStorage.setItem(RECON_HISTORY_KEY, JSON.stringify(next)); } catch (_e) {}
}
