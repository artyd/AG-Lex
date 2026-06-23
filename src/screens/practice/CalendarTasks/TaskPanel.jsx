/* ============================================================
   TaskPanel — right rail showing tasks on the selected day,
   inline create form, and per-row complete/expand/delete.
   ============================================================ */
import { useEffect, useMemo, useState } from 'react';
import { Icon } from '../../../ui/Icon';
import { UserAvatar } from '../../../lib/labels';
import { LX } from '../../../data/lx';
import { PRIO_COLOR } from './DayCell';

const MONTH_UK = ['січня','лютого','березня','квітня','травня','червня','липня','серпня','вересня','жовтня','листопада','грудня'];
const MONTH_EN = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const DOW_UK = ['Неділя','Понеділок','Вівторок','Середа','Четвер','Пʼятниця','Субота'];
const DOW_EN = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

function parseIso(iso) {
  if (!iso) return null;
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
}

function formatDayHeader(iso, t) {
  const d = parseIso(iso);
  if (!d) return '—';
  const isEn = t && t.locale === 'en-GB';
  const months = isEn ? MONTH_EN : MONTH_UK;
  const dows = isEn ? DOW_EN : DOW_UK;
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()} — ${dows[d.getDay()]}`;
}

function emptyDraft(selectedDate) {
  return {
    title: '',
    matter_id: '',
    assignee_id: (LX.team && LX.team[0] && LX.team[0].id) || '',
    priority: 'med',
    description: '',
    due_date: selectedDate,
  };
}

function TaskRow({ task, t, onToggleDone, onDelete, expanded, onExpand }) {
  const matter = (LX.matters || []).find(m => m.code === task.matter_code || m.id === task.matter_id);
  const prioLabel = { high: t.prioHigh, med: t.prioMed, low: t.prioLow }[task.priority] || task.priority;
  const isDone = task.status === 'done';
  return (
    <div className={'ct-task' + (isDone ? ' ct-task-done' : '') + (expanded ? ' ct-task-open' : '')}>
      <div className="ct-task-head">
        <button
          type="button"
          className={'ct-check' + (isDone ? ' on' : '')}
          onClick={(e) => { e.stopPropagation(); onToggleDone(task); }}
          aria-label={t.markDone || 'Готово'}
          aria-pressed={isDone ? 'true' : 'false'}
        >
          {isDone ? <Icon name="check" size={11} stroke={3} /> : null}
        </button>
        <button
          type="button"
          className="ct-task-title"
          onClick={() => onExpand(expanded ? null : task.id)}
        >
          <span className="ct-task-text">{task.title}</span>
          <span
            className="ct-task-prio"
            style={{
              background: `color-mix(in oklab, ${PRIO_COLOR[task.priority] || PRIO_COLOR.med} 16%, transparent)`,
              color: PRIO_COLOR[task.priority] || PRIO_COLOR.med,
            }}
          >
            {prioLabel}
          </span>
        </button>
        {task.assignee_id ? <UserAvatar id={task.assignee_id} size={26} /> : null}
      </div>
      {expanded ? (
        <div className="ct-task-body">
          {task.description ? <div className="ct-task-desc">{task.description}</div> : null}
          <div className="ct-task-meta">
            {matter ? (
              <span className="ct-task-meta-row">
                <Icon name="folder" size={12} />
                <span>{matter.code} — {matter.title}</span>
              </span>
            ) : null}
            <span className="ct-task-meta-row">
              <Icon name="calendar" size={12} />
              <span>{task.due_date}</span>
            </span>
          </div>
          <div className="ct-task-actions">
            <button type="button" className="ct-link-danger" onClick={() => onDelete(task)}>
              <Icon name="x" size={12} /> {t.deleteBtn || 'Видалити'}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function TaskPanel({
  selectedDate,
  tasks,
  onCreate,
  onUpdate,
  onDelete,
  isMobileSheetOpen,
  onCloseSheet,
  t,
}) {
  const [showForm, setShowForm] = useState(false);
  const [draft, setDraft] = useState(() => emptyDraft(selectedDate));
  const [expandedId, setExpandedId] = useState(null);

  useEffect(() => {
    setShowForm(false);
    setExpandedId(null);
    setDraft(emptyDraft(selectedDate));
  }, [selectedDate]);

  const matters = useMemo(() => LX.matters || [], []);
  const team = useMemo(() => LX.team || [], []);

  const setField = (k, v) => setDraft(d => ({ ...d, [k]: v }));

  const submit = () => {
    const title = (draft.title || '').trim();
    if (!title) return;
    onCreate({
      title,
      due_date: draft.due_date || selectedDate,
      matter_id: draft.matter_id || null,
      assignee_id: draft.assignee_id || null,
      priority: draft.priority,
      description: (draft.description || '').trim(),
    });
    setShowForm(false);
    setDraft(emptyDraft(selectedDate));
  };

  const toggleDone = (task) => {
    onUpdate(task.id, { status: task.status === 'done' ? 'todo' : 'done' });
  };

  const sorted = [...tasks].sort((a, b) => {
    if (a.status !== b.status) return a.status === 'done' ? 1 : -1;
    const prio = { high: 0, med: 1, low: 2 };
    return (prio[a.priority] ?? 3) - (prio[b.priority] ?? 3);
  });

  return (
    <aside
      className={'ct-panel' + (isMobileSheetOpen ? ' ct-panel-open' : '')}
      role="complementary"
    >
      <button
        type="button"
        className="ct-sheet-handle"
        onClick={onCloseSheet}
        aria-label={t.close || 'Закрити'}
      >
        <span />
      </button>
      <header className="ct-panel-head">
        <div className="ct-panel-date">{formatDayHeader(selectedDate, t)}</div>
        <button
          type="button"
          className="ct-add-btn"
          onClick={() => setShowForm(v => !v)}
        >
          <Icon name="plus" size={13} />
          <span>{t.addTask || 'Нова задача'}</span>
        </button>
      </header>

      <div className="ct-task-list">
        {sorted.length === 0 && !showForm ? (
          <div className="ct-empty">
            <Icon name="check" size={18} />
            <div>{t.noTasks || 'Немає задач на цей день'}</div>
          </div>
        ) : null}

        {sorted.map(task => (
          <TaskRow
            key={task.id}
            task={task}
            t={t}
            onToggleDone={toggleDone}
            onDelete={onDelete}
            expanded={expandedId === task.id}
            onExpand={setExpandedId}
          />
        ))}

        {showForm ? (
          <div className="ct-form">
            <label className="ct-field">
              <span className="ct-field-label">{t.taskTitleF || 'Назва задачі'} *</span>
              <input
                type="text"
                className="field"
                autoFocus
                value={draft.title}
                onChange={(e) => setField('title', e.target.value)}
                placeholder={t.taskTitleF || 'Назва задачі'}
              />
            </label>
            <label className="ct-field">
              <span className="ct-field-label">{t.taskMatter || 'Пов’язана справа'}</span>
              <select
                className="field"
                value={draft.matter_id}
                onChange={(e) => setField('matter_id', e.target.value)}
              >
                <option value="">—</option>
                {matters.map(m => (
                  <option key={m.code} value={m.code}>{m.code} — {m.client}</option>
                ))}
              </select>
            </label>
            <label className="ct-field">
              <span className="ct-field-label">{t.taskAssignee || 'Виконавець'}</span>
              <select
                className="field"
                value={draft.assignee_id}
                onChange={(e) => setField('assignee_id', e.target.value)}
              >
                {team.map(u => (
                  <option key={u.id} value={u.id}>{u.name}</option>
                ))}
              </select>
            </label>
            <div className="ct-field">
              <span className="ct-field-label">{t.taskPrio || 'Пріоритет'}</span>
              <div className="ct-prio-row">
                {[
                  { id: 'low', label: t.prioLow || 'Низький' },
                  { id: 'med', label: t.prioMed || 'Середній' },
                  { id: 'high', label: t.prioHigh || 'Критичний' },
                ].map(opt => (
                  <button
                    key={opt.id}
                    type="button"
                    className={'ct-prio-opt' + (draft.priority === opt.id ? ' on' : '')}
                    style={{ '--prio': PRIO_COLOR[opt.id] }}
                    onClick={() => setField('priority', opt.id)}
                  >
                    <span className="ct-prio-dot" style={{ background: PRIO_COLOR[opt.id] }} />
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
            <label className="ct-field">
              <span className="ct-field-label">{t.taskDue || 'Дата дедлайну'}</span>
              <input
                type="date"
                className="field"
                value={draft.due_date}
                onChange={(e) => setField('due_date', e.target.value)}
              />
            </label>
            <label className="ct-field">
              <span className="ct-field-label">{t.taskDescription || 'Опис'}</span>
              <textarea
                className="field"
                rows={3}
                value={draft.description}
                onChange={(e) => setField('description', e.target.value)}
                placeholder={t.taskDescription || 'Опис'}
              />
            </label>
            <div className="ct-form-actions">
              <button type="button" className="btn btn-subtle btn-sm" onClick={() => setShowForm(false)}>
                {t.cancel || 'Скасувати'}
              </button>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={!(draft.title || '').trim()}
                onClick={submit}
              >
                <Icon name="check" size={13} /> {t.save || 'Зберегти'}
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </aside>
  );
}
