/* ============================================================
   Lexena — workspace views: Dashboard, Library, Clients,
   Templates, Calendar
   ============================================================ */
import { useCallback, useEffect, useState } from 'react';
import { Icon } from '../ui/Icon';
import { Modal, RiskBadge, toast } from '../ui/components';
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

  // Оптимистичное удаление: сначала убираем строку локально (UI мгновенный),
  // потом стучимся в бэкенд. Если 4xx/5xx — откатываем к предыдущему стейту
  // и показываем ошибку. Отдельный snapshot нужен потому, что параллельный
  // update стейта из useEffect выше может подгрузить свежий список — не
  // хотим восстанавливать удалённую строку из-за того, что список
  // перезагрузился до нашего api.remove.
  const remove = useCallback(async (id) => {
    let prev = null;
    setRows((cur) => { prev = cur; return cur.filter(r => r.id !== id); });
    try {
      await api.contracts.remove(id);
      return true;
    } catch (_e) {
      if (prev) setRows(prev);
      return false;
    }
  }, []);

  return { rows, remove };
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

  // Same optimistic-remove pattern as useContractRows: strip locally, hit
  // backend, revert on failure. Also drop the id from the localStorage
  // history fallback so a page reload doesn't resurrect the row.
  const remove = useCallback(async (id) => {
    let prev = null;
    setRows((cur) => { prev = cur; return cur.filter(r => r.id !== id); });
    try {
      try { await api.reconciliations.remove(id); } catch (_e) { /* row may live only in local history */ }
      try {
        const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(RECON_HISTORY_KEY) : null;
        const local = raw ? JSON.parse(raw) : [];
        const next = (local || []).filter(r => r && r.id !== id);
        if (typeof localStorage !== 'undefined') localStorage.setItem(RECON_HISTORY_KEY, JSON.stringify(next));
      } catch (_e) {}
      return true;
    } catch (_e) {
      if (prev) setRows(prev);
      return false;
    }
  }, []);

  return { rows, remove };
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
function Library({ t, setRoute, query, clearAnalysisIncoming, onLibraryChange }) {
  const { rows: contractRows, remove: removeContract } = useContractRows(t);
  const { rows: reconRows, remove: removeReconciliation } = useReconciliationRows(t);
  const [riskFilter, setRiskFilter] = useState('all');
  const [kindFilter, setKindFilter] = useState('all'); // all | contract | recon
  const [sort, setSort] = useState('new');             // new | score | risk
  const [view, setView] = useState('grid');            // grid | list
  // { id, name } | null — держим отдельный state вместо inline confirm, чтобы
  // клик по «Видалити» на карточке не открывал сам договор (stopPropagation +
  // отдельный overlay-модал в конце Library JSX).
  const [pendingDelete, setPendingDelete] = useState(null);

  // Real data only — saved contracts (POST /api/analyze/contract result)
  // and reconciliations (POST /api/reconcile result). Newest first by default.
  const allItems = [...contractRows, ...reconRows];

  // Всякий раз, когда меняется список контрактов (первый fetch, delete),
  // сообщаем App — сайдбар обновит счётчик «Бібліотека N». Reconciliations
  // не считаем: сайдбарный счётчик показывает именно договоры.
  useEffect(() => {
    if (typeof onLibraryChange === 'function') {
      onLibraryChange(contractRows.length);
    }
  }, [contractRows.length, onLibraryChange]);

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    const { id, isRecon } = pendingDelete;
    setPendingDelete(null);
    const ok = isRecon ? await removeReconciliation(id) : await removeContract(id);
    toast(
      ok ? (t.contractDeleted || 'Перевірку видалено') : (t.contractDeleteFailed || 'Не вдалося видалити'),
      ok ? 'check' : 'alert',
    );
  };

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
              // Обе категории (договір і звірка) переворачиваются на hover/
              // focus и показывают back-face с open/delete. Раньше для recon
              // flip был отключён — теперь юрист может удалить звірку прямо
              // из библиотеки, точно как договір.
              <div
                key={c.id}
                className={
                  'lib-card lib-card-' + c.risk
                  + (c.isRecon ? ' lib-card-recon' : '')
                  + ' lib-card-flippable'
                }>
                <div className="lib-card-inner">
                  <button
                    type="button"
                    className="lib-card-face lib-card-front lib-card-open"
                    onClick={() => openRow(c)}
                    aria-label={c.name}>
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
                  <div className="lib-card-face lib-card-back">
                    <button
                      type="button"
                      className="lib-card-back-btn lib-card-back-open"
                      onClick={() => openRow(c)}>
                      <Icon name="folder" size={26} />
                      <span>{t.openContract || 'Відкрити'}</span>
                    </button>
                    <button
                      type="button"
                      className="lib-card-back-btn lib-card-back-del"
                      onClick={() => setPendingDelete({ id: c.id, name: c.name, isRecon: !!c.isRecon })}>
                      <Icon name="trash" size={26} />
                      <span>{t.deleteContract || 'Видалити'}</span>
                    </button>
                  </div>
                </div>
              </div>
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
                  <th aria-hidden="true" style={{ width: 32 }}></th>
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
                    <td onClick={(e) => e.stopPropagation()}>
                      <button
                        type="button"
                        className="lib-row-del"
                        aria-label={t.deleteContract || 'Видалити'}
                        title={t.deleteContract || 'Видалити'}
                        onClick={() => setPendingDelete({ id: c.id, name: c.name, isRecon: !!c.isRecon })}>
                        <Icon name="trash" size={13} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Modal
        open={!!pendingDelete}
        onClose={() => setPendingDelete(null)}
        title={t.confirmDeleteTitle || 'Видалити перевірку?'}
        sub={pendingDelete ? pendingDelete.name : ''}
        icon="trash"
        footer={
          <>
            <button className="btn btn-subtle" onClick={() => setPendingDelete(null)}>
              {t.cancel || 'Скасувати'}
            </button>
            <button
              className="btn btn-primary"
              style={{ background: 'var(--risk-high)', borderColor: 'var(--risk-high)' }}
              onClick={confirmDelete}>
              <Icon name="trash" size={14} /> {t.deleteConfirmBtn || 'Видалити'}
            </button>
          </>
        }>
        <p style={{ margin: 0, color: 'var(--text-2)', fontSize: 14, lineHeight: 1.55 }}>
          {t.confirmDeleteSub
            || 'Ви впевнені, що хочете видалити цю перевірку? Дію не можна скасувати.'}
        </p>
      </Modal>
    </div>
  );
}

// Calendar / Clients / Templates were dead demo-only components — removed
// per refactor 2026-06 (CalendarTasks + real /api entities took over).
export { Dashboard, Library };
