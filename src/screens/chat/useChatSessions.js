/* ============================================================
   useChatSessions — data layer for the AI Lawyer chat history.

   Owns the sidebar list, active session id (with localStorage
   persistence + stale-id fallback), collapse state, and the
   optimistic CRUD that keeps the sidebar snappy.
   ============================================================ */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';

const ACTIVE_KEY = 'aglex_chat_active_session';
const COLLAPSED_KEY = 'aglex_chat_sidebar_collapsed';

function readLocalActive() {
  try { return localStorage.getItem(ACTIVE_KEY) || null; } catch { return null; }
}
function writeLocalActive(id) {
  try {
    if (id) localStorage.setItem(ACTIVE_KEY, id);
    else localStorage.removeItem(ACTIVE_KEY);
  } catch { /* private mode — fine */ }
}
function readLocalCollapsed() {
  try { return localStorage.getItem(COLLAPSED_KEY) === '1'; } catch { return false; }
}
function writeLocalCollapsed(v) {
  try { localStorage.setItem(COLLAPSED_KEY, v ? '1' : '0'); } catch { /* fine */ }
}

export function useChatSessions() {
  const [sessions, setSessions] = useState([]);
  const [activeId, setActiveId] = useState(() => readLocalActive());
  const [collapsed, setCollapsed] = useState(() => readLocalCollapsed());
  const [loading, setLoading] = useState(true);

  // On mount: fetch the list, then reconcile the persisted activeId. If the
  // stored id no longer exists (deleted on another device, server reseeded,
  // etc.) silently fall back to the most-recent session — no toast, the user
  // didn't do anything wrong.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.chat.sessions.list()
      .then(list => {
        if (cancelled) return;
        const rows = Array.isArray(list) ? list : [];
        setSessions(rows);
        const persisted = readLocalActive();
        const stillExists = persisted && rows.some(s => s.id === persisted);
        if (stillExists) {
          setActiveId(persisted);
        } else {
          const fallback = rows[0]?.id || null;
          setActiveId(fallback);
          writeLocalActive(fallback);
        }
      })
      .catch(() => { if (!cancelled) setSessions([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const selectSession = useCallback((id) => {
    setActiveId(id);
    writeLocalActive(id);
  }, []);

  const createSession = useCallback(async () => {
    // Optimistic: insert a temp row so the user sees something immediately,
    // then swap with the server response.
    const tempId = 'tmp-' + Date.now();
    const stub = { id: tempId, title: 'Новий чат', updated_at: new Date().toISOString() };
    setSessions(s => [stub, ...s]);
    setActiveId(tempId);
    try {
      const created = await api.chat.sessions.create();
      const row = {
        id: created.id, title: created.title,
        updated_at: new Date().toISOString(),
      };
      setSessions(s => [row, ...s.filter(x => x.id !== tempId)]);
      setActiveId(created.id);
      writeLocalActive(created.id);
      return created.id;
    } catch (e) {
      // Rollback optimistic row + bubble so the caller can surface a toast.
      setSessions(s => s.filter(x => x.id !== tempId));
      setActiveId((cur) => (cur === tempId ? null : cur));
      throw e;
    }
  }, []);

  const deleteSession = useCallback(async (id) => {
    const prev = sessions;
    setSessions(s => s.filter(x => x.id !== id));
    if (activeId === id) {
      const next = prev.find(x => x.id !== id)?.id || null;
      setActiveId(next);
      writeLocalActive(next);
    }
    try {
      await api.chat.sessions.remove(id);
    } catch (e) {
      // Restore on failure so the user doesn't lose state.
      setSessions(prev);
      throw e;
    }
  }, [sessions, activeId]);

  const renameSession = useCallback(async (id, title) => {
    const prev = sessions;
    setSessions(s => s.map(x => x.id === id ? { ...x, title } : x));
    try {
      await api.chat.sessions.rename(id, title);
    } catch (e) {
      setSessions(prev);
      throw e;
    }
  }, [sessions]);

  // Patch a single row (used after a successful chat turn — title or
  // updated_at may have changed server-side; we already know the new values
  // from the /api/lawyer-chat response, so we patch locally without a
  // round-trip).
  const updateSessionLocal = useCallback((id, patch) => {
    setSessions(s => s.map(x => x.id === id ? { ...x, ...patch } : x));
  }, []);

  const toggleCollapsed = useCallback(() => {
    setCollapsed(c => {
      const next = !c;
      writeLocalCollapsed(next);
      return next;
    });
  }, []);

  return {
    sessions,
    activeId,
    collapsed,
    loading,
    selectSession,
    createSession,
    deleteSession,
    renameSession,
    updateSessionLocal,
    toggleCollapsed,
  };
}
