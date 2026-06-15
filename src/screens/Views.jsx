/* ============================================================
   Lexena — workspace views: Dashboard, Library, Clients,
   Templates, Calendar
   ============================================================ */
import { useEffect, useState } from 'react';
import { Icon } from '../ui/Icon';
import { RiskBadge, SectionTitle, riskDot, toast } from '../ui/components';
import { DEMO } from '../data/demo';
import { api } from '../lib/api';
import { RECON_HISTORY_KEY, RECON_OPEN_KEY } from './Reconcile';
import { WidgetGrid } from './WidgetGrid';

/* ---------- Persisted contract analyses → library rows ----------
   Phase 3.2: `/api/contracts` is the source of truth for single-contract
   analyses saved by ContractAnalysis after a successful upload+analyze. */
const CONTRACT_OPEN_KEY = 'lex.contract.open';

function useContractRows(t) {
  const [rows, setRows] = useState([]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let backend = [];
      try { backend = await api.contracts.list(); } catch (_e) {}
      const out = (backend || []).map(c => {
        const created = c.createdAt ? new Date(c.createdAt) : null;
        const dateStr = created && !isNaN(created.getTime())
          ? created.toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit', year: 'numeric' })
          : '—';
        return {
          id: c.id,
          name: c.title || c.filename || (t.analyze || 'Договір'),
          client: c.counterparty || '—',
          type: t.contractType || 'Договір',
          status: 'done',
          risk: c.risk || 'low',
          date: dateStr,
          score: Math.round(c.score || 0),
          isContract: true,
        };
      });
      if (!cancelled) setRows(out);
    })();
    return () => { cancelled = true; };
  }, [t.contractType, t.analyze]);
  return rows;
}

function openContract(id, setRoute) {
  try { localStorage.setItem(CONTRACT_OPEN_KEY, id); } catch (_e) {}
  setRoute('analyze');
}

/* ---------- Reconciliations → library rows ----------
   Merges backend `/api/reconciliations` with the localStorage fallback
   (`lex.recon.history`). Backend wins on id-collision. Maps each run to the
   same row shape the Library table already renders. */
function useReconciliationRows(t) {
  const [rows, setRows] = useState([]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let backend = [];
      try { backend = await api.reconciliations.list(); } catch (_e) {}
      let local = [];
      try {
        const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(RECON_HISTORY_KEY) : null;
        local = raw ? JSON.parse(raw) : [];
      } catch (_e) {}
      const seen = new Set();
      const merged = [];
      const push = (r) => {
        if (!r || !r.id || seen.has(r.id)) return;
        seen.add(r.id);
        const pair = r.pair || {};
        const must = r.mustCount || 0;
        const should = r.shouldCount || 0;
        const risk = r.verdict === 'critical' ? 'high' : r.verdict === 'minor' ? 'med' : 'low';
        const created = r.createdAt ? new Date(r.createdAt) : null;
        const dateStr = created && !isNaN(created.getTime())
          ? created.toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit', year: 'numeric' })
          : '—';
        merged.push({
          id: r.id,
          name: pair.product || t.reconcileTitle,
          client: pair.counterparty || '—',
          type: t.reconcileType || 'Звірка з ПД',
          status: 'done',
          risk,
          date: dateStr,
          score: Math.max(0, 100 - must * 12 - should * 5),
          isRecon: true,
        });
      };
      (backend || []).forEach(push);
      (local || []).forEach(push);
      if (!cancelled) setRows(merged);
    })();
    return () => { cancelled = true; };
  }, [t.reconcileType, t.reconcileTitle]);
  return rows;
}

function openReconciliation(id, setRoute) {
  try { localStorage.setItem(RECON_OPEN_KEY, id); } catch (_e) {}
  setRoute('reconcile');
}

/* ---------- Dashboard ----------
   The dashboard is now a full-canvas widget constructor.
   The grid is the only content of the page and fills the viewport. */
function Dashboard({ t, setRoute, user }) {
  return (
    <div className="page page-dashboard view-enter">
      <WidgetGrid t={t} setRoute={setRoute} user={user} />
    </div>
  );
}

/* ---------- Library ---------- */
function Library({ t, setRoute, query }) {
  const contractRows = useContractRows(t);
  const reconRows = useReconciliationRows(t);
  const [filter, setFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState('all');
  const [typeOpen, setTypeOpen] = useState(false);
  // Real data only — saved contracts (POST /api/analyze/contract result)
  // and reconciliations (POST /api/reconcile result). DEMO.library was a
  // placeholder for the pre-persistence UI and is no longer mixed in.
  const allItems = [...contractRows, ...reconRows];
  const types = ['all', ...Array.from(new Set(allItems.map(c => c.type)))];
  const filters = [
    { id: 'all', label: t.filterAll },
    { id: 'review', label: t.statusReview },
    { id: 'done', label: t.statusDone },
    { id: 'draft', label: t.statusDraft },
  ];
  const statusLabel = { review: t.statusReview, done: t.statusDone, draft: t.statusDraft };
  const statusTone = { review: 'var(--risk-med)', done: 'var(--risk-low)', draft: 'var(--text-3)' };
  const q = (query || '').trim().toLowerCase();
  const rows = allItems.filter(c =>
    (filter === 'all' || c.status === filter) &&
    (typeFilter === 'all' || c.type === typeFilter) &&
    (!q || (c.name + ' ' + c.client + ' ' + c.type).toLowerCase().includes(q))
  );
  const openRow = (c) => {
    if (c.isRecon) openReconciliation(c.id, setRoute);
    else if (c.isContract) openContract(c.id, setRoute);
    else setRoute('analyze');
  };

  return (
    <div className="page view-enter">
      <div className="page-narrow">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 'var(--s5)', flexWrap: 'wrap' }}>
          <div className="seg">
            {filters.map(f => (
              <button key={f.id} className={filter === f.id ? 'on' : ''} onClick={() => setFilter(f.id)}>{f.label}</button>
            ))}
          </div>
          <div style={{ position: 'relative' }}>
            <button className="btn btn-ghost btn-sm" onClick={() => setTypeOpen(o => !o)}>
              <Icon name="filter" size={15} /> {typeFilter === 'all' ? t.colType : typeFilter} <Icon name="chevD" size={14} />
            </button>
            {typeOpen && (
              <div className="menu" style={{ top: 'calc(100% + 6px)', left: 0, minWidth: 180 }} onMouseLeave={() => setTypeOpen(false)}>
                {types.map(ty => (
                  <button key={ty} className={'menu-item' + (typeFilter === ty ? ' on' : '')} onClick={() => { setTypeFilter(ty); setTypeOpen(false); }}>
                    {ty === 'all' ? t.allTypes : ty}
                    {typeFilter === ty ? <Icon name="check" size={14} /> : null}
                  </button>
                ))}
              </div>
            )}
          </div>
          {q ? <span className="chip"><Icon name="search" size={12} /> «{query}»</span> : null}
          <button className="btn btn-primary btn-sm" style={{ marginLeft: 'auto' }} onClick={() => setRoute('analyze')}><Icon name="upload" size={15} /> {t.upload}</button>
        </div>

        <div className="card" style={{ overflow: 'visible' }}>
          <table className="lib-table">
            <thead>
              <tr>
                <th>{t.colName}</th><th>{t.colClient}</th><th>{t.colType}</th>
                <th>{t.colStatus}</th><th>{t.colRisk}</th><th style={{ textAlign: 'right' }}>{t.colScore}</th><th></th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr><td colSpan={7} style={{ textAlign: 'center', padding: 'var(--s8)', color: 'var(--text-3)' }}>{t.searchEmpty}</td></tr>
              ) : rows.map(c => (
                <tr key={c.id} onClick={() => openRow(c)} className={c.current ? 'row-current' : ''}>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span className={'lib-ic' + (c.isHandover ? ' lib-ic-handover' : '')}>
                        <Icon name={c.isRecon ? 'scan' : c.isHandover ? 'folder' : 'doc'} size={15} />
                      </span>
                      <span style={{ fontWeight: 600 }}>{c.name}{c.current ? <span className="now-tag">{t.nowTag}</span> : null}</span>
                    </div>
                  </td>
                  <td style={{ color: 'var(--text-2)' }}>{c.client}</td>
                  <td><span className="chip">{c.type}</span></td>
                  <td><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600, color: statusTone[c.status] }}><span className="chip-dot" style={{ background: statusTone[c.status] }} />{statusLabel[c.status]}</span></td>
                  <td><RiskBadge level={c.risk} t={t} /></td>
                  <td style={{ textAlign: 'right', fontWeight: 700, color: c.score >= 75 ? 'var(--risk-low)' : c.score >= 55 ? 'var(--risk-med)' : 'var(--risk-high)' }}>{c.score}</td>
                  <td><Icon name="chevR" size={16} style={{ color: 'var(--text-3)' }} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/* ---------- Clients ---------- */
function Clients({ t, setRoute }) {
  const D = DEMO;
  return (
    <div className="page view-enter">
      <div className="page-narrow">
        <div className="client-grid">
          {D.clients.map(cl => (
            <button className="card client-card" key={cl.id} onClick={() => setRoute('library')}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span className="client-av" style={{ background: `oklch(0.58 0.14 ${cl.color})` }}>{cl.name.replace(/[«»ООО ТДИПSky LabsInc.]/g, '').trim().charAt(0) || cl.name.charAt(0)}</span>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 650, fontSize: 15, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{cl.name}</div>
                  <div style={{ fontSize: 12.5, color: 'var(--text-3)' }}>{t.sector}: {cl.sector}</div>
                </div>
              </div>
              <hr className="divider" style={{ margin: 'var(--s4) 0' }} />
              <div style={{ display: 'flex', gap: 18 }}>
                <div><div className="client-num">{cl.contracts}</div><div className="client-num-lbl">{t.contractsCount}</div></div>
                <div><div className="client-num" style={{ color: cl.open ? 'var(--risk-med)' : 'var(--text-3)' }}>{cl.open}</div><div className="client-num-lbl">{t.openCount}</div></div>
                <span className="client-folder"><Icon name="folder" size={18} /></span>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ---------- Templates ---------- */
function Templates({ t }) {
  const D = DEMO;
  return (
    <div className="page view-enter">
      <div className="page-narrow">
        <div className="tpl-grid">
          {D.templates.map(tp => (
            <div className="card tpl-card" key={tp.id}>
              <div className="tpl-thumb"><Icon name="templates" size={26} /></div>
              <div style={{ padding: 'var(--s4)' }}>
                <span className="chip" style={{ marginBottom: 8 }}>{tp.cat}</span>
                <div style={{ fontWeight: 650, fontSize: 14.5, marginBottom: 4, lineHeight: 1.3 }}>{tp.name}</div>
                <div style={{ fontSize: 12, color: 'var(--text-3)' }}>{tp.uses} {t.uses} · {tp.fields} {t.fields}</div>
                <button className="btn btn-ghost btn-sm" style={{ marginTop: 12, width: '100%', justifyContent: 'center' }} onClick={() => toast(t.tplUsed + ': ' + tp.name, 'doc')}><Icon name="plus" size={14} /> {t.useTemplate}</button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ---------- Calendar ---------- */
function Calendar({ t }) {
  const D = DEMO;
  const baseYear = 2026, baseMonth = 5; // June (0-idx)
  const TODAY = new Date(2026, 5, 9);
  const [offset, setOffset] = useState(0);
  const [selDay, setSelDay] = useState(null);
  const view = new Date(baseYear, baseMonth + offset, 1);
  const year = view.getFullYear(), month = view.getMonth();
  const isBase = offset === 0;
  const startDow = (new Date(year, month, 1).getDay() + 6) % 7; // Monday-first
  const days = new Date(year, month + 1, 0).getDate();

  // tasks for the viewed month (any month, incl. auto-added deadlines)
  const byDay = {};
  D.tasks.forEach(tk => { const d = new Date(tk.date); if (d.getFullYear() === year && d.getMonth() === month) (byDay[d.getDate()] = byDay[d.getDate()] || []).push(tk); });
  const dows = t.locale === 'en-GB' ? ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'] : ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Нд'];
  const cells = [];
  for (let i = 0; i < startDow; i++) cells.push(null);
  for (let d = 1; d <= days; d++) cells.push(d);
  const riskBg = { high: 'var(--risk-high)', med: 'var(--risk-med)', low: 'var(--risk-low)' };

  const nav = (delta) => { setOffset(o => o + delta); setSelDay(null); };
  const goToTask = (tk) => { const d = new Date(tk.date); setOffset((d.getFullYear() - baseYear) * 12 + (d.getMonth() - baseMonth)); setSelDay(d.getDate()); };

  const allSorted = [...D.tasks].sort((a, b) => a.date.localeCompare(b.date));
  const selEvents = selDay != null ? (byDay[selDay] || []) : null;

  return (
    <div className="page view-enter">
      <div className="page-narrow cal-layout">
        <div className="card" style={{ padding: 'var(--s5)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--s4)' }}>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>{t.monthNames[month]} {year}</h2>
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="icon-btn" style={{ width: 32, height: 32 }} onClick={() => nav(-1)} aria-label="prev"><Icon name="chevR" size={16} style={{ transform: 'rotate(180deg)' }} /></button>
              {!isBase ? <button className="btn btn-ghost btn-sm" onClick={() => { setOffset(0); setSelDay(null); }}>{t.today}</button> : null}
              <button className="icon-btn" style={{ width: 32, height: 32 }} onClick={() => nav(1)} aria-label="next"><Icon name="chevR" size={16} /></button>
            </div>
          </div>
          <div className="cal-grid cal-dows">{dows.map(d => <div key={d} className="cal-dow">{d}</div>)}</div>
          <div className="cal-grid">
            {cells.map((d, i) => {
              if (d == null) return <div key={i} className="cal-cell cal-empty" />;
              const evs = byDay[d] || [];
              const isToday = isBase && d === 9;
              const isSel = selDay === d;
              return (
                <button key={i} className={'cal-cell' + (isToday ? ' cal-today' : '') + (isSel ? ' cal-sel' : '') + (evs.length ? ' cal-has' : '')}
                  onClick={() => setSelDay(isSel ? null : d)}>
                  <span className="cal-daynum">{d}</span>
                  <div className="cal-chips">
                    {evs.slice(0, 2).map(tk => (
                      <span key={tk.id} className="cal-chip" style={{ background: `color-mix(in oklab, ${riskBg[tk.risk]} 16%, transparent)`, color: riskBg[tk.risk] }}>{tk.title}</span>
                    ))}
                    {evs.length > 2 ? <span className="cal-more">+{evs.length - 2}</span> : null}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        <div className="card" style={{ padding: 'var(--s5)', alignSelf: 'start' }}>
          {selEvents ? (
            <>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--s4)' }}>
                <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>{selDay} {t.monthNames[month]}</h2>
                <button className="btn btn-subtle btn-sm" onClick={() => setSelDay(null)}>{t.upcoming}</button>
              </div>
              {selEvents.length === 0
                ? <div style={{ color: 'var(--text-3)', fontSize: 13, padding: '12px 0' }}>{t.noTasks || '—'}</div>
                : <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {selEvents.map(tk => (
                      <div key={tk.id} className="mini-task">
                        <span className="chip-dot" style={{ background: riskBg[tk.risk] }} />
                        <div style={{ flex: 1 }}><div style={{ fontSize: 13.5, fontWeight: 600 }}>{tk.title}</div><div style={{ fontSize: 12, color: 'var(--text-3)' }}>{tk.client}</div></div>
                      </div>
                    ))}
                  </div>}
            </>
          ) : (
            <>
              <SectionTitle>{t.upcoming}</SectionTitle>
              <div className="timeline">
                {allSorted.map(tk => {
                  const d = new Date(tk.date);
                  const dd = d.toLocaleDateString(t.locale, { day: '2-digit' });
                  const mo = d.toLocaleDateString(t.locale, { month: 'short' });
                  const isPast = d < TODAY;
                  return (
                    <button className="tl-row tl-click" key={tk.id} onClick={() => goToTask(tk)}>
                      <div className="tl-date"><b>{dd}</b><span>{mo}</span></div>
                      <span className="tl-dot" style={{ background: riskBg[tk.risk] }} />
                      <div style={{ minWidth: 0, flex: 1, textAlign: 'left' }}>
                        <div style={{ fontSize: 13.5, fontWeight: 600, lineHeight: 1.35 }}>{tk.title}</div>
                        <div style={{ fontSize: 12, color: 'var(--text-3)' }}>{tk.client}</div>
                      </div>
                      {isPast ? <span className="badge-risk badge-high">{t.overdue}</span> : null}
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export { Dashboard, Library, Clients, Templates, Calendar };
