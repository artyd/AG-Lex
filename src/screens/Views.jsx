/* ============================================================
   Lexena — workspace views: Dashboard, Library, Clients,
   Templates, Calendar
   ============================================================ */
import { useEffect, useState } from 'react';
import { Icon } from '../ui/Icon';
import { RiskBadge, SectionTitle, riskDot, toast } from '../ui/components';
import { DEMO } from '../data/demo';
import { api } from '../lib/api';
import { RECON_HISTORY_KEY, RECON_OPEN_KEY } from '../lib/reconcileStorage';
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
        // Bug: legacy rows persisted before the analyzer's score lived in
        // `analysis.score.value`. `c.score` was stored as `0` for them, which
        // renders as "0" — looks like a real result but isn't. Treat both 0
        // and missing as "no score yet" so the UI can show an em-dash.
        const rawScore = (c.score == null || c.score === 0) ? null : Math.round(c.score);
        return {
          id: c.id,
          name: c.title || c.filename || (t.analyze || 'Договір'),
          client: c.counterparty || '—',
          type: t.contractType || 'Договір',
          status: 'done',
          risk: c.risk || 'low',
          date: dateStr,
          // null score = "не оцінено" — display layer renders "—" + muted tone.
          score: rawScore,
          // Sortable epoch the UI orders newest-first on. NaN sinks to bottom.
          dateMs: created && !isNaN(created.getTime()) ? created.getTime() : 0,
          findingsCount: c.findingsCount || 0,
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
        // Reconciliations don't carry a contract-style score. We synthesise
        // one from finding counts so the column has *something*, but rows
        // without any findings analysis (e.g. legacy localStorage entries
        // without verdict info) get null → rendered as "—" instead of "100".
        const hasVerdict = r.verdict || must > 0 || should > 0;
        const synthScore = hasVerdict
          ? Math.max(0, Math.min(100, 100 - must * 12 - should * 5))
          : null;
        merged.push({
          id: r.id,
          name: pair.product || t.reconcileTitle,
          client: pair.counterparty || '—',
          type: t.reconcileType || 'Звірка з ПД',
          status: 'done',
          risk,
          date: dateStr,
          score: synthScore,
          dateMs: created && !isNaN(created.getTime()) ? created.getTime() : 0,
          findingsCount: must + should,
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
  // PR-1 of the analyze-unification work: reconcile no longer has its own
  // route; the analyze screen pops RECON_OPEN_KEY and hydrates a run via
  // api.reconciliations.get(id).
  setRoute('analyze');
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
function Library({ t, setRoute, query, clearAnalysisIncoming }) {
  const contractRows = useContractRows(t);
  const reconRows = useReconciliationRows(t);
  const [riskFilter, setRiskFilter] = useState('all');
  const [kindFilter, setKindFilter] = useState('all'); // all | contract | recon
  const [sort, setSort] = useState('new');             // new | score | risk
  const [view, setView] = useState('grid');            // grid | list

  // Real data only — saved contracts (POST /api/analyze/contract result)
  // and reconciliations (POST /api/reconcile result). Newest first by default.
  const allItems = [...contractRows, ...reconRows];

  // Aggregate KPIs for the header strip — gives the user instant context
  // ("how big is my library, how risky on average") without scrolling.
  const stats = {
    total: allItems.length,
    contracts: contractRows.length,
    recons: reconRows.length,
    high: allItems.filter(c => c.risk === 'high').length,
    avgScore: (() => {
      const scored = allItems.filter(c => typeof c.score === 'number');
      if (!scored.length) return null;
      return Math.round(scored.reduce((a, c) => a + c.score, 0) / scored.length);
    })(),
  };

  const q = (query || '').trim().toLowerCase();
  let rows = allItems.filter(c =>
    (riskFilter === 'all' || c.risk === riskFilter) &&
    (kindFilter === 'all'
      || (kindFilter === 'contract' && c.isContract)
      || (kindFilter === 'recon' && c.isRecon)) &&
    (!q || (c.name + ' ' + c.client + ' ' + c.type).toLowerCase().includes(q))
  );
  rows = [...rows].sort((a, b) => {
    if (sort === 'score') {
      // null scores sink to the bottom regardless of direction — they're
      // "no data" rather than "low score".
      const av = typeof a.score === 'number' ? a.score : -1;
      const bv = typeof b.score === 'number' ? b.score : -1;
      return bv - av;
    }
    if (sort === 'risk') {
      const order = { high: 0, med: 1, low: 2 };
      return (order[a.risk] ?? 3) - (order[b.risk] ?? 3);
    }
    return (b.dateMs || 0) - (a.dateMs || 0);
  });

  const openRow = (c) => {
    // Library handoff sets a localStorage key and routes. The bug: App-level
    // `analysisIncoming` may still hold a payload from the previous upload
    // session, so ContractAnalysis would re-trigger analysis. Clear it first.
    if (typeof clearAnalysisIncoming === 'function') clearAnalysisIncoming();
    if (c.isRecon) openReconciliation(c.id, setRoute);
    else if (c.isContract) openContract(c.id, setRoute);
    else setRoute('analyze');
  };

  // Score colour: green / amber / red — matches the rest of the workspace.
  // Returns CSS custom property so the value tracks the theme tokens.
  const scoreColor = (v) =>
    typeof v !== 'number' ? 'var(--text-3)'
      : v >= 75 ? 'var(--risk-low)'
      : v >= 55 ? 'var(--risk-med)'
      : 'var(--risk-high)';

  // Empty state — different copy depending on whether the library is
  // empty entirely vs the current filter just returned nothing.
  const emptyMsg = allItems.length === 0
    ? (t.libEmptyAll || 'Бібліотека поки порожня. Запустіть аналіз договору, щоб додати першу перевірку.')
    : (t.libEmptyFilter || 'Жодна перевірка не відповідає поточним фільтрам.');

  return (
    <div className="page view-enter lib-page">
      <div className="page-narrow">
        {/* KPI strip — total · contracts · reconciliations · high risk · avg score */}
        <div className="lib-kpis">
          <div className="lib-kpi">
            <span className="lib-kpi-ic" style={{ color: 'var(--accent)' }}><Icon name="library" size={16} /></span>
            <span className="lib-kpi-v">{stats.total}</span>
            <span className="lib-kpi-l">{t.libKpiTotal || 'Усього перевірок'}</span>
          </div>
          <div className="lib-kpi">
            <span className="lib-kpi-ic"><Icon name="doc" size={16} /></span>
            <span className="lib-kpi-v">{stats.contracts}</span>
            <span className="lib-kpi-l">{t.libKpiContracts || 'Договори'}</span>
          </div>
          <div className="lib-kpi">
            <span className="lib-kpi-ic"><Icon name="scan" size={16} /></span>
            <span className="lib-kpi-v">{stats.recons}</span>
            <span className="lib-kpi-l">{t.libKpiRecons || 'Звірки'}</span>
          </div>
          <div className="lib-kpi">
            <span className="lib-kpi-ic" style={{ color: 'var(--risk-high)' }}><Icon name="alert" size={16} /></span>
            <span className="lib-kpi-v" style={{ color: stats.high ? 'var(--risk-high)' : undefined }}>{stats.high}</span>
            <span className="lib-kpi-l">{t.libKpiHigh || 'Високий ризик'}</span>
          </div>
          <div className="lib-kpi">
            <span className="lib-kpi-ic"><Icon name="sparkle" size={16} fill={true} /></span>
            <span className="lib-kpi-v" style={{ color: scoreColor(stats.avgScore) }}>
              {stats.avgScore == null ? '—' : stats.avgScore}
            </span>
            <span className="lib-kpi-l">{t.libKpiAvg || 'Середня оцінка'}</span>
          </div>
        </div>

        {/* Toolbar — kind tabs · risk filter · sort · view · upload */}
        <div className="lib-toolbar">
          <div className="seg lib-seg">
            <button className={kindFilter === 'all' ? 'on' : ''} onClick={() => setKindFilter('all')}>
              {t.libAll || 'Усі'}
            </button>
            <button className={kindFilter === 'contract' ? 'on' : ''} onClick={() => setKindFilter('contract')}>
              <Icon name="doc" size={13} /> {t.libContracts || 'Договори'}
            </button>
            <button className={kindFilter === 'recon' ? 'on' : ''} onClick={() => setKindFilter('recon')}>
              <Icon name="scan" size={13} /> {t.libRecons || 'Звірки'}
            </button>
          </div>

          <div className="seg lib-seg lib-seg-risk">
            <button className={riskFilter === 'all' ? 'on' : ''} onClick={() => setRiskFilter('all')}>
              {t.filterAll}
            </button>
            <button className={riskFilter === 'high' ? 'on high' : ''} onClick={() => setRiskFilter('high')}>
              <span className="lib-dot" style={{ background: 'var(--risk-high)' }} /> {t.riskHigh}
            </button>
            <button className={riskFilter === 'med' ? 'on med' : ''} onClick={() => setRiskFilter('med')}>
              <span className="lib-dot" style={{ background: 'var(--risk-med)' }} /> {t.riskMed}
            </button>
            <button className={riskFilter === 'low' ? 'on low' : ''} onClick={() => setRiskFilter('low')}>
              <span className="lib-dot" style={{ background: 'var(--risk-low)' }} /> {t.riskLow}
            </button>
          </div>

          {q ? <span className="chip"><Icon name="search" size={12} /> «{query}»</span> : null}

          <div className="lib-toolbar-right">
            <select className="lib-sort" value={sort} onChange={e => setSort(e.target.value)} aria-label={t.libSort || 'Сортування'}>
              <option value="new">{t.libSortNew || 'Спочатку нові'}</option>
              <option value="score">{t.libSortScore || 'За оцінкою'}</option>
              <option value="risk">{t.libSortRisk || 'За ризиком'}</option>
            </select>
            <div className="seg lib-view-toggle">
              <button className={view === 'grid' ? 'on' : ''} onClick={() => setView('grid')} aria-label={t.libGrid || 'Сітка'}>
                <Icon name="dashboard" size={14} />
              </button>
              <button className={view === 'list' ? 'on' : ''} onClick={() => setView('list')} aria-label={t.libList || 'Список'}>
                <Icon name="filter" size={14} />
              </button>
            </div>
            <button className="btn btn-primary btn-sm" onClick={() => setRoute('analyze')}>
              <Icon name="upload" size={15} /> {t.upload}
            </button>
          </div>
        </div>

        {rows.length === 0 ? (
          <div className="card lib-empty">
            <span className="lib-empty-ic"><Icon name="library" size={28} /></span>
            <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 4 }}>
              {t.libEmptyTitle || 'Тут поки нічого немає'}
            </div>
            <div style={{ fontSize: 13.5, color: 'var(--text-3)', maxWidth: 380 }}>{emptyMsg}</div>
            <button className="btn btn-primary btn-sm" style={{ marginTop: 14 }} onClick={() => setRoute('analyze')}>
              <Icon name="upload" size={15} /> {t.upload}
            </button>
          </div>
        ) : view === 'grid' ? (
          <div className="lib-grid">
            {rows.map(c => (
              <button key={c.id} className={'lib-card lib-card-' + c.risk + (c.isRecon ? ' lib-card-recon' : '')} onClick={() => openRow(c)}>
                <span className="lib-stripe" />
                <div className="lib-card-head">
                  <span className={'lib-ic' + (c.isRecon ? ' lib-ic-recon' : '')}>
                    <Icon name={c.isRecon ? 'scan' : 'doc'} size={16} />
                  </span>
                  <span className="lib-kind-chip">
                    {c.isRecon ? (t.libRecons || 'Звірка') : (t.libContracts || 'Договір')}
                  </span>
                  <RiskBadge level={c.risk} t={t} />
                </div>
                <div className="lib-card-title">{c.name}</div>
                <div className="lib-card-sub">{c.client}</div>
                <div className="lib-card-foot">
                  <div className="lib-score" style={{ color: scoreColor(c.score) }}>
                    {typeof c.score === 'number' ? (
                      <>
                        <span className="lib-score-v">{c.score}</span>
                        <span className="lib-score-l">{t.colScore || 'Оцінка'}</span>
                      </>
                    ) : (
                      <>
                        <span className="lib-score-v lib-score-na">—</span>
                        <span className="lib-score-l">{t.libNoScore || 'Без оцінки'}</span>
                      </>
                    )}
                  </div>
                  <div className="lib-meta">
                    {c.findingsCount ? (
                      <span className="lib-meta-bit" title={t.libFindings || 'Зауваження'}>
                        <Icon name="alert" size={11} /> {c.findingsCount}
                      </span>
                    ) : null}
                    <span className="lib-meta-bit lib-meta-date">
                      <Icon name="calendar" size={11} /> {c.date}
                    </span>
                  </div>
                </div>
                <span className="lib-card-arrow" aria-hidden="true"><Icon name="chevR" size={14} /></span>
              </button>
            ))}
          </div>
        ) : (
          <div className="card lib-list-card">
            <table className="lib-table lib-table-pretty">
              <thead>
                <tr>
                  <th>{t.colName}</th>
                  <th>{t.colClient}</th>
                  <th>{t.colType}</th>
                  <th>{t.colDate || 'Дата'}</th>
                  <th>{t.colRisk}</th>
                  <th style={{ textAlign: 'right' }}>{t.colScore}</th>
                  <th aria-hidden="true"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map(c => (
                  <tr key={c.id} onClick={() => openRow(c)} className={'lib-row lib-row-' + c.risk}>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <span className={'lib-ic' + (c.isRecon ? ' lib-ic-recon' : '')}>
                          <Icon name={c.isRecon ? 'scan' : 'doc'} size={15} />
                        </span>
                        <span style={{ fontWeight: 600 }}>{c.name}</span>
                      </div>
                    </td>
                    <td style={{ color: 'var(--text-2)' }}>{c.client}</td>
                    <td><span className="chip">{c.type}</span></td>
                    <td style={{ color: 'var(--text-3)', fontFamily: 'var(--font-mono)', fontSize: 12.5 }}>{c.date}</td>
                    <td><RiskBadge level={c.risk} t={t} /></td>
                    <td style={{ textAlign: 'right', fontWeight: 700, color: scoreColor(c.score) }}>
                      {typeof c.score === 'number' ? c.score : <span style={{ color: 'var(--text-3)', fontWeight: 500 }}>—</span>}
                    </td>
                    <td><Icon name="chevR" size={16} style={{ color: 'var(--text-3)' }} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
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
// DEPRECATED — replaced by screens/practice/CalendarTasks per refactor 2026-06
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

// Calendar is deprecated as a standalone view per refactor 2026-06
// — the merged Calendar+Tasks lives in screens/practice/CalendarTasks.
export { Dashboard, Library, Clients, Templates };
