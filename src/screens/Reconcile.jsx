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
import { AnalysisView } from './analysis/AnalysisView';
import { AiPanel } from './ContractAnalysis';
import { reconcileToAnalysisProps } from '../lib/reconcileAdapter';

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

/* ---------- Result step (Phase 4.x PR4) — unified analysis screen ----------
   The old source-HTML + source-MD + cmark renderers are gone: AnalysisView
   now renders the pixel-perfect PDF on the left and AiPanel (imported from
   ContractAnalysis) on the right. reconcileToAnalysisProps adapts the
   reconcile run shape into what AiPanel expects. */
function ResultStep({ t, run, onBack, onRestart }) {
  const pair = run.pair || {};
  const adapted = useMemo(() => reconcileToAnalysisProps(run, t), [run, t]);

  const [active, setActive] = useState(null);
  const [hovered, setHovered] = useState(null);
  const [tab, setTab] = useState('risks');
  const [applied, setApplied] = useState({});

  const data = useMemo(() => ({
    findings: adapted.findings,
    comparison: adapted.comparison,
    legalBasis: adapted.legalBasis,
    score: adapted.score,
    warnings: adapted.warnings,
    // Demo-only fields AiPanel still reads — pass empty equivalents so the
    // panel doesn't crash on a tab the reconcile flow doesn't surface.
    missing: [],
    keyData: [],
    summary: '',
    tokenStats: null,
  }), [adapted]);

  const counts = useMemo(() => {
    const c = { must: 0, should: 0, nice: 0, flag: 0, mismatches: 0 };
    (run.findings || []).forEach((f) => { if (c[f.severity] != null) c[f.severity] += 1; });
    (run.rows || []).forEach((r) => { if (r.status === 'mismatch') c.mismatches += 1; });
    return c;
  }, [run]);

  const verdict = counts.must > 0 || counts.mismatches > 0
    ? 'crit'
    : counts.should + counts.flag > 0 ? 'warn' : 'ok';
  const overallMeta = {
    crit: ['cmpOverallCrit', 'var(--risk-high)'],
    warn: ['cmpOverallWarn', 'var(--risk-med)'],
    ok:   ['cmpOverallOk',   'var(--risk-low)'],
  }[verdict];

  async function addEditsToTasks() {
    const fixable = (run.findings || []).filter(
      (f) => f.severity === 'must' || f.severity === 'should',
    );
    if (fixable.length === 0) { toast(t.cmpTasksAdded, 'calendar'); return; }
    const due = new Date(Date.now() + 7 * 86400 * 1000).toISOString().slice(0, 10);
    let created = 0;
    for (const f of fixable) {
      try {
        await api.tasks.create({
          title: 'Правка: ' + (f.issue || '').slice(0, 80),
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
    (run.rows || []).forEach((r) => {
      lines.push(`- [${r.status.toUpperCase()}] ${r.name}: ${t.cmpT3} = ${r.t3 || '—'} | ${t.cmpContract} = ${r.contract || '—'}`);
      if (r.reason) lines.push(`  ${t.cmpWhy}: ${r.reason}`);
      if (r.rec) lines.push(`  ${t.cmpRec}: ${r.rec}`);
    });
    lines.push('');
    lines.push('## ' + t.cmpFindings);
    (run.findings || []).forEach((f, i) => {
      lines.push(`${i + 1}. [${(f.severity || '').toUpperCase()}] ${f.location || ''}: ${f.issue || ''}`);
      if (f.rec) lines.push(`   → ${f.rec}`);
    });
    try { navigator.clipboard.writeText(lines.join('\n')); } catch (_e) {}
    toast(t.cmpExported, 'doc');
  }

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
          <span className="cmp-overall" style={{ color: overallMeta[1], background: `color-mix(in oklab, ${overallMeta[1]} 13%, transparent)` }}>
            <Icon name={verdict === 'ok' ? 'checkCircle' : 'alert'} size={14} /> {t[overallMeta[0]]}
          </span>
          <button className="btn btn-ghost btn-sm" onClick={addEditsToTasks}><Icon name="calendar" size={15} /> {t.cmpToTasks}</button>
          <button className="btn btn-ghost btn-sm" onClick={exportReport}><Icon name="download" size={15} /> {t.cmpReexport}</button>
          <button className="btn btn-primary btn-sm" onClick={onRestart}><Icon name="refresh" size={15} /> {t.cmpRun}</button>
        </div>
      </div>
      <AnalysisView
        documents={adapted.documents}
        findings={adapted.findings}
        active={active}
        setActive={setActive}
        hovered={hovered}
        setHovered={setHovered}
        t={t}
        panel={
          <AiPanel t={t} tab={tab} setTab={setTab}
            active={active} setActive={setActive}
            hovered={hovered} setHovered={setHovered}
            applied={applied}
            onApply={(id) => setApplied((a) => ({ ...a, [id]: true }))}
            onApplyAll={() => {}}
            scrollToSeg={() => {}}
            chatInject={null}
            addedSet={new Set()}
            onAddClause={() => {}}
            data={data} isDemo={false} />
        }
      />
    </div>
  );
}

/* ---------- Main screen ---------- */
function Reconcile({ t, setRoute, incomingRun }) {
  // Three entry paths feed the screen:
  //   - launcher modal jumps in with `{ pending: true }` so we paint the
  //     AnalyzingStep immediately after the click, then swaps in the real
  //     run once /api/reconcile resolves (prop update → useEffect below);
  //   - launcher modal hands us the finished run → straight to result;
  //   - no incomingRun → user lands on UploadStep manually.
  const initialPhase = !incomingRun
    ? 'upload'
    : incomingRun.pending ? 'analyzing' : 'result';
  const [phase, setPhase] = useState(initialPhase);
  const [run, setRun] = useState(incomingRun && !incomingRun.pending ? incomingRun : null);
  const [warned, setWarned] = useState(false);
  useEffect(() => {
    if (incomingRun && !incomingRun.pending) {
      try { saveHistory(incomingRun); } catch (_e) {}
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // React to incomingRun shifting from { pending: true } to the real run —
  // App.jsx sets the pending marker before the network round-trip, then
  // replaces it with the response once /api/reconcile resolves.
  useEffect(() => {
    if (!incomingRun) return;
    if (incomingRun.pending) {
      setPhase('analyzing');
      return;
    }
    setRun(incomingRun);
    setPhase('result');
    try { saveHistory(incomingRun); } catch (_e) {}
  }, [incomingRun]);

  // Open a persisted run handed off from Library / Dashboard.
  useEffect(() => {
    if (incomingRun) return; // launcher path takes precedence
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
