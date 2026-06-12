/* ============================================================
   Lexena — practice screens: Matters, Tasks (kanban), Billing
   ============================================================ */
import { useState, useEffect, useRef } from 'react';
import { Icon, Modal, SectionTitle, riskDot, toast } from '../ui/components';
import { UserAvatar, roleLabel, prioColor } from '../lib/labels';
import { DEMO } from '../data/demo';
import { LX } from '../data/lx';
import { api } from '../lib/api';
import { useMatters, useMatterDetail, adaptCard } from './matters/useMatters';
import { MemberPicker } from './matters/MemberPicker';

/* ============================================================
   Matters (справи) — rebuilt to give the lawyer the full case in
   one place. List with filters/search/views, detail with 7 tabs,
   one-click status workflow, dedicated "new matter" form.
   ============================================================ */

const STATUS_ORDER = ['new', 'progress', 'waiting', 'stuck', 'court', 'closed'];

// Single source of truth for status colours. The visible badge in the list
// view, the dropdown swatch, the closing banner, and the dark/light themes
// all read from this map.
const STATUS_COLOR = {
  new:      { bg: 'color-mix(in oklab, var(--text-3) 18%, transparent)', fg: 'var(--text-2)', dot: 'var(--text-3)' },
  progress: { bg: 'color-mix(in oklab, oklch(0.6 0.14 245) 16%, transparent)', fg: 'oklch(0.46 0.14 245)', dot: 'oklch(0.6 0.14 245)' },
  waiting:  { bg: 'var(--risk-med-soft)', fg: 'oklch(0.45 0.12 70)', dot: 'var(--risk-med)' },
  stuck:    { bg: 'color-mix(in oklab, oklch(0.62 0.16 45) 16%, transparent)', fg: 'oklch(0.5 0.16 45)', dot: 'oklch(0.62 0.16 45)' },
  court:    { bg: 'color-mix(in oklab, oklch(0.58 0.18 310) 16%, transparent)', fg: 'oklch(0.46 0.18 310)', dot: 'oklch(0.58 0.18 310)' },
  closed:   { bg: 'var(--risk-low-soft)', fg: 'oklch(0.4 0.12 158)', dot: 'var(--risk-low)' },
};

// Status → matter icon. The prominent icon on each MatterCard and the
// detail header swaps with the status so a glance through the list
// immediately conveys workflow position (per spec).
//
// `fill: true` is set for glyphs whose paths are closed shapes (circle,
// play triangle, pause bars) — without it they render as thin outlines
// and look unfinished. Line-art glyphs (hourglass, gavel, check) stay
// stroke-only so their interior detail stays visible.
const STATUS_ICON = {
  new:      { name: 'circle',    fill: true  },
  progress: { name: 'play',      fill: true  },
  waiting:  { name: 'hourglass', fill: false },
  stuck:    { name: 'pause',     fill: true  },
  court:    { name: 'gavel',     fill: false },
  closed:   { name: 'check',     fill: false },
};

const TYPE_META = {
  corporate:   { icon: 'building', hue: 290 },
  contract:    { icon: 'pen', hue: 25 },
  ip:          { icon: 'sparkle', hue: 158 },
  litigation:  { icon: 'flag', hue: 320 },
  labor:       { icon: 'clients', hue: 70 },
  family:      { icon: 'shield', hue: 245 },
  inheritance: { icon: 'book', hue: 200 },
  other:       { icon: 'folder', hue: 0 },
};
const TYPE_CODE = {
  corporate: 'COR', contract: 'DOG', ip: 'IPS', litigation: 'LIT',
  labor: 'LAB', family: 'FAM', inheritance: 'HER', other: 'GEN',
};

const PRIO_COLOR = { high: 'var(--risk-high)', med: 'var(--risk-med)', low: 'var(--risk-low)' };

function typeLabel(t, type) { return t['mt_type_' + type] || type; }
function statusLabel(t, status) { return t['mt_st_' + status]; }
function prioLabel(t, p) { return t['mt_prio_' + p] || p; }

function parseISODate(s) {
  if (!s) return null;
  const [y, m, d] = s.split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}
function fmtDate(iso, locale) {
  const d = parseISODate(iso);
  if (!d) return '—';
  return d.toLocaleDateString(locale || 'uk-UA', { day: '2-digit', month: 'short', year: 'numeric' });
}
function fmtDateShort(iso, locale) {
  const d = parseISODate(iso);
  if (!d) return '—';
  return d.toLocaleDateString(locale || 'uk-UA', { day: '2-digit', month: 'short' });
}
function daysUntil(iso) {
  const d = parseISODate(iso);
  if (!d) return null;
  const today = new Date(2026, 5, 9); // freeze "today" for the demo
  const ms = d - today;
  return Math.round(ms / 86400000);
}
function deadlineTone(iso) {
  const days = daysUntil(iso);
  if (days === null) return null;
  if (days < 0) return 'overdue';
  if (days <= 7) return 'soon';
  return 'ok';
}

/* ---------- Status pill + workflow dropdown ---------- */
function StatusBadge({ status, t, size = 'md' }) {
  const c = STATUS_COLOR[status] || STATUS_COLOR.new;
  return (
    <span className={'mt-status mt-status-' + size} style={{ background: c.bg, color: c.fg }}>
      <span className="mt-status-dot" style={{ background: c.dot }} />
      {statusLabel(t, status)}
    </span>
  );
}

function StatusDropdown({ status, onChange, t }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  useEffect(() => {
    if (!open) return;
    const h = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  const c = STATUS_COLOR[status] || STATUS_COLOR.new;
  return (
    <div className="mt-status-drop" ref={wrapRef}>
      <button className="mt-status mt-status-md mt-status-trigger" style={{ background: c.bg, color: c.fg }} onClick={() => setOpen(o => !o)}>
        <span className="mt-status-dot" style={{ background: c.dot }} />
        {statusLabel(t, status)}
        <Icon name="chevD" size={13} />
      </button>
      {open && (
        <div className="menu mt-status-menu" style={{ right: 'auto', left: 0 }}>
          {STATUS_ORDER.map(s => {
            const sc = STATUS_COLOR[s];
            return (
              <button key={s} className={'menu-item mt-status-opt' + (status === s ? ' on' : '')}
                onClick={() => { setOpen(false); onChange(s); }}>
                <span className="mt-status-dot" style={{ background: sc.dot }} />
                <span style={{ color: sc.fg, fontWeight: 600 }}>{statusLabel(t, s)}</span>
                {status === s ? <Icon name="check" size={13} /> : null}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ---------- Close-matter modal (result + date) ---------- */
function CloseMatterModal({ open, onClose, onConfirm, t }) {
  const [result, setResult] = useState('won');
  const [date, setDate] = useState('2026-06-09');
  useEffect(() => { if (open) { setResult('won'); setDate('2026-06-09'); } }, [open]);
  return (
    <Modal open={open} onClose={onClose} title={t.mt_close_title} sub={t.mt_close_sub} icon="checkCircle"
      footer={<>
        <button className="btn btn-subtle" onClick={onClose}>{t.cancel}</button>
        <button className="btn btn-primary" onClick={() => onConfirm({ result, date })}>
          <Icon name="check" size={14} /> {t.mt_close_confirm}
        </button>
      </>}>
      <div className="field-row">
        <div className="field-label">{t.mt_result}</div>
        <div className="mt-result-grid">
          {['won', 'lost', 'settled'].map(r => {
            const tone = r === 'won' ? 'var(--risk-low)' : r === 'lost' ? 'var(--risk-high)' : 'var(--info)';
            return (
              <button key={r} className={'mt-result-opt' + (result === r ? ' on' : '')}
                style={{ '--tone': tone }} onClick={() => setResult(r)}>
                <span className="mt-result-ic"><Icon name={r === 'won' ? 'checkCircle' : r === 'lost' ? 'alert' : 'scales'} size={18} /></span>
                <span>{t['mt_result_' + r]}</span>
              </button>
            );
          })}
        </div>
      </div>
      <div className="field-row" style={{ marginTop: 'var(--s4)' }}>
        <label className="field-label" htmlFor="mt-close-date">{t.mt_close_date}</label>
        <input id="mt-close-date" type="date" className="field" value={date} onChange={e => setDate(e.target.value)} />
      </div>
    </Modal>
  );
}

/* ---------- New-matter modal ---------- */
function NewMatterModal({ open, onClose, onCreate, t, clients, defaultLead }) {
  // Default lead = current user (legacy_id). 'u1' was a demo hardcode that
  // produced ownerless-looking matters for any non-seed user.
  const initial = () => ({
    title: '', client: '', type: 'contract', lead: defaultLead || 'u1', priority: 'med',
    status: 'new', startedAt: new Date().toISOString().slice(0, 10),
    nextDate: '', nextLabel: '', description: '',
  });
  const [form, setForm] = useState(initial);
  useEffect(() => {
    if (open) setForm(initial());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, defaultLead]);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const submit = () => {
    if (!form.title.trim() || !form.client.trim()) {
      toast(t.mt_form_required, 'alert');
      return;
    }
    onCreate(form);
  };
  return (
    <Modal open={open} onClose={onClose} title={t.mt_form_title} sub={t.mt_form_sub} icon="folder" wide
      footer={<>
        <button className="btn btn-subtle" onClick={onClose}>{t.cancel}</button>
        <button className="btn btn-primary" onClick={submit}><Icon name="plus" size={14} /> {t.mt_form_create}</button>
      </>}>
      <div className="form-grid">
        <div className="field-row" style={{ gridColumn: '1 / -1' }}>
          <label className="field-label">{t.mt_form_name}</label>
          <input className="field" placeholder={t.mt_form_name_ph} value={form.title} onChange={e => set('title', e.target.value)} />
        </div>
        <div className="field-row">
          <label className="field-label">{t.mt_form_client}</label>
          <input className="field" placeholder={t.mt_form_client_ph} value={form.client} onChange={e => set('client', e.target.value)} list="mt-clients" />
          <datalist id="mt-clients">{clients.map(c => <option key={c} value={c} />)}</datalist>
        </div>
        <div className="field-row">
          <label className="field-label">{t.mt_form_type}</label>
          <select className="field" value={form.type} onChange={e => set('type', e.target.value)}>
            {Object.keys(TYPE_META).map(k => <option key={k} value={k}>{typeLabel(t, k)}</option>)}
          </select>
        </div>
        <div className="field-row">
          <label className="field-label">{t.mt_form_owner}</label>
          <select className="field" value={form.lead} onChange={e => set('lead', e.target.value)}>
            {LX.team.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </div>
        <div className="field-row">
          <label className="field-label">{t.mt_form_priority}</label>
          <select className="field" value={form.priority} onChange={e => set('priority', e.target.value)}>
            {['high', 'med', 'low'].map(p => <option key={p} value={p}>{prioLabel(t, p)}</option>)}
          </select>
        </div>
        <div className="field-row">
          <label className="field-label">{t.mt_form_status}</label>
          <select className="field" value={form.status} onChange={e => set('status', e.target.value)}>
            {STATUS_ORDER.filter(s => s !== 'closed').map(s => <option key={s} value={s}>{statusLabel(t, s)}</option>)}
          </select>
        </div>
        <div className="field-row">
          <label className="field-label">{t.mt_form_start}</label>
          <input type="date" className="field" value={form.startedAt} onChange={e => set('startedAt', e.target.value)} />
        </div>
        <div className="field-row">
          <label className="field-label">{t.mt_form_next_date}</label>
          <input type="date" className="field" value={form.nextDate} onChange={e => set('nextDate', e.target.value)} />
        </div>
        <div className="field-row" style={{ gridColumn: '1 / -1' }}>
          <label className="field-label">{t.mt_form_next_label}</label>
          <input className="field" value={form.nextLabel} onChange={e => set('nextLabel', e.target.value)} />
        </div>
        <div className="field-row" style={{ gridColumn: '1 / -1' }}>
          <label className="field-label">{t.mt_form_desc}</label>
          <textarea className="field" rows={3} placeholder={t.mt_form_desc_ph} value={form.description} onChange={e => set('description', e.target.value)} />
        </div>
      </div>
      <div className="mt-form-codehint">
        <Icon name="sparkle" size={13} fill={true} />
        <span>{t.mt_form_code_hint}: <b>{TYPE_CODE[form.type]}-2026-NN</b></span>
      </div>
    </Modal>
  );
}

/* ---------- Matter card (list mode) ---------- */
function MatterCard({ m, t, onOpen, justAdded }) {
  const meta = TYPE_META[m.type] || TYPE_META.other;
  const ddTone = m.nextDeadline ? deadlineTone(m.nextDeadline.date) : null;
  // Spec: matter icon swaps with status — not type. Type remains visible
  // as a chip beside the code so the metadata isn't lost.
  const statusColor = STATUS_COLOR[m.status] || STATUS_COLOR.new;
  const statusGlyph = STATUS_ICON[m.status] || STATUS_ICON.new;
  return (
    <button className={'card mt-card' + (justAdded ? ' mt-card-just-added' : '')} onClick={onOpen}>
      {justAdded ? <span className="mt-just-added-badge">{t.mt_just_added || 'Вас додали'}</span> : null}
      <div className="mt-card-head">
        <span className="mt-type-ic" style={{ background: statusColor.bg, color: statusColor.fg }}>
          <Icon name={statusGlyph.name} size={18} fill={statusGlyph.fill} />
        </span>
        <div className="mt-card-meta">
          <span className="mt-code">{m.code}</span>
          <span className="chip" style={{ fontSize: 11 }}>{typeLabel(t, m.type)}</span>
          {m.priority === 'high' ? <span className="chip mt-chip-prio"><span className="chip-dot" style={{ background: PRIO_COLOR.high }} />{prioLabel(t, 'high')}</span> : null}
        </div>
        <StatusBadge status={m.status} t={t} size="sm" />
      </div>
      <div className="mt-card-title">{m.title}</div>
      <div className="mt-card-client">{m.client}</div>
      <div className="mt-card-foot">
        <span className="mt-metric"><b>{m.docs}</b> {t.mt_metric_docs}</span>
        <span className="mt-metric"><b style={{ color: m.openTasks ? 'var(--risk-med)' : 'var(--text-3)' }}>{m.openTasks}</b> {t.mt_metric_tasks}</span>
        <span className="mt-metric"><b>{m.hours}</b> {t.mt_metric_hours}</span>
        <span className="mt-card-lead"><UserAvatar id={m.lead} size={28} /></span>
      </div>
      {m.nextDeadline ? (
        <div className={'mt-deadline mt-dd-' + (ddTone || 'ok')}>
          <Icon name={ddTone === 'overdue' ? 'alert' : 'clock'} size={13} />
          <span className="mt-dd-date">{fmtDateShort(m.nextDeadline.date, t.locale)}</span>
          <span className="mt-dd-label">{m.nextDeadline.label}</span>
        </div>
      ) : (
        <div className="mt-deadline mt-dd-none">
          <Icon name="clock" size={13} />
          <span>{t.mt_no_deadline}</span>
        </div>
      )}
    </button>
  );
}

/* ---------- Matter detail tabs ---------- */
function TabOverview({ m, t }) {
  return (
    <div className="mt-ov-grid">
      <div className="card mt-card-pad">
        <SectionTitle>{t.mt_ov_summary}</SectionTitle>
        <p className="mt-text">{m.description || '—'}</p>
        <hr className="divider" />
        <SectionTitle>{t.mt_ov_key}</SectionTitle>
        <ul className="mt-key-list">
          {(m.keyFacts || []).map((f, i) => (
            <li key={i}><span className="mt-key-dot" /> {f}</li>
          ))}
          {(m.keyFacts || []).length === 0 ? <li style={{ color: 'var(--text-3)', fontSize: 13 }}>—</li> : null}
        </ul>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s4)' }}>
        <div className={'card mt-next ' + (m.nextDeadline ? 'mt-next-' + (deadlineTone(m.nextDeadline.date) || 'ok') : 'mt-next-empty')}>
          <div className="mt-next-label">{t.mt_ov_next_step}</div>
          {m.nextDeadline ? (
            <>
              <div className="mt-next-title">{m.nextDeadline.label}</div>
              <div className="mt-next-date">
                <Icon name="calendar" size={14} />
                <span>{fmtDate(m.nextDeadline.date, t.locale)}</span>
                {deadlineTone(m.nextDeadline.date) === 'overdue' ? <span className="badge-risk badge-high">{t.mt_overdue}</span>
                  : deadlineTone(m.nextDeadline.date) === 'soon' ? <span className="badge-risk badge-med">{t.mt_soon}</span> : null}
              </div>
            </>
          ) : (
            <div className="mt-next-title" style={{ color: 'var(--text-3)' }}>{t.mt_ov_no_next}</div>
          )}
        </div>
        <div className="card mt-card-pad">
          <SectionTitle>{t.mt_ov_dates}</SectionTitle>
          <div className="mt-dates-mini">
            <div><div className="ms-l">{t.mt_started}</div><div className="mt-dates-v">{fmtDate(m.startedAt, t.locale)}</div></div>
            {m.closedAt ? <div><div className="ms-l">{t.mt_closed_on}</div><div className="mt-dates-v">{fmtDate(m.closedAt, t.locale)}</div></div> : null}
          </div>
        </div>
        <div className="card mt-card-pad">
          <SectionTitle>{t.mt_ov_parties_short}</SectionTitle>
          <div className="mt-parties-mini">
            <div><div className="ms-l">{t.mt_party_client}</div><div className="mt-parties-v">{m.parties?.client || m.client}</div></div>
            {m.parties?.opponent ? <div><div className="ms-l">{t.mt_party_opponent}</div><div className="mt-parties-v">{m.parties.opponent}</div></div> : null}
            {m.court ? <div><div className="ms-l">{t.mt_party_court}</div><div className="mt-parties-v">{m.court}</div></div> : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function TabDocuments({ m, t, setRoute }) {
  // Seed from the demo library, then append any documents the user attaches
  // in this session. Persistence to a /api/matters/{id}/documents endpoint
  // is a separate piece of work; for now the file picker at least *does*
  // something — adds the entry to the list and shows a confirmation toast.
  const initialDocs = DEMO.library.filter(c => c.client === m.client);
  const [docs, setDocs] = useState(initialDocs);
  const fileRef = useRef(null);

  const onPick = (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    const stamp = new Date().toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const added = files.map(f => ({
      id: 'd_' + Math.random().toString(36).slice(2, 8),
      name: f.name,
      type: (f.name.split('.').pop() || '').toUpperCase() || '—',
      client: m.client,
      date: stamp,
      risk: 'low',
      size: f.size,
    }));
    setDocs(d => [...added, ...d]);
    toast(`${added.length === 1 ? added[0].name : added.length + ' файлів'} · ${t.uploadDone}`, 'upload');
    e.target.value = '';
  };

  return (
    <div className="card mt-card-pad">
      <SectionTitle action={
        <>
          <input ref={fileRef} type="file" multiple style={{ display: 'none' }} onChange={onPick} accept=".pdf,.docx,.doc,.xlsx,.png,.jpg,.jpeg" />
          <button className="btn btn-ghost btn-sm" onClick={() => fileRef.current && fileRef.current.click()}>
            <Icon name="upload" size={14} /> {t.mt_docs_upload}
          </button>
        </>
      }>{t.mt_tab_docs}</SectionTitle>
      {docs.length === 0 ? (
        <div className="mt-empty"><Icon name="doc" size={26} /><div>{t.mt_docs_empty}</div></div>
      ) : (
        <div className="recent-list">
          {docs.map(c => (
            <button className="recent-row" key={c.id} onClick={() => setRoute && setRoute('analyze')}>
              <span className="recent-ic"><Icon name="doc" size={16} /></span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span className="recent-name">{c.name}</span>
                <span className="recent-sub">{c.type} · {c.date}{c.size ? ' · ' + (c.size / 1024).toFixed(0) + ' KB' : ''}</span>
              </span>
              {riskDot(c.risk)}
              <Icon name="chevR" size={15} style={{ color: 'var(--text-3)' }} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function TabTasks({ m, t }) {
  // Seed local list with LX-prototype tasks for the matter's code so the
  // tab isn't empty when the new collaborator visits a freshly created case.
  const [tasks, setTasks] = useState(() => LX.tasks.filter(k => k.matter === m.code));
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ title: '', assignee: m.lead || 'u1', due: '', priority: 'med' });
  const toggle = (id) => setTasks(ts => ts.map(k => k.id === id ? { ...k, col: k.col === 'done' ? 'todo' : 'done' } : k));
  const active = tasks.filter(k => k.col !== 'done');

  // Pool of assignable users: case team if available, else the full LX team
  // (covers the gap when the detail isn't hydrated yet).
  const assignablePool = (m.members && m.members.length > 0)
    ? m.members.map(mb => ({ id: mb.user_id, name: mb.name || mb.user_id }))
    : LX.team.map(u => ({ id: u.id, name: u.name }));

  const submit = () => {
    if (!draft.title.trim()) { toast(t.mt_form_required, 'alert'); return; }
    const optimistic = {
      id: 'tk-' + Math.random().toString(36).slice(2, 8),
      title: draft.title.trim(),
      matter: m.code,
      assignee: draft.assignee,
      due: draft.due || '—',
      priority: draft.priority,
      col: 'todo',
    };
    setTasks(ts => [optimistic, ...ts]);
    api.matters.addTask(m.id, {
      title: optimistic.title,
      assignee: draft.assignee,
      due: draft.due || null,
      priority: draft.priority,
      col: 'todo',
    })
      .then(() => toast(t.taskCreated || t.mt_tasks_added || 'Задачу створено', 'check'))
      .catch((e) => {
        // Roll back optimistic insert on failure so the UI doesn't lie.
        setTasks(ts => ts.filter(k => k.id !== optimistic.id));
        toast(e.message || 'Не вдалося створити задачу', 'alert');
      });
    setDraft({ title: '', assignee: m.lead || 'u1', due: '', priority: 'med' });
    setAdding(false);
  };

  return (
    <div className="card mt-card-pad">
      <SectionTitle action={
        <button className="btn btn-ghost btn-sm" onClick={() => setAdding(a => !a)}>
          <Icon name="plus" size={14} /> {t.mt_tasks_add}
        </button>
      }>{t.mt_tab_tasks}</SectionTitle>

      {adding ? (
        <div className="mt-task-form">
          <input
            className="field"
            placeholder={t.taskTitleF || 'Назва задачі'}
            value={draft.title}
            onChange={e => setDraft(d => ({ ...d, title: e.target.value }))}
            autoFocus
          />
          <div className="mt-task-form-row">
            <select className="field" value={draft.assignee} onChange={e => setDraft(d => ({ ...d, assignee: e.target.value }))} aria-label={t.taskAssignee}>
              {assignablePool.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
            <input
              type="date"
              className="field"
              value={draft.due}
              onChange={e => setDraft(d => ({ ...d, due: e.target.value }))}
              aria-label={t.taskDue}
            />
            <select className="field" value={draft.priority} onChange={e => setDraft(d => ({ ...d, priority: e.target.value }))} aria-label={t.taskPrio}>
              <option value="high">{t.prioHigh}</option>
              <option value="med">{t.prioMed}</option>
              <option value="low">{t.prioLow}</option>
            </select>
            <button className="btn btn-primary btn-sm" onClick={submit}><Icon name="check" size={13} /> {t.save}</button>
            <button className="btn btn-subtle btn-sm" onClick={() => { setAdding(false); setDraft({ title: '', assignee: m.lead || 'u1', due: '', priority: 'med' }); }}>{t.cancel}</button>
          </div>
        </div>
      ) : null}

      {tasks.length === 0 ? (
        <div className="mt-empty"><Icon name="check" size={26} /><div>{t.mt_tasks_empty}</div></div>
      ) : (
        <div className="mt-tasks">
          {tasks.map(k => (
            <div key={k.id} className={'mt-task' + (k.col === 'done' ? ' mt-task-done' : '')}>
              <button className={'mt-check' + (k.col === 'done' ? ' on' : '')} onClick={() => { toggle(k.id); if (k.col !== 'done') toast(t.mt_tasks_done_toast, 'check'); }} aria-label={t.markDone}>
                {k.col === 'done' ? <Icon name="check" size={13} stroke={3} /> : null}
              </button>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="mt-task-title">{k.title}</div>
                <div className="mt-task-sub">{t.taskDue}: {k.due} · {prioLabel(t, k.priority)}</div>
              </div>
              <span className="chip-dot" style={{ background: PRIO_COLOR[k.priority] }} />
              <UserAvatar id={k.assignee} size={26} />
            </div>
          ))}
        </div>
      )}
      <div className="mt-tasks-summary">
        <span>{active.length} {t.mt_tasks_add.toLowerCase()}</span>
      </div>
    </div>
  );
}

function TabDates({ m, t }) {
  const items = [];
  if (m.nextDeadline) items.push({ id: 'd0', date: m.nextDeadline.date, label: m.nextDeadline.label, kind: m.nextDeadline.kind || 'proc' });
  DEMO.tasks.filter(tk => tk.client === m.client).forEach(tk => {
    items.push({ id: 'd-' + tk.id, date: tk.date, label: tk.title, kind: tk.type === 'meeting' ? 'court' : 'proc' });
  });
  items.sort((a, b) => a.date.localeCompare(b.date));
  return (
    <div className="card mt-card-pad">
      <SectionTitle action={
        <button className="btn btn-ghost btn-sm" onClick={() => toast(t.addedToCal, 'calendar')}>
          <Icon name="plus" size={14} /> {t.mt_dates_add}
        </button>
      }>{t.mt_tab_dates}</SectionTitle>
      {items.length === 0 ? (
        <div className="mt-empty"><Icon name="calendar" size={26} /><div>{t.mt_dates_empty}</div></div>
      ) : (
        <div className="mt-tl">
          {items.map(it => {
            const tone = deadlineTone(it.date);
            const tone_color = tone === 'overdue' ? 'var(--risk-high)' : tone === 'soon' ? 'var(--risk-med)' : 'var(--info)';
            return (
              <div key={it.id} className="mt-tl-row">
                <div className="mt-tl-date">
                  <b>{parseISODate(it.date)?.toLocaleDateString(t.locale, { day: '2-digit' })}</b>
                  <span>{parseISODate(it.date)?.toLocaleDateString(t.locale, { month: 'short' })}</span>
                </div>
                <span className="mt-tl-dot" style={{ background: tone_color }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="mt-tl-title">{it.label}</div>
                  <div className="mt-tl-sub">
                    {it.kind === 'court' ? t.mt_dates_court : t.mt_dates_proc}
                  </div>
                </div>
                {tone === 'overdue' ? <span className="badge-risk badge-high">{t.mt_overdue}</span>
                  : tone === 'soon' ? <span className="badge-risk badge-med">{t.mt_soon}</span> : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function TabBilling({ m, t }) {
  const entries = LX.timeEntries.filter(e => e.matter === m.code);
  const totalHours = entries.reduce((s, e) => s + e.hours, 0);
  const totalAmount = entries.reduce((s, e) => s + (e.billable ? e.hours * e.rate : 0), 0);
  const invoices = LX.invoices.filter(i => i.client === m.client);
  return (
    <div className="mt-ov-grid">
      <div className="card mt-card-pad">
        <SectionTitle action={
          <button className="btn btn-ghost btn-sm" onClick={() => toast(t.timeLogged, 'clock')}>
            <Icon name="plus" size={14} /> {t.mt_bill_add}
          </button>
        }>{t.mt_bill_entries}</SectionTitle>
        {entries.length === 0 ? (
          <div className="mt-empty"><Icon name="clock" size={26} /><div>—</div></div>
        ) : (
          <table className="mt-bill-table">
            <thead><tr><th>{t.colDate}</th><th>{t.mLead}</th><th style={{ textAlign: 'right' }}>{t.mHours}</th><th style={{ textAlign: 'right' }}>{t.mt_bill_amount}</th></tr></thead>
            <tbody>
              {entries.map(e => (
                <tr key={e.id}>
                  <td>{e.date}</td>
                  <td><UserAvatar id={e.who} size={22} /> <span style={{ marginLeft: 6 }}>{LX.userById[e.who]?.name}</span></td>
                  <td style={{ textAlign: 'right', fontFeatureSettings: '"tnum"' }}>{e.hours.toFixed(1)}</td>
                  <td style={{ textAlign: 'right', fontFeatureSettings: '"tnum"', color: e.billable ? 'var(--text)' : 'var(--text-3)' }}>{e.billable ? (e.hours * e.rate).toLocaleString('uk-UA') + ' ₴' : '—'}</td>
                </tr>
              ))}
              <tr className="mt-bill-total"><td colSpan={2}>{t.mt_bill_total_hours} / {t.mt_bill_total_amount}</td>
                <td style={{ textAlign: 'right' }}>{totalHours.toFixed(1)}</td>
                <td style={{ textAlign: 'right' }}>{totalAmount.toLocaleString('uk-UA')} ₴</td></tr>
            </tbody>
          </table>
        )}
      </div>
      <div className="card mt-card-pad">
        <SectionTitle>{t.mt_bill_invoices}</SectionTitle>
        {invoices.length === 0 ? (
          <div className="mt-empty"><Icon name="pay" size={26} /><div>—</div></div>
        ) : (
          <div className="mt-inv-list">
            {invoices.map(i => (
              <div key={i.id} className="mt-inv-row">
                <Icon name="pay" size={18} style={{ color: 'var(--accent)' }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 13.5 }}>{i.num} · {i.period}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-3)' }}>{i.client}</div>
                </div>
                <div style={{ fontWeight: 700, fontFeatureSettings: '"tnum"' }}>{i.amount.toLocaleString('uk-UA')} ₴</div>
                <span className={'badge-risk ' + (i.status === 'paid' ? 'badge-low' : i.status === 'sent' ? 'badge-med' : 'badge-info')}>
                  {i.status === 'paid' ? t.invPaid : i.status === 'sent' ? t.invSent : t.invDraft}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function TabParties({ m, t }) {
  const p = m.parties || {};
  const rows = [
    { label: t.mt_party_client, value: p.client || m.client },
    { label: t.mt_party_client_rep, value: p.clientRep },
    { label: t.mt_party_opponent, value: p.opponent || m.opponent },
    { label: t.mt_party_opp_rep, value: p.opponentRep },
    { label: t.mt_party_court, value: m.court },
    { label: t.mt_party_judge, value: m.judge },
  ];
  return (
    <div className="card mt-card-pad">
      <SectionTitle>{t.mt_tab_parties}</SectionTitle>
      <div className="mt-parties">
        {rows.map((r, i) => (
          <div key={i} className="mt-party-row">
            <div className="ms-l">{r.label}</div>
            <div className="mt-parties-v" style={{ color: r.value ? 'var(--text)' : 'var(--text-3)', fontStyle: r.value ? 'normal' : 'italic' }}>
              {r.value || t.mt_party_none}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function TabNotes({ m, t, onAddNote }) {
  const [draft, setDraft] = useState('');
  return (
    <div className="mt-ov-grid">
      <div className="card mt-card-pad">
        <SectionTitle>{t.mt_tab_notes}</SectionTitle>
        <div className="mt-note-add">
          <textarea className="field" rows={2} placeholder={t.mt_notes_ph} value={draft} onChange={e => setDraft(e.target.value)} />
          <button className="btn btn-primary btn-sm" disabled={!draft.trim()} onClick={() => {
            if (!draft.trim()) return;
            onAddNote(draft.trim());
            setDraft('');
          }}><Icon name="plus" size={13} /> {t.mt_notes_save}</button>
        </div>
        {(!m.notes || m.notes.length === 0) ? (
          <div className="mt-empty" style={{ marginTop: 'var(--s4)' }}><Icon name="pen" size={22} /><div>{t.mt_notes_empty}</div></div>
        ) : (
          <div className="mt-notes">
            {m.notes.map(n => (
              <div key={n.id} className="mt-note">
                <UserAvatar id={n.author} size={28} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="mt-note-head">
                    <span style={{ fontWeight: 600 }}>{LX.userById[n.author]?.name || n.author}</span>
                    <span style={{ color: 'var(--text-3)', fontSize: 12 }}>{fmtDate(n.date, t.locale)}</span>
                  </div>
                  <div className="mt-note-text">{n.text}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="card mt-card-pad">
        <SectionTitle>{t.mt_timeline_title}</SectionTitle>
        <div className="mt-tl">
          {(m.timeline || []).map(it => (
            <div key={it.id} className="mt-tl-row">
              <div className="mt-tl-date">
                <b>{parseISODate(it.date)?.toLocaleDateString(t.locale, { day: '2-digit' })}</b>
                <span>{parseISODate(it.date)?.toLocaleDateString(t.locale, { month: 'short' })}</span>
              </div>
              <span className="mt-tl-dot" style={{ background: it.kind === 'closed' ? 'var(--risk-low)' : it.kind === 'court' ? 'oklch(0.58 0.18 310)' : 'var(--info)' }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="mt-tl-title">{it.text}</div>
                <div className="mt-tl-sub">
                  {it.kind === 'doc' ? t.mt_tab_docs : it.kind === 'court' ? t.mt_dates_court : it.kind === 'closed' ? t.mt_st_closed : t.mt_notes_add}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ---------- Matters root component ---------- */
function Matters({ t, setRoute }) {
  // Phase 2.4: list comes from /api/matters scoped to current user.
  // useMatters subscribes to realtime case/member events so the list
  // refreshes when other team members make changes.
  const { matters, setMatters, reload: reloadMatters } = useMatters();
  const [statusFilter, setStatusFilter] = useState('active'); // active | closed | all
  const [typeFilter, setTypeFilter] = useState('all');
  const [ownerFilter, setOwnerFilter] = useState('all');
  const [mineOnly, setMineOnly] = useState(false);
  const [search, setSearch] = useState('');
  const [view, setView] = useState('cards');
  const [sel, setSel] = useState(null);
  const [tab, setTab] = useState('overview');
  const [closeOpen, setCloseOpen] = useState(false);
  const [pendingStatus, setPendingStatus] = useState(null);
  const [newOpen, setNewOpen] = useState(false);
  const [memberPickerOpen, setMemberPickerOpen] = useState(false);
  // Hydrated detail (members, parties, notes, hearings, timeline) for the
  // currently open case. Card-shape from `matters` is the fallback while
  // the GET /api/matters/{id} request is in flight; once `detail` arrives
  // it takes precedence so the detail view has access to the full payload.
  const { detail, reload: reloadDetail } = useMatterDetail(sel);

  // Resolve the current user's TEXT id once so it can pre-populate the
  // "new matter" lead field. Falling back to 'u1' (the demo seed user)
  // keeps the local prototype working without a backend session.
  const currentUserLegacyId = (() => {
    try {
      const raw = localStorage.getItem('aglex_session_v2');
      const u = raw ? JSON.parse(raw)?.user : null;
      return u?.legacy_id || (u?.id ? 'u' + u.id : 'u1');
    } catch (_e) { return 'u1'; }
  })();

  // Honour the optional "open this matter" hint set by App.jsx when the
  // user clicks a case-targeted notification in the bell.
  useEffect(() => {
    try {
      const pending = localStorage.getItem('aglex_matter_open');
      if (pending) {
        localStorage.removeItem('aglex_matter_open');
        setSel(pending);
      }
    } catch (_e) {}
  }, []);

  // Set of case_ids the user has unread "member.added" notifications for.
  // Drives the "Вас додали" badge + accent border on the matter card.
  const [unreadCases, setUnreadCases] = useState(() => new Set());
  useEffect(() => {
    api.notifications.list({ unread: 1, limit: 50 })
      .then(rows => {
        const ids = (rows || [])
          .filter(n => n.type === 'member.added' && n.case_id)
          .map(n => n.case_id);
        setUnreadCases(new Set(ids));
      })
      .catch(() => {});
  }, []);

  const list = matters.filter(m => {
    if (statusFilter === 'active' && m.status === 'closed') return false;
    if (statusFilter === 'closed' && m.status !== 'closed') return false;
    if (typeFilter !== 'all' && m.type !== typeFilter) return false;
    if (ownerFilter !== 'all' && m.lead !== ownerFilter) return false;
    if (mineOnly) {
      // "Мої справи" — only matters where I'm the lead. Membership is
      // already enforced server-side; this further restricts to the
      // user's own queue.
      try {
        const raw = localStorage.getItem('aglex_session_v2');
        const u = raw ? JSON.parse(raw)?.user : null;
        const me = u?.legacy_id || (u?.id ? 'u' + u.id : null);
        if (me && m.lead !== me) return false;
      } catch (_e) {}
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      if (![m.code, m.title, m.client].join(' ').toLowerCase().includes(q)) return false;
    }
    return true;
  });

  const counts = {
    active: matters.filter(m => m.status !== 'closed').length,
    closed: matters.filter(m => m.status === 'closed').length,
    all: matters.length,
  };

  // Optimistic local update; server confirms via WS broadcast.
  const updateMatter = (id, patch) => setMatters(ms => ms.map(m => m.id === id ? { ...m, ...patch } : m));

  const onStatusChange = (id, next) => {
    if (next === 'closed') {
      setPendingStatus(id);
      setCloseOpen(true);
      return;
    }
    updateMatter(id, { status: next, result: null, closedAt: null });
    api.matters.update(id, { status: next })
      .then(() => toast(t.mt_status_toast, 'check'))
      .catch(() => { toast(t.mt_status_toast, 'alert'); reloadMatters(); });
  };
  const confirmClose = ({ result, date }) => {
    if (!pendingStatus) return;
    const id = pendingStatus;
    updateMatter(id, { status: 'closed', result, outcome: result, closedAt: date });
    setCloseOpen(false);
    setPendingStatus(null);
    api.matters.update(id, { status: 'closed', outcome: result, closedAt: date })
      .then(() => toast(t.mt_closed_toast, 'checkCircle'))
      .catch(() => { toast(t.mt_closed_toast, 'alert'); reloadMatters(); });
  };

  const createMatter = (form) => {
    // Default the lead to the current user — `u1` was a demo-prototype
    // hardcode that broke for any registered account that wasn't seeded
    // as u1 (gave a noisy mismatch and made the matter look ownerless).
    const body = {
      title: (form.title || '').trim(),
      client: (form.client || '').trim(),
      type: form.type || 'other',
      lead: form.lead || currentUserLegacyId,
      priority: form.priority || 'med',
      status: form.status || 'new',
      description: form.description || null,
      startedAt: form.startedAt || null,
      nextDeadline: form.nextDate || null,
      nextLabel: form.nextLabel || null,
      // Backend takes a list of legacy_id strings as the initial team. The
      // creator is auto-added as lead; team adds happen via MemberPicker.
      team: [],
    };
    api.matters.create(body)
      .then(row => {
        const card = adaptCard(row);
        setMatters(ms => [card, ...ms.filter(m => m.id !== card.id)]);
        setNewOpen(false);
        toast(t.mt_created_toast, 'plus');
        setSel(card.id);
        setTab('overview');
      })
      .catch((e) => {
        // Surface the actual server error so deployment mismatches (e.g.
        // running against an old backend without these migrations) are
        // visible instead of silently failing with a generic message.
        const msg = e?.message || t.mt_form_required;
        toast(msg, 'alert');
        // eslint-disable-next-line no-console
        console.error('matters.create failed', e);
      });
  };

  const addNote = (id, text) => {
    // Optimistic insert so the UI feels instant; server response replaces
    // the temp row with the canonical one (matched by case_id; arrives
    // via the note.added broadcast too).
    const tempId = 'n_' + Math.random().toString(36).slice(2, 7);
    setMatters(ms => ms.map(m => {
      if (m.id !== id) return m;
      const note = { id: tempId, date: '2026-06-09', author: m.lead, text };
      return { ...m, notes: [note, ...(m.notes || [])] };
    }));
    api.matters.addNote(id, { text })
      .then(() => toast(t.mt_notes_added, 'pen'))
      .catch(() => {
        // Roll back the optimistic insert on failure.
        setMatters(ms => ms.map(m => m.id === id
          ? { ...m, notes: (m.notes || []).filter(n => n.id !== tempId) }
          : m));
        toast(t.mt_notes_added, 'alert');
      });
  };

  /* ---------- Detail view ---------- */
  if (sel) {
    const card = matters.find(x => x.id === sel);
    // Merge: detail wins when the GET landed (it has members/notes/etc),
    // card covers the in-flight gap so the page renders something
    // immediately. If neither exists the selection points at a deleted
    // matter — bail back to the list.
    const m = detail || card;
    if (!m) { setSel(null); return null; }
    const meta = TYPE_META[m.type] || TYPE_META.other;
    const TABS = [
      ['overview', t.mt_tab_overview, 'dashboard'],
      ['docs', t.mt_tab_docs, 'doc'],
      ['tasks', t.mt_tab_tasks, 'check'],
      ['dates', t.mt_tab_dates, 'calendar'],
      ['billing', t.mt_tab_billing, 'clock'],
      ['parties', t.mt_tab_parties, 'clients'],
      ['notes', t.mt_tab_notes, 'pen'],
    ];
    return (
      <div className="page view-enter">
        <div className="page-narrow">
          <button className="btn btn-subtle btn-sm mt-back" onClick={() => setSel(null)}>
            <Icon name="chevR" size={14} style={{ transform: 'rotate(180deg)' }} /> {t.mt_back}
          </button>

          <div className="card mt-detail-head">
            {(() => {
              const sc = STATUS_COLOR[m.status] || STATUS_COLOR.new;
              const sg = STATUS_ICON[m.status] || STATUS_ICON.new;
              return (
                <span className="mt-type-ic mt-type-ic-lg" style={{ background: sc.bg, color: sc.fg }}>
                  <Icon name={sg.name} size={26} fill={sg.fill} />
                </span>
              );
            })()}
            <div className="mt-detail-info">
              <div className="mt-detail-chips">
                <span className="mt-code">{m.code}</span>
                <span className="chip">{typeLabel(t, m.type)}</span>
                <span className="chip mt-chip-prio"><span className="chip-dot" style={{ background: PRIO_COLOR[m.priority] }} />{prioLabel(t, m.priority)}</span>
              </div>
              <h1 className="mt-detail-title">{m.title}</h1>
              <div className="mt-detail-client">{m.client}</div>
              {/* Team strip: lead + collaborators with hover tooltips. The
                  user wants to see at a glance who's responsible and who's
                  on the case. Members come from the hydrated detail; if it
                  isn't loaded yet we fall back to just the lead avatar. */}
              <div className="mt-team-strip">
                <span className="mt-team-label">{t.mLead}:</span>
                {(m.members && m.members.length > 0) ? (
                  <>
                    {m.members.map(mb => (
                      <span key={mb.user_id} className="mt-team-member" title={`${mb.name || mb.user_id}${mb.role_in_case === 'lead' ? ' · ' + t.mt_team_role_lead : ''}`}>
                        <UserAvatar id={mb.user_id} size={28} />
                        {mb.role_in_case === 'lead' ? <span className="mt-team-lead-pip" /> : null}
                      </span>
                    ))}
                  </>
                ) : (
                  <UserAvatar id={m.lead} size={28} />
                )}
                <button className="mt-team-add" onClick={() => setMemberPickerOpen(true)} aria-label={t.mt_team_add}>
                  <Icon name="plus" size={14} />
                </button>
              </div>
            </div>
            <div className="mt-detail-side">
              <StatusDropdown status={m.status} t={t} onChange={(s) => onStatusChange(m.id, s)} />
              {m.nextDeadline ? (
                <div className={'mt-detail-deadline mt-dd-' + (deadlineTone(m.nextDeadline.date) || 'ok')}>
                  <Icon name="calendar" size={14} />
                  <div style={{ minWidth: 0 }}>
                    <div className="mt-detail-deadline-l">{t.mt_next}</div>
                    <div className="mt-detail-deadline-v">{fmtDate(m.nextDeadline.date, t.locale)} · {m.nextDeadline.label}</div>
                  </div>
                </div>
              ) : null}
              <div className="mt-detail-actions">
                <button className="btn btn-ghost btn-sm" onClick={() => setMemberPickerOpen(true)}>
                  <Icon name="plus" size={13} /> {t.mt_team_add || 'Додати учасника'}
                </button>
                <button className="btn btn-ghost btn-sm" onClick={() => toast(t.timeLogged, 'clock')}><Icon name="clock" size={13} /> {t.mt_action_log}</button>
                <button className="btn btn-ghost btn-sm" onClick={() => toast(t.taskCreated, 'check')}><Icon name="plus" size={13} /> {t.mt_action_task}</button>
                <button className="btn btn-ghost btn-sm" onClick={() => setTab('notes')}><Icon name="pen" size={13} /> {t.mt_action_note}</button>
              </div>
            </div>
          </div>

          {m.status === 'closed' && m.result ? (
            <div className={'mt-closed-banner mt-result-' + m.result}>
              <Icon name={m.result === 'won' ? 'checkCircle' : m.result === 'lost' ? 'alert' : 'scales'} size={18} />
              <div style={{ flex: 1 }}>
                <b>{t['mt_result_' + m.result]}</b>
                <span style={{ color: 'var(--text-3)', marginLeft: 8 }}>· {t.mt_closed_on}: {fmtDate(m.closedAt, t.locale)}</span>
              </div>
            </div>
          ) : null}

          <div className="mt-tabs">
            {TABS.map(([id, label, icon]) => (
              <button key={id} className={'mt-tab' + (tab === id ? ' on' : '')} onClick={() => setTab(id)}>
                <Icon name={icon} size={14} />
                <span>{label}</span>
              </button>
            ))}
          </div>

          <div className="mt-tab-body">
            {tab === 'overview' ? <TabOverview m={m} t={t} /> : null}
            {tab === 'docs' ? <TabDocuments m={m} t={t} setRoute={setRoute} /> : null}
            {tab === 'tasks' ? <TabTasks m={m} t={t} /> : null}
            {tab === 'dates' ? <TabDates m={m} t={t} /> : null}
            {tab === 'billing' ? <TabBilling m={m} t={t} /> : null}
            {tab === 'parties' ? <TabParties m={m} t={t} /> : null}
            {tab === 'notes' ? <TabNotes m={m} t={t} onAddNote={(text) => addNote(m.id, text)} /> : null}
          </div>
        </div>
        <CloseMatterModal open={closeOpen} onClose={() => { setCloseOpen(false); setPendingStatus(null); }} onConfirm={confirmClose} t={t} />
        <MemberPicker
          open={memberPickerOpen}
          onClose={() => setMemberPickerOpen(false)}
          caseId={m.id}
          currentMemberIds={(m.members || []).map(x => x.user_id).filter(Boolean)}
          onAdded={() => reloadMatters()}
          t={t}
        />
      </div>
    );
  }

  /* ---------- List view ---------- */
  const allTypes = Object.keys(TYPE_META);
  const allOwners = LX.team.map(u => u.id);
  const clientsList = Array.from(new Set(matters.map(m => m.client))).sort();

  return (
    <div className="page view-enter">
      <div className="page-narrow">
        <div className="mt-toolbar">
          <div className="seg">
            {[['active', t.mt_active], ['closed', t.mt_closed], ['all', t.mt_all]].map(([id, l]) => (
              <button key={id} className={statusFilter === id ? 'on' : ''} onClick={() => setStatusFilter(id)}>
                {l} <span className="mt-count">{counts[id]}</span>
              </button>
            ))}
          </div>
          <div className="search mt-search">
            <Icon name="search" size={16} />
            <input placeholder={t.mt_search} value={search} onChange={e => setSearch(e.target.value)} />
            {search ? <button className="search-clear" onClick={() => setSearch('')}><Icon name="x" size={13} /></button> : null}
          </div>
          <select className="field mt-select" value={typeFilter} onChange={e => setTypeFilter(e.target.value)} aria-label={t.mt_filter_type}>
            <option value="all">{t.mt_all_types}</option>
            {allTypes.map(tp => <option key={tp} value={tp}>{typeLabel(t, tp)}</option>)}
          </select>
          <select className="field mt-select" value={ownerFilter} onChange={e => setOwnerFilter(e.target.value)} aria-label={t.mt_filter_owner}>
            <option value="all">{t.mt_all_owners}</option>
            {allOwners.map(uid => <option key={uid} value={uid}>{LX.userById[uid]?.name}</option>)}
          </select>
          <button
            className={'btn btn-sm ' + (mineOnly ? 'btn-primary' : 'btn-ghost')}
            onClick={() => setMineOnly(v => !v)}
            aria-pressed={mineOnly}
          >
            <Icon name="clients" size={14} /> {t.mt_my_matters || 'Мої справи'}
          </button>
          <div className="seg seg-sm">
            <button className={view === 'cards' ? 'on' : ''} onClick={() => setView('cards')} aria-label={t.mt_view_cards}><Icon name="dashboard" size={14} /></button>
            <button className={view === 'table' ? 'on' : ''} onClick={() => setView('table')} aria-label={t.mt_view_table}><Icon name="menu" size={14} /></button>
          </div>
          <button className="btn btn-primary btn-sm mt-new-btn" onClick={() => setNewOpen(true)}>
            <Icon name="plus" size={14} /> {t.mt_new}
          </button>
        </div>

        {list.length === 0 ? (
          <div className="card mt-empty mt-empty-lg">
            <Icon name="folder" size={32} />
            <div>{t.mt_empty}</div>
          </div>
        ) : view === 'cards' ? (
          <div className="mt-grid">
            {list.map(m => (
              <MatterCard
                key={m.id}
                m={m}
                t={t}
                justAdded={unreadCases.has(m.id)}
                onOpen={() => {
                  setSel(m.id);
                  setTab('overview');
                  // Opening the matter clears the badge optimistically;
                  // the backend clears server-side notifications on GET.
                  setUnreadCases(s => { const n = new Set(s); n.delete(m.id); return n; });
                }} />
            ))}
          </div>
        ) : (
          <div className="card" style={{ overflow: 'visible' }}>
            <table className="lib-table mt-table">
              <thead>
                <tr>
                  <th>{t.colName}</th><th>{t.mt_filter_type}</th><th>{t.colClient}</th>
                  <th>{t.mt_filter_owner}</th><th>{t.colStatus}</th>
                  <th>{t.mt_next}</th>
                  <th style={{ textAlign: 'right' }}>{t.mt_metric_hours}</th><th></th>
                </tr>
              </thead>
              <tbody>
                {list.map(m => {
                  const meta = TYPE_META[m.type] || TYPE_META.other;
                  const tone = m.nextDeadline ? deadlineTone(m.nextDeadline.date) : null;
                  return (
                    <tr key={m.id} onClick={() => { setSel(m.id); setTab('overview'); }}>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <span className="mt-type-ic" style={{ width: 30, height: 30, background: `oklch(0.58 0.14 ${meta.hue} / 0.16)`, color: `oklch(0.46 0.14 ${meta.hue})` }}>
                            <Icon name={meta.icon} size={14} />
                          </span>
                          <span style={{ minWidth: 0 }}>
                            <span style={{ fontSize: 11, color: 'var(--text-3)', fontFeatureSettings: '"tnum"' }}>{m.code}</span>
                            <div style={{ fontWeight: 600 }}>{m.title}</div>
                          </span>
                        </div>
                      </td>
                      <td><span className="chip">{typeLabel(t, m.type)}</span></td>
                      <td style={{ color: 'var(--text-2)' }}>{m.client}</td>
                      <td><UserAvatar id={m.lead} size={26} /></td>
                      <td><StatusBadge status={m.status} t={t} size="sm" /></td>
                      <td>
                        {m.nextDeadline ? (
                          <span className={'mt-dd-inline mt-dd-' + (tone || 'ok')}>
                            {fmtDateShort(m.nextDeadline.date, t.locale)}
                          </span>
                        ) : <span style={{ color: 'var(--text-3)' }}>—</span>}
                      </td>
                      <td style={{ textAlign: 'right', fontWeight: 700, fontFeatureSettings: '"tnum"' }}>{m.hours}</td>
                      <td><Icon name="chevR" size={15} style={{ color: 'var(--text-3)' }} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <NewMatterModal open={newOpen} onClose={() => setNewOpen(false)} onCreate={createMatter} t={t} clients={clientsList} defaultLead={currentUserLegacyId} />
      <CloseMatterModal open={closeOpen} onClose={() => { setCloseOpen(false); setPendingStatus(null); }} onConfirm={confirmClose} t={t} />
    </div>
  );
}

/* ---------- Tasks (kanban) ---------- */
function TaskModal({ open, draft, onClose, onSave, onDelete, t }) {
  const [d, setD] = useState(draft || {});
  useEffect(() => { setD(draft || {}); }, [draft]);
  if (!open || !d) return null;
  const set = (k, v) => setD(p => ({ ...p, [k]: v }));
  const prios = [['high', t.prioHigh], ['med', t.prioMed], ['low', t.prioLow]];
  return (
    <Modal open={open} onClose={onClose} icon="check" title={d.id ? t.editTask : t.addTask}
      footer={<>
        {d.id ? <button className="btn btn-subtle" style={{ color: 'var(--risk-high)', marginRight: 'auto' }} onClick={() => onDelete(d.id)}><Icon name="x" size={15} /> {t.deleteBtn}</button> : null}
        <button className="btn btn-subtle" onClick={onClose}>{t.cancel}</button>
        <button className="btn btn-primary" disabled={!(d.title || '').trim()} onClick={() => onSave(d)}><Icon name="check" size={15} /> {t.save}</button>
      </>}>
      <div className="form-grid">
        <label className="field-row" style={{ gridColumn: '1 / -1' }}>
          <span className="field-label">{t.taskTitleF}</span>
          <textarea className="field" rows={2} value={d.title || ''} onChange={e => set('title', e.target.value)} autoFocus />
        </label>
        <label className="field-row">
          <span className="field-label">{t.taskMatter}</span>
          <select className="field" value={d.matter} onChange={e => set('matter', e.target.value)}>
            {LX.matters.map(m => <option key={m.code} value={m.code}>{m.code} — {m.client}</option>)}
          </select>
        </label>
        <label className="field-row">
          <span className="field-label">{t.taskAssignee}</span>
          <select className="field" value={d.assignee} onChange={e => set('assignee', e.target.value)}>
            {LX.team.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </label>
        <div className="field-row">
          <span className="field-label">{t.taskPrio}</span>
          <div className="seg seg-sm">
            {prios.map(([id, l]) => <button key={id} type="button" className={d.priority === id ? 'on' : ''} onClick={() => set('priority', id)}>{l}</button>)}
          </div>
        </div>
        <label className="field-row">
          <span className="field-label">{t.taskDue}</span>
          <input className="field" value={d.due || ''} placeholder={t.dueHint} onChange={e => set('due', e.target.value)} />
        </label>
        <div className="field-row" style={{ gridColumn: '1 / -1' }}>
          <span className="field-label">{t.taskCol}</span>
          <div className="seg seg-sm" style={{ width: 'fit-content' }}>
            {LX.kanbanCols.map(c => <button key={c.id} type="button" className={d.col === c.id ? 'on' : ''} onClick={() => set('col', c.id)}>{c.label}</button>)}
          </div>
        </div>
      </div>
    </Modal>
  );
}

function Tasks({ t }) {
  const [cards, setCards] = useState(LX.tasks);
  const [dragId, setDragId] = useState(null);
  const [overCol, setOverCol] = useState(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [draft, setDraft] = useState(null);
  const [justMoved, setJustMoved] = useState(null);

  const move = (id, col) => { setCards(cs => cs.map(c => c.id === id ? { ...c, col } : c)); setJustMoved(id); setTimeout(() => setJustMoved(null), 450); };
  const newDraft = () => ({ title: '', matter: LX.matters[0].code, assignee: 'u1', priority: 'med', col: 'todo', due: '' });
  const openNew = () => { setDraft(newDraft()); setModalOpen(true); };
  const openEdit = (c) => { setDraft(c); setModalOpen(true); };
  const save = (d) => {
    if (d.id) { setCards(cs => cs.map(c => c.id === d.id ? d : c)); toast(t.taskSaved, 'check'); }
    else { const nc = { ...d, id: 'k' + Date.now() }; setCards(cs => [nc, ...cs]); toast(t.taskCreated, 'plus'); setJustMoved(nc.id); setTimeout(() => setJustMoved(null), 450); }
    setModalOpen(false);
  };
  const del = (id) => { setCards(cs => cs.filter(c => c.id !== id)); setModalOpen(false); toast(t.taskDeleted, 'x'); };
  const complete = (e, c) => { e.stopPropagation(); if (c.col !== 'done') { move(c.id, 'done'); toast(t.taskDoneMsg, 'checkCircle'); } };

  return (
    <div className="page view-enter">
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 'var(--s5)' }}>
        <div style={{ fontSize: 13, color: 'var(--text-3)' }}><Icon name="menu" size={14} style={{ verticalAlign: '-2px' }} /> {t.moveHint}</div>
        <button className="btn btn-primary btn-sm" style={{ marginLeft: 'auto' }} onClick={openNew}><Icon name="plus" size={15} /> {t.addTask}</button>
      </div>
      <div className="kanban">
        {LX.kanbanCols.map(col => {
          const colCards = cards.filter(c => c.col === col.id);
          return (
            <div key={col.id} className={'kcol' + (overCol === col.id ? ' kcol-over' : '')}
              onDragOver={(e) => { e.preventDefault(); setOverCol(col.id); }}
              onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOverCol(null); }}
              onDrop={() => { if (dragId) move(dragId, col.id); setDragId(null); setOverCol(null); }}>
              <div className="kcol-head">
                <span className={'kcol-dot kcol-' + col.id} />{col.label}
                <span className="kcol-n">{colCards.length}</span>
              </div>
              <div className="kcol-body">
                {colCards.map(c => (
                  <div key={c.id} className={'kcard' + (dragId === c.id ? ' kcard-drag' : '') + (justMoved === c.id ? ' kcard-in' : '') + (c.col === 'done' ? ' kcard-done' : '')} draggable
                    onClick={() => openEdit(c)}
                    onDragStart={() => setDragId(c.id)} onDragEnd={() => { setDragId(null); setOverCol(null); }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 7 }}>
                      <span className="kprio" style={{ background: `color-mix(in oklab, ${prioColor[c.priority]} 16%, transparent)`, color: prioColor[c.priority] }}>
                        {{ high: t.prioHigh, med: t.prioMed, low: t.prioLow }[c.priority]}
                      </span>
                      <span className="chip" style={{ fontSize: 10.5, padding: '1px 7px' }}>{c.matter}</span>
                      <button className="kcheck" title={t.markDone} onClick={(e) => complete(e, c)}><Icon name="check" size={12} stroke={3} /></button>
                    </div>
                    <div style={{ fontSize: 13.5, fontWeight: 550, lineHeight: 1.4 }}>{c.title}</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
                      <UserAvatar id={c.assignee} size={24} />
                      <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-3)', display: 'flex', alignItems: 'center', gap: 4 }}><Icon name="clock" size={13} /> {c.due}</span>
                    </div>
                  </div>
                ))}
                <button className="kadd" onClick={() => { setDraft({ ...newDraft(), col: col.id }); setModalOpen(true); }}><Icon name="plus" size={14} /> {t.addTask}</button>
              </div>
            </div>
          );
        })}
      </div>
      <TaskModal open={modalOpen} draft={draft} t={t} onClose={() => setModalOpen(false)} onSave={save} onDelete={del} />
    </div>
  );
}

/* ---------- Time & billing ---------- */
function Billing({ t }) {
  const [running, setRunning] = useState(false);
  const [sec, setSec] = useState(0);
  const [entries, setEntries] = useState(LX.timeEntries);
  const ref = useRef(null);

  useEffect(() => {
    if (running) { ref.current = setInterval(() => setSec(s => s + 1), 1000); }
    return () => clearInterval(ref.current);
  }, [running]);

  const fmt = (s) => `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  const logTimer = () => {
    if (sec < 1) return;
    const hours = Math.max(0.1, Math.round(sec / 360) / 10);
    setEntries(e => [{ id: 'live' + Date.now(), date: '09.06', matter: 'SEV-2026-04', who: 'u1', desc: t.timer, hours, rate: 2500, billable: true }, ...e]);
    setRunning(false); setSec(0); toast(t.timeLogged, 'clock');
  };
  const weekTotal = entries.reduce((s, e) => s + (e.billable ? e.hours * e.rate : 0), 0);
  const invStatus = { paid: ['var(--risk-low)', t.invPaid], sent: ['var(--risk-med)', t.invSent], draft: ['var(--text-3)', t.invDraft] };

  return (
    <div className="page view-enter"><div className="page-narrow">
      <div className="bill-top">
        <div className="card timer-card">
          <div style={{ fontSize: 12.5, color: 'var(--text-3)', fontWeight: 600 }}>{t.timer} · SEV-2026-04</div>
          <div className={'timer-clock' + (running ? ' on' : '')}>{fmt(sec)}</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className={'btn ' + (running ? 'btn-ghost' : 'btn-primary')} onClick={() => setRunning(r => !r)} style={{ flex: 1, justifyContent: 'center' }}>
              <Icon name={running ? 'x' : 'clock'} size={16} /> {running ? t.stop : t.start}
            </button>
            <button className="btn btn-ghost" onClick={logTimer} disabled={sec < 1} style={{ justifyContent: 'center' }}><Icon name="plus" size={16} /> {t.logTime}</button>
          </div>
          {running ? <div className="timer-live"><span className="pulse" /> {t.timerRunning}</div> : null}
        </div>
        <div className="card kpi-card">
          <div className="ms-l">{t.weekTotal}</div>
          <div className="kpi-v">{weekTotal.toLocaleString('uk-UA')} ₴</div>
          <div className="ms-l" style={{ marginTop: 6 }}>{entries.filter(e => e.billable).reduce((s, e) => s + e.hours, 0).toFixed(1)} {t.mHours} · {t.billable}</div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 'var(--s4)', overflow: 'hidden' }}>
        <table className="lib-table">
          <thead><tr><th>{t.taskDue}</th><th>{t.colName}</th><th>{t.matters}</th><th></th><th style={{ textAlign: 'right' }}>{t.mHours}</th><th style={{ textAlign: 'right' }}>{t.total}</th></tr></thead>
          <tbody>
            {entries.map(e => (
              <tr key={e.id}>
                <td style={{ color: 'var(--text-3)' }}>{e.date}</td>
                <td><div style={{ fontWeight: 600 }}>{e.desc}</div>{!e.billable ? <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{t.nonBillable}</span> : null}</td>
                <td><span className="chip" style={{ fontSize: 11 }}>{e.matter}</span></td>
                <td><UserAvatar id={e.who} size={24} /></td>
                <td style={{ textAlign: 'right', fontWeight: 600 }}>{e.hours.toFixed(1)}</td>
                <td style={{ textAlign: 'right', fontWeight: 700, color: e.billable ? 'var(--text)' : 'var(--text-3)' }}>{e.billable ? (e.hours * e.rate).toLocaleString('uk-UA') + ' ₴' : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <SectionTitle action={null}><span style={{ marginTop: 'var(--s6)', display: 'block' }}>{t.invoicesTitle}</span></SectionTitle>
      <div className="card" style={{ overflow: 'hidden' }}>
        <table className="lib-table">
          <tbody>
            {LX.invoices.map(inv => {
              const [col, lbl] = invStatus[inv.status];
              return (
                <tr key={inv.id} onClick={() => toast(inv.num, 'doc')}>
                  <td style={{ fontWeight: 700 }}>{inv.num}</td>
                  <td>{inv.client}</td>
                  <td style={{ color: 'var(--text-3)' }}>{inv.period}</td>
                  <td><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600, color: col }}><span className="chip-dot" style={{ background: col }} />{lbl}</span></td>
                  <td style={{ textAlign: 'right', fontWeight: 700 }}>{inv.amount.toLocaleString('uk-UA')} ₴</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div></div>
  );
}

export { Matters, Tasks, Billing };
