/* ============================================================
   AG Lex — Contract ↔ Handover (Table 3) reconciliation
   Visual port from the Claude Design prototype:
     hub-back / hub-head / cmp-slots / cmp-vs / cmp-pairs (upload)
     analyzing overlay (5 steps)
     analysis-bar + analysis-body (result):
       cmp-doctabs + cmp-paper + cmark-* highlights
       cmp-scroll table view (cmp-rows / cmp-row / cmp-badge)
       cmp-panel + cmp-counters + cmp-find (right side)
   Behavior unchanged: real <input type=file>, POST /api/reconcile via
   api.reconcile(formData), localStorage history, demo fixture fallback,
   addEditsToTasks via api.tasks.create, library handoff via RECON_OPEN_KEY.
   ============================================================ */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../ui/Icon';
import { toast } from '../ui/components';
import { api } from '../lib/api';
import { DEMO } from '../data/demo';

const RECON_HISTORY_KEY = 'lex.recon.history';
const RECON_OPEN_KEY = 'lex.recon.open';

const CMP_STATUS = {
  ok:       { key: 'cmpOk',       col: 'var(--risk-low)',  bg: 'var(--risk-low-soft)',  ic: 'checkCircle' },
  mismatch: { key: 'cmpMismatch', col: 'var(--risk-high)', bg: 'var(--risk-high-soft)', ic: 'alert' },
  flag:     { key: 'cmpFlag',     col: 'var(--risk-med)',  bg: 'var(--risk-med-soft)',  ic: 'alert' },
  absent:   { key: 'cmpAbsent',   col: 'var(--text-3)',    bg: 'var(--bg-2)',           ic: 'x' },
  positive: { key: 'cmpPositive', col: 'var(--accent)',    bg: 'var(--accent-soft)',    ic: 'plus' },
};

const SEV = {
  must:   { key: 'cmpMust',   col: 'var(--risk-high)', bg: 'var(--risk-high-soft)' },
  should: { key: 'cmpShould', col: 'var(--risk-med)',  bg: 'var(--risk-med-soft)' },
  nice:   { key: 'cmpNice',   col: 'var(--risk-low)',  bg: 'var(--risk-low-soft)' },
  flag:   { key: 'cmpFlagL',  col: 'var(--accent)',    bg: 'var(--accent-soft)' },
};

function popOpenRunId() {
  if (typeof localStorage === 'undefined') return null;
  const raw = localStorage.getItem(RECON_OPEN_KEY);
  if (!raw) return null;
  try { localStorage.removeItem(RECON_OPEN_KEY); } catch (_e) {}
  return raw;
}

function loadHistory() {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(RECON_HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (_e) { return []; }
}

function saveHistory(run) {
  if (typeof localStorage === 'undefined') return;
  const prev = loadHistory().filter(r => r.id !== run.id);
  const next = [run, ...prev].slice(0, 20);
  try { localStorage.setItem(RECON_HISTORY_KEY, JSON.stringify(next)); } catch (_e) {}
}

/* ---------- Upload step ---------- */
function UploadStep({ t, onRun, onBack, demoPair }) {
  const [cFile, setCFile] = useState(null);
  const [hFile, setHFile] = useState(null);
  const [usePair, setUsePair] = useState(true);
  const cRef = useRef(null);
  const hRef = useRef(null);

  const canRun = (cFile && hFile) || usePair;

  const run = () => {
    if (cFile && hFile) {
      onRun({ contractFile: cFile, handoverFile: hFile, demo: false });
    } else if (usePair) {
      onRun({
        contractFile: new File([''], demoPair.contractFile || 'contract.docx'),
        handoverFile: new File([''], demoPair.handoverFile || 'handover.xlsx'),
        demo: true,
      });
    }
  };

  const contractLabel = cFile ? cFile.name : (usePair ? demoPair.contractFile : t.cmpSlotHint);
  const handoverLabel = hFile ? hFile.name : (usePair ? demoPair.handoverFile : t.cmpSlotHint);

  return (
    <div className="page view-enter">
      <div className="page-narrow">
        <button className="hub-back" onClick={onBack}><Icon name="chevR" size={16} style={{ transform: 'rotate(180deg)' }} /> {t.cmpBack}</button>
        <div className="hub-head" style={{ textAlign: 'left', marginTop: 6 }}>
          <h1 className="hub-title" style={{ fontSize: 24 }}>{t.cmpUploadTitle}</h1>
          <p className="hub-sub" style={{ margin: '6px 0 0' }}>{t.cmpUploadSub}</p>
        </div>

        <div className="cmp-slots">
          <div className="cmp-slot">
            <div className="cmp-slot-tag"><Icon name="doc" size={14} /> {t.cmpSlotContract}</div>
            <input ref={cRef} type="file" accept=".pdf,.docx" style={{ display: 'none' }}
                   onChange={e => { setCFile(e.target.files[0] || null); setUsePair(false); }} />
            <button className="cmp-drop" onClick={() => cRef.current && cRef.current.click()}>
              <span className="cmp-file-ic"><Icon name={cFile ? 'doc' : 'upload'} size={18} /></span>
              <span style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                <span className="cmp-file-name">{contractLabel}</span>
                <span className="cmp-file-meta">{cFile ? t.cmpUploadedFile : t.cmpSlotHint}</span>
              </span>
              {cFile ? <span className="cmp-check">✓</span> : null}
            </button>
          </div>
          <div className="cmp-vs"><Icon name="scan" size={18} /></div>
          <div className="cmp-slot">
            <div className="cmp-slot-tag"><Icon name="folder" size={14} /> {t.cmpSlotHandover}</div>
            <input ref={hRef} type="file" accept=".pdf,.docx,.xlsx" style={{ display: 'none' }}
                   onChange={e => { setHFile(e.target.files[0] || null); setUsePair(false); }} />
            <button className="cmp-drop" onClick={() => hRef.current && hRef.current.click()}>
              <span className="cmp-file-ic" style={{ background: 'var(--risk-med-soft)', color: 'var(--risk-med)' }}>
                <Icon name={hFile ? 'folder' : 'upload'} size={18} />
              </span>
              <span style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                <span className="cmp-file-name">{handoverLabel}</span>
                <span className="cmp-file-meta">{hFile ? t.cmpUploadedFile : t.cmpSlotHint}</span>
              </span>
              {hFile ? <span className="cmp-check">✓</span> : null}
            </button>
          </div>
        </div>

        <div className="cmp-pairs">
          <div className="cmp-pairs-h">{t.cmpDemoPairs}</div>
          <div className="cmp-pairs-list">
            <button className={'cmp-pair' + (usePair && !cFile && !hFile ? ' on' : '')}
                    onClick={() => { setUsePair(true); setCFile(null); setHFile(null); }}>
              <span className="cmp-pair-ic"><Icon name="doc" size={15} /></span>
              <span style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                <span className="cmp-pair-t">{demoPair.product}</span>
                <span className="cmp-pair-s">{demoPair.counterparty}</span>
              </span>
              {usePair && !cFile && !hFile ? <Icon name="checkCircle" size={16} style={{ color: 'var(--accent)' }} /> : null}
            </button>
          </div>
        </div>

        <div className="cmp-run-row">
          <button className="btn btn-primary btn-lg" disabled={!canRun} onClick={run}>
            <Icon name="scan" size={17} /> {t.cmpRun}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------- Analyzing overlay ---------- */
function AnalyzingStep({ t }) {
  const steps = t.cmpSteps || [];
  const [step, setStep] = useState(0);
  const [pct, setPct] = useState(6);
  useEffect(() => {
    if (steps.length === 0) return;
    const si = setInterval(() => setStep(s => Math.min(s + 1, steps.length - 1)), 480);
    const pi = setInterval(() => setPct(p => Math.min(p + Math.random() * 13 + 4, 98)), 240);
    return () => { clearInterval(si); clearInterval(pi); };
  }, [steps.length]);
  return (
    <div className="analysis">
      <div className="analysis-body">
        <div className="doc-scroll">
          <div className="analyzing">
            <div className="analyzing-card">
              <div className="analyzing-orb"><Icon name="scan" size={26} /></div>
              <div style={{ fontSize: 18, fontWeight: 700, marginTop: 16 }}>{t.cmpAnalyzing}</div>
              <div style={{ fontSize: 13.5, color: 'var(--text-3)', marginTop: 4 }}>{t.cmpAnalyzingSub}</div>
              <div className="prog"><div className="prog-bar" style={{ width: pct + '%' }} /></div>
              <div className="analyzing-steps">
                {steps.map((s, i) => (
                  <div key={i} className={'astep' + (i < step ? ' done' : i === step ? ' now' : '')}>
                    <span className="astep-dot">{i < step ? <Icon name="check" size={11} stroke={3} /> : null}</span>
                    {s}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
        <div className="panel-wrap panel-loading" />
      </div>
    </div>
  );
}

/* ---------- Render a parts array (string | {t, cat, st}) ---------- */
function renderParts(parts, opts) {
  const { active, onPick, refs, forceOk } = opts;
  return (parts || []).map((seg, i) => {
    if (typeof seg === 'string') return <span key={i}>{seg}</span>;
    const st = forceOk ? 'ok' : seg.st;
    const cls = 'cmark cmark-' + st + (active === seg.cat ? ' active' : '');
    const clickable = st === 'mismatch' || st === 'flag' || st === 'positive' || forceOk;
    return (
      <mark key={i}
        ref={el => { if (el && refs) refs.current[seg.cat] = el; }}
        className={cls}
        onClick={(e) => {
          e.stopPropagation();
          if (clickable && onPick) onPick(seg.cat);
        }}>
        {seg.t}
      </mark>
    );
  });
}

/* ---------- Contract paper (bilingual EN / UA) ---------- */
function ContractPaper({ doc, active, onPick, refs }) {
  return (
    <div className="cmp-paper cmp-paper-contract">
      <div className="cmp-paper-head">
        <div className="cmp-bi">
          <div className="cmp-paper-title">{doc.title}</div>
          <div className="cmp-paper-title">{doc.titleUa}</div>
        </div>
        {(doc.place || doc.placeUa) ? (
          <div className="cmp-bi cmp-paper-place">
            <div>{doc.place}</div>
            <div>{doc.placeUa}</div>
          </div>
        ) : null}
      </div>
      {(doc.sections || []).map((s, i) => (
        <div className="cmp-clause" key={i}>
          <div className="cmp-bi cmp-clause-h">
            <div>{s.n}. {s.en}</div>
            <div>{s.n}. {s.ua}</div>
          </div>
          <div className="cmp-bi cmp-clause-b">
            <p>{(s.enP || []).map((para, k) => (
              <span key={k}>{renderParts(Array.isArray(para) ? para : [para], { active, onPick, refs })}</span>
            ))}</p>
            <p>{(s.uaP || []).map((para, k) => (
              <span key={k}>{renderParts(Array.isArray(para) ? para : [para], { active, onPick, refs })}</span>
            ))}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ---------- Handover paper (Лист погодження / Table 3 form) ---------- */
function HandoverPaper({ doc, active, onPick, refs }) {
  return (
    <div className="cmp-paper cmp-paper-form">
      {doc.appendix ? <div className="cmp-form-appendix">{doc.appendix}</div> : null}
      {doc.title ? <div className="cmp-form-title">{doc.title}</div> : null}
      {doc.sub ? <div className="cmp-form-sub">{doc.sub}</div> : null}
      {doc.section ? <div className="cmp-form-section">{doc.section}</div> : null}
      <table className="cmp-form-table">
        <thead>
          <tr><th className="cmp-form-no">№</th><th>Поле</th><th>Значення</th></tr>
        </thead>
        <tbody>
          {(doc.rows || []).map((r, i) => (
            <tr key={i}>
              <td className="cmp-form-no">{r.star ? <span className="cmp-form-star">*</span> : null}{r.n}</td>
              <td className="cmp-form-label">{r.label}</td>
              <td className="cmp-form-val">{renderParts(r.v, { active, onPick, refs, forceOk: true })}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {doc.footnote ? <div className="cmp-form-foot">{doc.footnote}</div> : null}
    </div>
  );
}

/* ---------- Result screen ---------- */
function ResultStep({ t, run, onBack, onRestart }) {
  const docs = run.docs || { contract: {}, handover: { rows: [] } };
  const rows = run.rows || [];
  const findings = run.findings || [];
  const pair = run.pair || {};

  const [view, setView] = useState('docs');
  const [which, setWhich] = useState('contract');
  const [active, setActive] = useState(null);
  const [filter, setFilter] = useState('all');
  const [reconciled, setReconciled] = useState(new Set());
  const docRefs = useRef({});
  const rowRefs = useRef({});

  const counts = useMemo(() => {
    const c = { must: 0, should: 0, nice: 0, flag: 0, mismatches: 0 };
    findings.forEach(f => { if (c[f.severity] != null) c[f.severity] += 1; });
    rows.forEach(r => { if (r.status === 'mismatch') c.mismatches += 1; });
    return c;
  }, [findings, rows]);

  const verdict = counts.must > 0 || counts.mismatches > 0
    ? 'crit'
    : counts.should + counts.flag > 0 ? 'warn' : 'ok';
  const overallMeta = {
    crit: ['cmpOverallCrit', 'var(--risk-high)'],
    warn: ['cmpOverallWarn', 'var(--risk-med)'],
    ok:   ['cmpOverallOk',   'var(--risk-low)'],
  }[verdict];

  const counters = [
    { k: 'must',   n: counts.must },
    { k: 'should', n: counts.should },
    { k: 'nice',   n: counts.nice },
    { k: 'flag',   n: counts.flag },
  ];
  const shownFindings = filter === 'all' ? findings : findings.filter(f => f.severity === filter);
  const legend = [['ok', t.cmpLegendOk], ['mismatch', t.cmpLegendDiff], ['flag', t.cmpLegendFlag]];

  useEffect(() => {
    if (!active) return;
    const tm = setTimeout(() => {
      const target = view === 'docs' ? docRefs.current[active] : rowRefs.current[active];
      if (target) target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 60);
    return () => clearTimeout(tm);
  }, [active, view, which]);

  const focusFinding = (cat) => {
    if (active === cat) { setActive(null); return; }
    setActive(cat);
    if (view === 'docs') {
      const inContract = (docs.contract.sections || []).some(s =>
        [...(s.enP || []), ...(s.uaP || [])].some(para => {
          const arr = Array.isArray(para) ? para : [para];
          return arr.some(p => p && typeof p === 'object' && p.cat === cat);
        })
      );
      const inHandover = (docs.handover.rows || []).some(r =>
        (r.v || []).some(p => p && typeof p === 'object' && p.cat === cat)
      );
      if (!inContract && inHandover) setWhich('handover');
      else if (inContract && !inHandover) setWhich('contract');
    }
  };

  const toggleRec = (id) => setReconciled(s => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else { n.add(id); toast(t.cmpReconciled, 'check'); }
    return n;
  });

  async function addEditsToTasks() {
    const fixable = findings.filter(f => f.severity === 'must' || f.severity === 'should');
    if (fixable.length === 0) { toast(t.cmpTasksAdded, 'calendar'); return; }
    const due = new Date(Date.now() + 7 * 86400 * 1000).toISOString().slice(0, 10);
    let created = 0;
    for (const f of fixable) {
      try {
        await api.tasks.create({
          title: 'Правка: ' + f.issue.slice(0, 80),
          matter: pair.counterparty || pair.product,
          assignee: '',
          due,
          priority: f.severity,
          col: 'todo',
        });
        created += 1;
      } catch (_e) { /* skip silently */ }
    }
    toast(created > 0 ? t.cmpTasksAdded : t.cmpTasksFailed, created > 0 ? 'calendar' : 'alert');
  }

  function exportReport() {
    const lines = [];
    lines.push(`# ${t.reconcileTitle} · ${pair.product || ''}`);
    lines.push(`${pair.counterparty || ''} · ${pair.contractNo || ''} · ${pair.date || ''}`);
    lines.push('');
    rows.forEach(r => {
      lines.push(`- [${r.status.toUpperCase()}] ${r.name}: ${t.cmpT3} = ${r.t3 || '—'} | ${t.cmpContract} = ${r.contract || '—'}`);
      if (r.reason) lines.push(`  ${t.cmpWhy}: ${r.reason}`);
      if (r.rec) lines.push(`  ${t.cmpRec}: ${r.rec}`);
    });
    lines.push('');
    lines.push('## ' + t.cmpFindings);
    findings.forEach((f, i) => {
      lines.push(`${i + 1}. [${t[SEV[f.severity].key]}] ${f.location}: ${f.issue}`);
      if (f.rec) lines.push(`   → ${f.rec}`);
    });
    try { navigator.clipboard.writeText(lines.join('\n')); } catch (_e) {}
    toast(t.cmpExported, 'doc');
  }

  const contractFileLabel = run.contractFile || pair.contractFile || 'contract.docx';
  const handoverFileLabel = run.handoverFile || pair.handoverFile || 'handover.xlsx';

  return (
    <div className="analysis">
      <div className="analysis-bar">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
          <button className="hub-back" style={{ margin: 0 }} onClick={onBack}>
            <Icon name="chevR" size={16} style={{ transform: 'rotate(180deg)' }} /> {t.cmpBack}
          </button>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 15, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{pair.product || '—'}</div>
            <div style={{ fontSize: 12, color: 'var(--text-3)' }}>{pair.counterparty}{pair.contractNo ? ' · ' + pair.contractNo : ''}</div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto' }}>
          <div className="seg seg-sm">
            <button className={view === 'docs' ? 'on' : ''} onClick={() => setView('docs')}><Icon name="doc" size={13} /> {t.cmpViewDocs}</button>
            <button className={view === 'table' ? 'on' : ''} onClick={() => setView('table')}><Icon name="dashboard" size={13} /> {t.cmpViewTable}</button>
          </div>
          <span className="cmp-overall" style={{ color: overallMeta[1], background: `color-mix(in oklab, ${overallMeta[1]} 13%, transparent)` }}>
            <Icon name={verdict === 'ok' ? 'checkCircle' : 'alert'} size={14} /> {t[overallMeta[0]]}
          </span>
          <button className="btn btn-ghost btn-sm" onClick={addEditsToTasks}><Icon name="calendar" size={15} /> {t.cmpToTasks}</button>
          <button className="btn btn-ghost btn-sm" onClick={exportReport}><Icon name="download" size={15} /> {t.cmpReexport}</button>
          <button className="btn btn-primary btn-sm" onClick={onRestart}><Icon name="refresh" size={15} /> {t.cmpRun}</button>
        </div>
      </div>

      <div className="analysis-body">
        <div className="doc-scroll cmp-scroll">
          <div className="view-enter">
            {view === 'docs' ? (
              <>
                <div className="cmp-doctabs">
                  <button className={'cmp-doctab' + (which === 'contract' ? ' on' : '')} onClick={() => setWhich('contract')}>
                    <Icon name="doc" size={15} /> <span>{contractFileLabel}</span>
                  </button>
                  <button className={'cmp-doctab' + (which === 'handover' ? ' on' : '')} onClick={() => setWhich('handover')}>
                    <Icon name="folder" size={15} /> <span>{handoverFileLabel}</span>
                  </button>
                  <div className="cmp-legend">
                    {legend.map(([s, lbl]) => (
                      <span key={s} className="cmp-leg-item"><span className={'cmp-leg-dot cdoc-' + s} />{lbl}</span>
                    ))}
                  </div>
                </div>

                {which === 'contract'
                  ? <ContractPaper doc={docs.contract} active={active} onPick={focusFinding} refs={docRefs} />
                  : <HandoverPaper doc={docs.handover} active={active} onPick={focusFinding} refs={docRefs} />}

                <div className="cmp-src-note"><Icon name="sparkle" size={12} fill={true} /> {t.cmpSrcNote}</div>
              </>
            ) : (
              <>
                <div className="cmp-table-h">
                  <span>{t.cmpCategory}</span>
                  <span>{t.cmpT3}</span>
                  <span>{t.cmpContract}</span>
                </div>
                <div className="cmp-rows">
                  {rows.map(row => {
                    const m = CMP_STATUS[row.status] || CMP_STATUS.absent;
                    const isDiff = row.status === 'mismatch' || row.status === 'flag';
                    return (
                      <div key={row.key}
                        ref={el => { if (el) rowRefs.current[row.key] = el; }}
                        className={'cmp-row cmp-row-' + row.status + (active === row.key ? ' active' : '')}
                        onClick={() => isDiff && setActive(active === row.key ? null : row.key)}>
                        <div className="cmp-row-cat">
                          <span className="cmp-row-name">{row.name}</span>
                          <span className="cmp-row-loc">{row.location}</span>
                        </div>
                        <div className="cmp-row-val cmp-row-t3">{row.t3 || '—'}</div>
                        <div className="cmp-row-val cmp-row-c">{row.contract || '—'}</div>
                        <span className="cmp-badge" style={{ color: m.col, background: m.bg }}>
                          <Icon name={m.ic} size={12} /> {t[m.key]}
                        </span>
                        {isDiff && active === row.key ? (
                          <div className="cmp-row-detail">
                            {row.reason ? (
                              <div className="cmp-detail-why">
                                <span className="cmp-detail-l">{t.cmpWhy}</span>{row.reason}
                              </div>
                            ) : null}
                            {row.rec ? (
                              <div className="cmp-detail-rec">
                                <Icon name="sparkle" size={13} fill={true} />
                                <span><span className="cmp-detail-l">{t.cmpRec}</span>{row.rec}</span>
                              </div>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        </div>

        <div className="panel-wrap">
          <div className="cmp-panel">
            <div className="cmp-counters">
              {counters.map(c => {
                const s = SEV[c.k];
                return (
                  <button key={c.k}
                    className={'cmp-counter' + (filter === c.k ? ' on' : '')}
                    onClick={() => setFilter(filter === c.k ? 'all' : c.k)}
                    style={filter === c.k ? { borderColor: s.col } : null}>
                    <span className="cmp-counter-n" style={{ color: s.col }}>{c.n}</span>
                    <span className="cmp-counter-l">{t[s.key]}</span>
                  </button>
                );
              })}
            </div>

            <div className="cmp-find-list">
              {shownFindings.length === 0 ? (
                <div className="cmp-empty">{t.cmpEmpty}</div>
              ) : shownFindings.map(f => {
                const s = SEV[f.severity];
                const isRec = reconciled.has(f.id);
                const isActive = active === f.cat;
                return (
                  <div key={f.id}
                    className={'cmp-find' + (isRec ? ' done' : '') + (isActive ? ' active' : '')}
                    style={{ borderLeftColor: s.col }}
                    onClick={() => focusFinding(f.cat)}>
                    <div className="cmp-find-top">
                      <span className="cmp-sev" style={{ color: s.col, background: s.bg }}>{t[s.key]}</span>
                      <span className="cmp-find-loc">{f.location}</span>
                      <span className={'cmp-vtag ' + (f.verified === 'VERIFIED' ? 'v' : 'f')}>
                        {f.verified === 'VERIFIED' ? t.cmpVerified : t.cmpNeedsCheck}
                      </span>
                    </div>
                    <div className="cmp-find-issue">{f.issue}</div>
                    {f.rec ? (
                      <div className="cmp-find-rec"><Icon name="sparkle" size={12} fill={true} /> {f.rec}</div>
                    ) : null}
                    <div className="cmp-find-foot">
                      <span className="cmp-find-jump"><Icon name="scan" size={12} /> {f.source}</span>
                      <button className={'cmp-find-rec-btn' + (isRec ? ' on' : '')}
                              onClick={(e) => { e.stopPropagation(); toggleRec(f.id); }}>
                        <Icon name={isRec ? 'check' : 'plus'} size={12} /> {isRec ? t.cmpReconciled : t.cmpReconcile}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------- Main screen ---------- */
function Reconcile({ t, setRoute }) {
  const [phase, setPhase] = useState('upload');
  const [run, setRun] = useState(null);
  const [warned, setWarned] = useState(false);

  // Open a persisted run handed off from Library / Dashboard.
  useEffect(() => {
    const openId = popOpenRunId();
    if (!openId) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await api.reconciliations.get(openId);
        if (!cancelled && r) { setRun(r); setPhase('result'); }
      } catch (_e) {
        const cached = loadHistory().find(x => x.id === openId);
        if (!cancelled && cached) { setRun(cached); setPhase('result'); }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  async function doReconcile({ contractFile, handoverFile, demo }) {
    setPhase('analyzing');
    setWarned(false);
    const startedAt = Date.now();
    try {
      const fd = new FormData();
      fd.append('contract_file', contractFile);
      fd.append('handover_file', handoverFile);
      const res = await api.reconcile(fd);
      const elapsed = Date.now() - startedAt;
      if (elapsed < 2400) await new Promise(r => setTimeout(r, 2400 - elapsed));
      saveHistory(res);
      setRun(res);
      setPhase('result');
    } catch (_e) {
      // Offline / no auth / no AI quota — fall back to the demo fixture so the
      // screen is still useful. Backend / live calls still work normally when
      // the API is reachable.
      await new Promise(r => setTimeout(r, 2000));
      const fixture = {
        ...DEMO.reconciliation,
        id: demo ? DEMO.reconciliation.id : 'rec-local-' + Math.random().toString(36).slice(2, 8),
        contractFile: contractFile.name,
        handoverFile: handoverFile.name,
        createdAt: new Date().toISOString(),
      };
      saveHistory(fixture);
      setWarned(true);
      setRun(fixture);
      setPhase('result');
    }
  }

  function reset() {
    setPhase('upload');
    setRun(null);
    setWarned(false);
  }

  if (phase === 'upload') {
    return <UploadStep t={t} onRun={doReconcile} onBack={() => setRoute('dashboard')} demoPair={DEMO.reconciliation.pair} />;
  }
  if (phase === 'analyzing' || !run) {
    return <AnalyzingStep t={t} />;
  }
  return (
    <>
      {warned ? (
        <div style={{ padding: '8px 16px', background: 'var(--risk-med-soft)', color: 'var(--risk-med)', fontSize: 12 }}>
          <Icon name="alert" size={12} /> {t.cmpFallback}
        </div>
      ) : null}
      <ResultStep t={t} run={run}
                  onBack={() => setPhase('upload')}
                  onRestart={() => { setRun(null); setPhase('upload'); }} />
    </>
  );
}

export { Reconcile, RECON_HISTORY_KEY, RECON_OPEN_KEY };
