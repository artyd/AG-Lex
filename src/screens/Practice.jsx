/* ============================================================
   Lexena — practice screens: Matters, Tasks (kanban), Billing
   ============================================================ */
import { useState, useEffect, useRef } from 'react';
import { Icon, Modal, SectionTitle, riskDot, toast } from '../ui/components';
import { UserAvatar, roleLabel, prioColor } from '../lib/labels';
import { DEMO } from '../data/demo';
import { LX } from '../data/lx';
import { api } from '../lib/api';

/* ---------- Matters (Phase 2.2: backed by /api/matters) ---------- */
function Matters({ t, setRoute }) {
  const D = DEMO;
  const [filter, setFilter] = useState('active');
  const [sel, setSel] = useState(null);
  // Hydrate from LX.matters so the screen renders something even before the
  // first fetch completes (and when running Vite without the FastAPI backend
  // — a dev convenience, not a production guarantee).
  const [matters, setMatters] = useState(LX.matters);

  useEffect(() => {
    let cancelled = false;
    api.matters.list()
      .then(rows => { if (!cancelled) setMatters(rows); })
      .catch(() => { /* keep the LX.matters fallback */ });
    return () => { cancelled = true; };
  }, []);

  const list = matters.filter(m => filter === 'all' ? true : m.status === filter);

  if (sel) {
    const m = matters.find(x => x.id === sel);
    const docs = D.library.filter(c => c.client === m.client);
    const mtasks = LX.tasks.filter(k => k.matter === m.code);
    return (
      <div className="page view-enter"><div className="page-narrow">
        <button className="btn btn-subtle btn-sm" onClick={() => setSel(null)} style={{ marginBottom: 'var(--s4)' }}><Icon name="chevR" size={15} style={{ transform: 'rotate(180deg)' }} /> {t.matters}</button>
        <div className="matter-detail-head card" style={{ padding: 'var(--s5)' }}>
          <span className="matter-av" style={{ background: `oklch(0.58 0.14 ${m.color})` }}><Icon name="folder" size={22} /></span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="chip">{m.code}</span><span className="chip">{m.type}</span>
              <span className={'chip'} style={{ color: m.status === 'active' ? 'var(--risk-low)' : 'var(--text-3)' }}>{m.status === 'active' ? t.mActive : t.mClosed}</span>
            </div>
            <h1 style={{ margin: '8px 0 2px', fontSize: 22, fontWeight: 700, letterSpacing: '-0.02em' }}>{m.title}</h1>
            <div style={{ color: 'var(--text-3)', fontSize: 14 }}>{m.client}</div>
          </div>
          <div className="matter-stats">
            <div><div className="ms-v">{m.docs}</div><div className="ms-l">{t.mDocs}</div></div>
            <div><div className="ms-v">{m.openTasks}</div><div className="ms-l">{t.mTasksShort}</div></div>
            <div><div className="ms-v">{m.hours}</div><div className="ms-l">{t.mHours}</div></div>
          </div>
        </div>

        <div className="dash-grid" style={{ marginTop: 'var(--s4)' }}>
          <div className="card" style={{ padding: 'var(--s5)' }}>
            <SectionTitle>{t.mDocuments}</SectionTitle>
            <div className="recent-list">
              {docs.map(c => (
                <button className="recent-row" key={c.id} onClick={() => setRoute('analyze')}>
                  <span className="recent-ic"><Icon name="doc" size={16} /></span>
                  <span style={{ flex: 1, minWidth: 0 }}><span className="recent-name">{c.name}</span><span className="recent-sub">{c.date}</span></span>
                  {riskDot(c.risk)}<Icon name="chevR" size={15} style={{ color: 'var(--text-3)' }} />
                </button>
              ))}
            </div>
            <SectionTitle action={null}><span style={{ marginTop: 'var(--s4)', display: 'block' }}>{t.mTasks}</span></SectionTitle>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {mtasks.length === 0 ? <div style={{ color: 'var(--text-3)', fontSize: 13 }}>—</div> : mtasks.map(k => (
                <div key={k.id} className="mini-task">
                  <span className="chip-dot" style={{ background: prioColor[k.priority] }} />
                  <span style={{ flex: 1, fontSize: 13.5 }}>{k.title}</span>
                  <UserAvatar id={k.assignee} size={24} />
                  <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{k.due}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="card" style={{ padding: 'var(--s5)', alignSelf: 'start' }}>
            <SectionTitle>{t.mTeam}</SectionTitle>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {[m.lead, ...LX.team.slice(1, 4).map(u => u.id)].filter((v, i, a) => a.indexOf(v) === i).map(uid => {
                const u = LX.userById[uid];
                return (
                  <div key={uid} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <UserAvatar id={uid} size={32} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13.5, fontWeight: 600 }}>{u.name}</div>
                      <div style={{ fontSize: 12, color: 'var(--text-3)' }}>{roleLabel(t, u.role)}{uid === m.lead ? ' · ' + t.mLead : ''}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div></div>
    );
  }

  return (
    <div className="page view-enter"><div className="page-narrow">
      <div style={{ display: 'flex', gap: 12, marginBottom: 'var(--s5)' }}>
        <div className="seg">
          {[['active', t.mActive], ['closed', t.mClosed], ['all', t.filterAll]].map(([id, l]) => (
            <button key={id} className={filter === id ? 'on' : ''} onClick={() => setFilter(id)}>{l}</button>
          ))}
        </div>
      </div>
      <div className="matter-grid">
        {list.map(m => (
          <button className="card matter-card" key={m.id} onClick={() => setSel(m.id)}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span className="matter-av" style={{ background: `oklch(0.58 0.14 ${m.color})` }}><Icon name="folder" size={20} /></span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <span className="chip" style={{ fontSize: 11 }}>{m.code}</span>
                <div style={{ fontWeight: 650, fontSize: 15, marginTop: 5, lineHeight: 1.3 }}>{m.title}</div>
                <div style={{ fontSize: 12.5, color: 'var(--text-3)' }}>{m.client}</div>
              </div>
            </div>
            <hr className="divider" style={{ margin: 'var(--s4) 0' }} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
              <span className="mt-stat"><b>{m.docs}</b> {t.mDocs}</span>
              <span className="mt-stat"><b style={{ color: m.openTasks ? 'var(--risk-med)' : 'var(--text-3)' }}>{m.openTasks}</b> {t.mTasksShort}</span>
              <span className="mt-stat"><b>{m.hours}</b> {t.mHours}</span>
              <span style={{ marginLeft: 'auto' }}><UserAvatar id={m.lead} size={28} /></span>
            </div>
          </button>
        ))}
      </div>
    </div></div>
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
