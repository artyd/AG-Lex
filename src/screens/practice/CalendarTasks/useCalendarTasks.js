/* ============================================================
   useCalendarTasks — state + CRUD for the merged Calendar+Tasks
   view. Loads all tasks once, derives the current-month slice
   client-side. Backend failure falls back to LX.tasks so the
   demo stays usable offline.
   ============================================================ */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../../lib/api';
import { LX } from '../../../data/lx';

const DEMO_YEAR = 2026;

function pad(n) { return n < 10 ? '0' + n : '' + n; }

export function ymd(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function todayISO() {
  return ymd(new Date());
}

function lxDueToIso(due, fallbackYear = DEMO_YEAR) {
  if (!due || typeof due !== 'string') return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(due)) return due;
  const m = due.match(/^(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?$/);
  if (!m) return null;
  const day = pad(parseInt(m[1], 10));
  const mon = pad(parseInt(m[2], 10));
  let year = fallbackYear;
  if (m[3]) {
    year = parseInt(m[3], 10);
    if (year < 100) year += 2000;
  }
  return `${year}-${mon}-${day}`;
}

function matterByCode(code) {
  if (!code) return null;
  return (LX.matters || []).find(m => m.code === code) || null;
}

function adaptServerTask(row) {
  if (!row) return null;
  const matter = row.matter_id ? matterByCode(row.matter_id) : null;
  return {
    id: row.id,
    title: row.title || '',
    due_date: row.due_date || row.dueDate || null,
    matter_id: row.matter_id || row.matterId || null,
    matter_code: row.matter_code || (matter ? matter.code : null) || row.matter_id || null,
    assignee_id: row.assignee_id || row.assigneeId || null,
    priority: row.priority || 'med',
    status: row.status === 'done' || row.col === 'done' ? 'done' : 'todo',
    description: row.description || '',
  };
}

function adaptDemoTask(row) {
  return {
    id: row.id,
    title: row.title,
    due_date: lxDueToIso(row.due),
    matter_id: row.matter,
    matter_code: row.matter,
    assignee_id: row.assignee,
    priority: row.priority || 'med',
    status: row.col === 'done' ? 'done' : 'todo',
    description: '',
  };
}

export function useCalendarTasks() {
  const today = useMemo(() => new Date(), []);
  const [currentMonth, setCurrentMonth] = useState(() => new Date(today.getFullYear(), today.getMonth(), 1));
  const [selectedDate, setSelectedDate] = useState(() => ymd(today));
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await api.tasks.list();
      const list = Array.isArray(rows) ? rows.map(adaptServerTask).filter(Boolean) : [];
      setTasks(list);
    } catch (_e) {
      setTasks((LX.tasks || []).map(adaptDemoTask).filter(t => t.due_date));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const tasksForDate = useCallback(
    (iso) => tasks.filter(t => t.due_date === iso),
    [tasks],
  );

  const create = useCallback(async (draft) => {
    const tempId = 'tmp-' + Date.now();
    const optimistic = {
      id: tempId,
      title: draft.title,
      due_date: draft.due_date,
      matter_id: draft.matter_id || null,
      matter_code: draft.matter_id ? (matterByCode(draft.matter_id)?.code || draft.matter_id) : null,
      assignee_id: draft.assignee_id || null,
      priority: draft.priority || 'med',
      status: 'todo',
      description: draft.description || '',
    };
    setTasks(ts => [optimistic, ...ts]);
    try {
      const saved = await api.tasks.create({
        title: draft.title,
        due_date: draft.due_date,
        matter_id: draft.matter_id || null,
        assignee_id: draft.assignee_id || null,
        priority: draft.priority || 'med',
        status: 'todo',
        description: draft.description || '',
      });
      const adapted = adaptServerTask(saved);
      if (adapted) setTasks(ts => ts.map(t => t.id === tempId ? adapted : t));
    } catch (_e) {
      // Offline demo: keep the optimistic row.
    }
  }, []);

  const update = useCallback(async (id, patch) => {
    setTasks(ts => ts.map(t => t.id === id ? { ...t, ...patch } : t));
    try {
      await api.tasks.update(id, patch);
    } catch (_e) {
      // Optimistic state already applied; ignore for offline demo.
    }
  }, []);

  const remove = useCallback(async (id) => {
    let removed;
    setTasks(ts => {
      removed = ts.find(t => t.id === id);
      return ts.filter(t => t.id !== id);
    });
    try {
      await api.tasks.remove(id);
    } catch (_e) {
      if (removed) setTasks(ts => [removed, ...ts]);
    }
  }, []);

  const goToToday = useCallback(() => {
    const t = new Date();
    setCurrentMonth(new Date(t.getFullYear(), t.getMonth(), 1));
    setSelectedDate(ymd(t));
  }, []);

  const stepMonth = useCallback((delta) => {
    setCurrentMonth(m => new Date(m.getFullYear(), m.getMonth() + delta, 1));
  }, []);

  return {
    today,
    currentMonth,
    setCurrentMonth,
    selectedDate,
    setSelectedDate,
    tasks,
    loading,
    tasksForDate,
    create,
    update,
    remove,
    goToToday,
    stepMonth,
    refetch: load,
  };
}
