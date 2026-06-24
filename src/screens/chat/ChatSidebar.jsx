/* ============================================================
   ChatSidebar — session list for the AI Lawyer chat.

   Groups rows by relative date (Сьогодні / Вчора / older),
   highlights the active row with --accent, hover-reveal delete,
   inline rename via double-click. Collapse toggle is a chevron
   whose state is persisted by the parent hook.
   ============================================================ */
import { useEffect, useRef, useState } from 'react';
import { Icon } from '../../ui/Icon';
import { toast } from '../../ui/components';

const MONTH_UK = ['січ', 'лют', 'бер', 'кві', 'тра', 'чер', 'лип', 'сер', 'вер', 'жов', 'лис', 'гру'];

function parseServerTs(s) {
  // Server returns "YYYY-MM-DD HH:MM:SS" (datetime('now') in SQLite). Treat
  // it as UTC so the relative date calc is correct regardless of timezone.
  if (!s) return null;
  if (s instanceof Date) return s;
  const iso = s.includes('T') ? s : s.replace(' ', 'T') + 'Z';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

function relativeLabel(ts) {
  const d = parseServerTs(ts);
  if (!d) return '';
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, now)) return 'Сьогодні';
  if (sameDay(d, yesterday)) return 'Вчора';
  if (d.getFullYear() === now.getFullYear()) {
    return `${d.getDate()} ${MONTH_UK[d.getMonth()]}`;
  }
  return `${d.getDate()} ${MONTH_UK[d.getMonth()]} ${d.getFullYear()}`;
}

function groupKey(ts) {
  const d = parseServerTs(ts);
  if (!d) return 'old';
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, now)) return 'today';
  if (sameDay(d, yesterday)) return 'yesterday';
  const sevenDaysAgo = new Date(now);
  sevenDaysAgo.setDate(now.getDate() - 7);
  if (d >= sevenDaysAgo) return 'week';
  if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()) return 'month';
  return 'older';
}

const GROUP_LABEL = {
  today: 'Сьогодні',
  yesterday: 'Вчора',
  week: 'Цього тижня',
  month: 'Цього місяця',
  older: 'Раніше',
};

function groupSessions(rows) {
  const groups = new Map();
  for (const r of rows) {
    const k = groupKey(r.updated_at);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const order = ['today', 'yesterday', 'week', 'month', 'older'];
  return order
    .filter(k => groups.has(k))
    .map(k => ({ key: k, label: GROUP_LABEL[k], items: groups.get(k) }));
}

function SessionItem({ session, active, onSelect, onDelete, onRename }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session.title);
  const inputRef = useRef(null);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  useEffect(() => { if (!editing) setDraft(session.title); }, [session.title, editing]);

  const commit = () => {
    const next = draft.trim();
    setEditing(false);
    if (!next || next === session.title) return;
    onRename(session.id, next);
  };

  return (
    <div className={'cl-row' + (active ? ' cl-row-on' : '')}>
      <button
        type="button"
        className="cl-row-main"
        onClick={() => onSelect(session.id)}
        onDoubleClick={() => setEditing(true)}
      >
        <span className="cl-row-ic" aria-hidden="true">
          <Icon name="chat" size={13} />
        </span>
        <span className="cl-row-tx">
          {editing ? (
            <input
              ref={inputRef}
              className="cl-row-edit"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); commit(); }
                else if (e.key === 'Escape') { setEditing(false); setDraft(session.title); }
              }}
              onClick={(e) => e.stopPropagation()}
              maxLength={200}
            />
          ) : (
            <span className="cl-row-title" title={session.title}>{session.title}</span>
          )}
          <span className="cl-row-date">{relativeLabel(session.updated_at)}</span>
        </span>
      </button>
      <button
        type="button"
        className="cl-row-del"
        aria-label="Видалити чат"
        onClick={(e) => {
          e.stopPropagation();
          onDelete(session.id);
        }}
      >
        <Icon name="trash" size={13} />
      </button>
    </div>
  );
}

export function ChatSidebar({
  sessions,
  activeId,
  collapsed,
  loading,
  onSelect,
  onCreate,
  onDelete,
  onRename,
  onToggleCollapsed,
  onClose,
  isDrawer,
  t,
}) {
  const groups = groupSessions(sessions || []);

  const handleCreate = async () => {
    try {
      await onCreate();
    } catch {
      toast(t.lawErrCreate || 'Не вдалося створити чат.', 'alert');
    }
  };

  const handleDelete = async (id) => {
    try {
      await onDelete(id);
    } catch {
      toast(t.lawErrDelete || 'Не вдалося видалити чат.', 'alert');
    }
  };

  if (collapsed && !isDrawer) {
    // Vertically narrow rail: just the expand toggle + create icon.
    return (
      <aside className="cl-sidebar cl-sidebar-collapsed" aria-label={t.lawHistory || 'Історія чатів'}>
        <button
          type="button"
          className="cl-rail-btn"
          onClick={onToggleCollapsed}
          aria-label={t.lawExpand || 'Розгорнути'}
        >
          <Icon name="chevR" size={14} />
        </button>
        <button
          type="button"
          className="cl-rail-btn cl-rail-btn-accent"
          onClick={handleCreate}
          aria-label={t.lawNewChat || 'Новий чат'}
        >
          <Icon name="plus" size={14} />
        </button>
      </aside>
    );
  }

  return (
    <aside
      className={'cl-sidebar' + (isDrawer ? ' cl-sidebar-drawer' : '')}
      aria-label={t.lawHistory || 'Історія чатів'}
    >
      <header className="cl-head">
        <div className="cl-head-t">
          <Icon name="chat" size={14} />
          <span>{t.lawHistory || 'Історія чатів'}</span>
        </div>
        <button
          type="button"
          className="cl-collapse"
          onClick={isDrawer ? onClose : onToggleCollapsed}
          aria-label={isDrawer ? (t.close || 'Закрити') : (t.lawCollapse || 'Згорнути')}
        >
          <Icon
            name={isDrawer ? 'x' : 'chevR'}
            size={14}
            style={isDrawer ? undefined : { transform: 'rotate(180deg)' }}
          />
        </button>
      </header>

      <button
        type="button"
        className="cl-new-btn"
        onClick={handleCreate}
      >
        <Icon name="plus" size={13} />
        <span>{t.lawNewChat || 'Новий чат'}</span>
      </button>

      <div className="cl-list">
        {loading ? (
          <div className="cl-empty">{t.lawLoading || 'Завантаження…'}</div>
        ) : groups.length === 0 ? (
          <div className="cl-empty">{t.lawNoChats || 'Поки що немає жодного чату.'}</div>
        ) : (
          groups.map(g => (
            <div className="cl-group" key={g.key}>
              <div className="cl-group-h">{g.label}</div>
              {g.items.map(s => (
                <SessionItem
                  key={s.id}
                  session={s}
                  active={s.id === activeId}
                  onSelect={onSelect}
                  onDelete={handleDelete}
                  onRename={onRename}
                />
              ))}
            </div>
          ))
        )}
      </div>
    </aside>
  );
}
