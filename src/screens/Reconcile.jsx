/* ============================================================
   AG Lex — Contract ↔ Handover (Table 3) Reconciliation screen
   Two-file upload → analyzing → result (Documents | Table) + findings panel.
   ============================================================ */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../ui/Icon';
import { Modal, toast } from '../ui/components';
import { api } from '../lib/api';
import { DEMO } from '../data/demo';

const RECON_HISTORY_KEY = 'lex.recon.history';
const RECON_OPEN_KEY = 'lex.recon.open';

const STATUS_TO_HL = {
  ok: 'hl-low',
  mismatch: 'hl-high',
  flag: 'hl-med',
  absent: '',
  positive: 'hl-info',
};

const SEV_TO_BADGE = {
  must: 'badge-high',
  should: 'badge-med',
  nice: 'badge-low',
  flag: 'badge-info',
};

const SEV_TO_BORDER = {
  must: 'var(--risk-high)',
  should: 'var(--risk-med)',
  nice: 'var(--risk-low)',
  flag: 'var(--accent)',
};

function sevLabel(t, sev) {
  return ({ must: t.sevMust, should: t.sevShould, nice: t.sevNice, flag: t.sevFlag }[sev]) || sev;
}

function statusLabel(t, st) {
  return ({
    ok: t.statusOkR, mismatch: t.statusMismatch, flag: t.statusFlagR,
    absent: t.statusAbsent, positive: t.statusPositive,
  }[st]) || st;
}

function statusColor(st) {
  return ({
    ok: 'var(--risk-low)', mismatch: 'var(--risk-high)', flag: 'var(--risk-med)',
    absent: 'var(--text-3)', positive: 'var(--accent)',
  }[st]) || 'var(--text-3)';
}

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
function UploadStep({ t, onSubmit, onDemo }) {
  const [contract, setContract] = useState(null);
  const [handover, setHandover] = useState(null);
  const [warn, setWarn] = useState(null);
  const canRun = contract && handover;
  const pick = (setter, accept) => (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const ext = (f.name.split('.').pop() || '').toLowerCase();
    if (!accept.includes('.' + ext)) {
      setWarn(`${f.name} — ${(t.reconAcceptContract || '').toLowerCase()}`);
      return;
    }
    setWarn(null);
    setter(f);
  };
  return (
    <div className="recon-upload view-enter">
      <div style={{ textAlign: 'center', marginBottom: 4 }}>
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 700, letterSpacing: '-0.02em' }}>{t.reconUpload}</h2>
        <div style={{ fontSize: 13.5, color: 'var(--text-3)', marginTop: 6 }}>{t.reconUploadSub}</div>
      </div>
      <div className="recon-upload-grid">
        <label className="recon-drop">
          <span style={{ display: 'flex', justifyContent: 'center', color: 'var(--accent)' }}><Icon name="doc" size={22} /></span>
          <span className="recon-drop-name">{t.reconUploadContract}</span>
          <span className="recon-drop-sub">{t.reconAcceptContract}</span>
          {contract ? <span className="recon-drop-file">✓ {contract.name}</span> : <span style={{ fontSize: 12, color: 'var(--accent)', fontWeight: 600 }}>{t.reconChooseFile}</span>}
          <input type="file" accept=".pdf,.docx" onChange={pick(setContract, ['.pdf', '.docx'])} />
        </label>
        <label className="recon-drop">
          <span style={{ display: 'flex', justifyContent: 'center', color: 'var(--accent)' }}><Icon name="scales" size={22} /></span>
          <span className="recon-drop-name">{t.reconUploadHandover}</span>
          <span className="recon-drop-sub">{t.reconAcceptHandover}</span>
          {handover ? <span className="recon-drop-file">✓ {handover.name}</span> : <span style={{ fontSize: 12, color: 'var(--accent)', fontWeight: 600 }}>{t.reconChooseFile}</span>}
          <input type="file" accept=".pdf,.docx,.xlsx" onChange={pick(setHandover, ['.pdf', '.docx', '.xlsx'])} />
        </label>
      </div>
      {warn ? <div className="recon-warn"><Icon name="alert" size={13} /> {warn}</div> : null}
      <div className="recon-demo">
        <span className="launcher-ic launcher-ic-accent" style={{ width: 32, height: 32 }}><Icon name="sparkle" size={16} fill={true} /></span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <b>{t.reconDemoPair}</b>
          <span style={{ display: 'block' }}>{t.reconDemoPairSub}</span>
        </div>
        <button className="btn btn-subtle btn-sm" onClick={onDemo}><Icon name="arrowR" size={14} /> {t.reconDemoPair}</button>
      </div>
      <button className="btn btn-primary" disabled={!canRun}
              style={{ justifyContent: 'center', padding: '12px 16px' }}
              onClick={() => onSubmit(contract, handover)}>
        <Icon name="sparkle" size={16} fill={true} /> {t.reconRun}
      </button>
    </div>
  );
}

/* ---------- Analyzing overlay ---------- */
function AnalyzingStep({ t }) {
  const steps = [t.reconStep1, t.reconStep2, t.reconStep3, t.reconStep4, t.reconStep5];
  const [step, setStep] = useState(0);
  const [pct, setPct] = useState(6);
  useEffect(() => {
    const si = setInterval(() => setStep(s => Math.min(s + 1, steps.length - 1)), 520);
    const pi = setInterval(() => setPct(p => Math.min(p + Math.random() * 12 + 3, 98)), 240);
    return () => { clearInterval(si); clearInterval(pi); };
  }, []);
  return (
    <div className="analyzing">
      <div className="analyzing-card">
        <div className="analyzing-orb"><Icon name="sparkle" size={26} fill={true} /></div>
        <div style={{ fontSize: 18, fontWeight: 700, marginTop: 16 }}>{t.reconcileTitle}</div>
        <div style={{ fontSize: 13.5, color: 'var(--text-3)', marginTop: 4 }}>{t.analyzingSub}</div>
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
  );
}

/* ---------- Rendered contract (left, doc view) ---------- */
function renderParts(parts, opts) {
  const { onPick, applied, selectedCat } = opts;
  return (parts || []).map((seg, i) => {
    if (typeof seg === 'string') return <span key={i}>{seg}</span>;
    const hl = STATUS_TO_HL[seg.st] || '';
    const active = selectedCat && selectedCat === seg.cat;
    const isApplied = applied && applied[seg.cat];
    return (
      <mark key={i}
        className={'hl ' + hl + (active ? ' hl-active' : '') + (isApplied ? ' hl-done' : '')}
        onClick={(e) => { e.stopPropagation(); onPick && onPick(seg.cat); }}>
        {seg.t}
      </mark>
    );
  });
}

function ContractDocView({ doc, onPick, selectedCat, applied }) {
  return (
    <div className="doc">
      <div className="doc-head">
        <h1 className="doc-title">{doc.title}</h1>
        <div className="doc-meta">{doc.titleUa}</div>
        {doc.place ? <div className="doc-meta" style={{ marginTop: 4 }}>{doc.place} · {doc.placeUa}</div> : null}
      </div>
      {(doc.sections || []).map((s, i) => (
        <section className="doc-clause" key={i} id={'rc-sec-' + i}>
          <h3 className="doc-clause-title">{s.n}. {s.en} / {s.ua}</h3>
          {(s.enP || []).map((para, k) => (
            <p className="doc-p" key={'en' + k}>{renderParts(para, { onPick, selectedCat, applied })}</p>
          ))}
          {(s.uaP || []).map((para, k) => (
            <p className="doc-p" key={'ua' + k} style={{ color: 'var(--text-2)' }}>{renderParts(para, { onPick, selectedCat, applied })}</p>
          ))}
        </section>
      ))}
    </div>
  );
}

function HandoverDocView({ doc, onPick, selectedCat, applied, t }) {
  return (
    <div className="doc">
      <div className="t3-head">
        {doc.appendix ? <div className="t3-appendix">{doc.appendix}</div> : null}
        <div className="t3-title">{doc.title}</div>
        {doc.sub ? <div className="t3-sub">{doc.sub}</div> : null}
        {doc.section ? <div className="t3-section">{doc.section}</div> : null}
      </div>
      <table className="t3">
        <thead>
          <tr><th>№</th><th className="t3-label">{t.colCategory}</th><th>{t.colT3}</th></tr>
        </thead>
        <tbody>
          {(doc.rows || []).map((r, i) => (
            <tr key={i}>
              <td>{r.n}</td>
              <td className="t3-label">{r.star ? <span className="t3-star">*</span> : null}{r.label}</td>
              <td>{renderParts(r.v, { onPick, selectedCat, applied })}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {doc.footnote ? <div className="t3-foot">{doc.footnote}</div> : null}
    </div>
  );
}

/* ---------- Comparison table view ---------- */
function CompareTable({ rows, t, selectedCat, onPick }) {
  const cats = useMemo(() => ({
    supplier: t.cat_supplier, product: t.cat_product, price: t.cat_price,
    quantity: t.cat_quantity, incoterms: t.cat_incoterms, delivery: t.cat_delivery,
    payment: t.cat_payment, origin: t.cat_origin, hscode: t.cat_hscode,
    certificates: t.cat_certificates, packaging: t.cat_packaging, quality: t.cat_quality,
    consignee: t.cat_consignee, regnumber: t.cat_regnumber, additional: t.cat_additional,
  }), [t]);
  return (
    <div className="card" style={{ overflow: 'hidden' }}>
      <table className="cmp">
        <thead>
          <tr>
            <th>{t.colCategory}</th>
            <th>{t.colT3}</th>
            <th>{t.colContract}</th>
            <th style={{ width: 140 }}>{t.colStatus}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const focus = selectedCat === r.key;
            const col = statusColor(r.status);
            return [
              <tr key={r.key} className={focus ? 'cmp-focus' : ''} onClick={() => onPick(r.key)} style={{ cursor: 'pointer' }}>
                <td><span style={{ fontWeight: 600 }}>{cats[r.key] || r.name}</span></td>
                <td>{r.t3 || '—'}</td>
                <td>{r.contract || '—'}<div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 2 }}>{r.location}</div></td>
                <td>
                  <span className="cmp-status-pill" style={{ background: `color-mix(in oklab, ${col} 14%, transparent)`, color: col }}>
                    {statusLabel(t, r.status)}
                  </span>
                </td>
              </tr>,
              focus && (r.reason || r.rec) ? (
                <tr key={r.key + '-d'}>
                  <td colSpan={4} className="cmp-detail">
                    {r.reason ? <div><b>{t.whyMismatch}: </b>{r.reason}</div> : null}
                    {r.rec ? <div style={{ marginTop: 4 }}><b>{t.recommendation}: </b>{r.rec}</div> : null}
                  </td>
                </tr>
              ) : null,
            ];
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ---------- Findings panel (right) ---------- */
function FindingsPanel({ t, findings, sevFilter, setSevFilter, selectedCat, onPick, applied, onApply }) {
  const counts = useMemo(() => {
    const c = { all: findings.length, must: 0, should: 0, nice: 0, flag: 0 };
    findings.forEach(f => { if (c[f.severity] != null) c[f.severity] += 1; });
    return c;
  }, [findings]);
  const filtered = sevFilter === 'all' ? findings : findings.filter(f => f.severity === sevFilter);
  return (
    <div className="aipanel">
      <div className="aipanel-head">
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, color: 'var(--accent)', fontWeight: 700, fontSize: 13.5, marginBottom: 12 }}>
          <Icon name="sparkle" size={16} fill={true} /> {t.findings}
        </div>
        <div className="sev-bar">
          {[
            ['all',    t.sevAll],
            ['must',   t.sevMust],
            ['should', t.sevShould],
            ['nice',   t.sevNice],
            ['flag',   t.sevFlag],
          ].map(([id, label]) => (
            <button key={id}
                    className={'sev-pill sev-' + id + (sevFilter === id ? ' on' : '')}
                    onClick={() => setSevFilter(id)}>
              {label} <span className="sev-count">{counts[id]}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="aipanel-body">
        {filtered.length === 0 ? (
          <div className="fnd-empty">{t.reconNoFindings}</div>
        ) : filtered.map(f => {
          const isApplied = applied[f.id];
          const focus = selectedCat === f.cat;
          return (
            <div key={f.id}
                 className={'finding' + (focus ? ' finding-active' : '') + (isApplied ? ' finding-done' : '')}
                 style={{ borderLeftColor: isApplied ? 'var(--risk-low)' : SEV_TO_BORDER[f.severity] }}
                 onClick={() => onPick(f.cat)}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span className={'badge-risk ' + (SEV_TO_BADGE[f.severity] || 'badge-info')}>{sevLabel(t, f.severity)}</span>
                <span style={{ fontSize: 12, color: 'var(--text-3)', marginLeft: 'auto' }}>{f.location}</span>
              </div>
              <div style={{ fontWeight: 650, fontSize: 14.5, marginBottom: 4, letterSpacing: '-0.01em' }}>{f.issue}</div>
              {f.rec ? <div style={{ fontSize: 13.5, color: 'var(--text-2)', lineHeight: 1.5 }}>{f.rec}</div> : null}
              <div className="fnd-meta">
                <span className={'fnd-verified ' + (f.verified === 'VERIFIED' ? 'tag-ok' : 'tag-flag')}>
                  <Icon name={f.verified === 'VERIFIED' ? 'check' : 'flag'} size={11} stroke={2.6} />
                  {f.verified === 'VERIFIED' ? t.verifiedTag : t.flagTag}
                </span>
                {f.source ? <span className="fnd-source"><Icon name="sparkle" size={11} fill={true} /> {f.source}</span> : null}
                <button className={'btn btn-sm ' + (isApplied ? 'btn-ghost' : 'btn-subtle')}
                        disabled={isApplied}
                        style={{ marginLeft: 'auto' }}
                        onClick={(e) => { e.stopPropagation(); onApply(f.id); }}>
                  {isApplied ? <><Icon name="check" size={13} /> {t.agreed}</> : <><Icon name="check" size={13} /> {t.agreeBtn}</>}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ---------- Main screen ---------- */
function Reconcile({ t, setRoute }) {
  const [phase, setPhase] = useState('upload');     // upload | analyzing | result
  const [view, setView] = useState('docs');         // docs | table
  const [docTab, setDocTab] = useState('contract'); // contract | handover
  const [sevFilter, setSevFilter] = useState('all');
  const [selectedCat, setSelectedCat] = useState(null);
  const [applied, setApplied] = useState({});
  const [run, setRun] = useState(null);
  const [warning, setWarning] = useState(null);
  const docScrollRef = useRef(null);

  // Open from Library — pop the requested run id.
  useEffect(() => {
    const openId = popOpenRunId();
    if (!openId) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await api.reconciliations.get(openId);
        if (!cancelled && r) loadRun(r);
      } catch (_e) {
        const cached = loadHistory().find(x => x.id === openId);
        if (!cancelled && cached) loadRun(cached);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function loadRun(r) {
    setRun(r);
    setPhase('result');
    setView('docs');
    setDocTab('contract');
    setSevFilter('all');
    setSelectedCat(null);
    setApplied({});
  }

  async function runReconcile(contractFile, handoverFile) {
    setPhase('analyzing');
    setWarning(null);
    const startedAt = Date.now();
    try {
      const fd = new FormData();
      fd.append('contract_file', contractFile);
      fd.append('handover_file', handoverFile);
      const res = await api.reconcile(fd);
      const elapsed = Date.now() - startedAt;
      if (elapsed < 2200) await new Promise(r => setTimeout(r, 2200 - elapsed));
      saveHistory(res);
      loadRun(res);
    } catch (e) {
      // Offline / no auth / no AI quota — show the demo fixture so the screen
      // is still useful. Surface a friendly warning explaining the fallback.
      await new Promise(r => setTimeout(r, 1800));
      const fixture = {
        ...DEMO.reconciliation,
        id: 'rec-local-' + Math.random().toString(36).slice(2, 8),
        contractFile: contractFile && contractFile.name,
        handoverFile: handoverFile && handoverFile.name,
        createdAt: new Date().toISOString(),
      };
      saveHistory(fixture);
      setWarning(e && e.message ? e.message : 'fallback');
      loadRun(fixture);
    }
  }

  function runDemo() {
    runReconcile(
      new File([''], DEMO.reconciliation.pair.contractFile || 'contract.docx'),
      new File([''], DEMO.reconciliation.pair.handoverFile || 'handover.xlsx'),
    );
  }

  function pickCat(cat) {
    setSelectedCat(cat);
    // If we're in docs view and the cat lives in the other tab, switch tabs.
    if (view === 'docs' && cat && run) {
      const inContract = (run.docs.contract.sections || []).some(s => [...(s.enP || []), ...(s.uaP || [])].some(p => Array.isArray(p) && p.some(part => part && part.cat === cat)));
      const inHandover = (run.docs.handover.rows || []).some(r => (r.v || []).some(part => part && part.cat === cat));
      if (!inContract && inHandover) setDocTab('handover');
      else if (!inHandover && inContract) setDocTab('contract');
    }
  }

  async function addEditsToTasks() {
    if (!run) return;
    const fixable = run.findings.filter(f => f.severity === 'must' || f.severity === 'should');
    if (fixable.length === 0) { toast(t.reconTaskCreated, 'check'); return; }
    const due = new Date(Date.now() + 7 * 86400 * 1000).toISOString().slice(0, 10);
    let created = 0;
    for (const f of fixable) {
      try {
        await api.tasks.create({
          title: f.issue,
          matter: run.pair && run.pair.counterparty,
          assignee: '',
          due,
          priority: f.severity,
          col: 'todo',
        });
        created += 1;
      } catch (_e) { /* offline — skip silently */ }
    }
    toast((created > 0 ? t.reconTaskCreated : t.reconTaskFailed) + (created ? ' · ' + created : ''), created ? 'check' : 'alert');
  }

  function exportReport() {
    if (!run) return;
    const lines = [];
    lines.push(`# ${t.reconcileTitle} · ${run.pair.product || ''}`);
    lines.push(`${run.pair.counterparty || ''} · ${run.pair.contractNo || ''} · ${run.pair.date || ''}`);
    lines.push('');
    run.rows.forEach(r => {
      lines.push(`- [${r.status.toUpperCase()}] ${r.name}: ${t.colT3} = ${r.t3 || '—'} | ${t.colContract} = ${r.contract || '—'}`);
      if (r.reason) lines.push(`  ${t.whyMismatch}: ${r.reason}`);
      if (r.rec) lines.push(`  ${t.recommendation}: ${r.rec}`);
    });
    lines.push('');
    lines.push('## ' + t.findings);
    run.findings.forEach((f, i) => {
      lines.push(`${i + 1}. [${sevLabel(t, f.severity)}] ${f.location}: ${f.issue}`);
      if (f.rec) lines.push(`   → ${f.rec}`);
    });
    const text = lines.join('\n');
    try { navigator.clipboard.writeText(text); } catch (_e) {}
    toast(t.reconExportDone, 'check');
  }

  if (phase === 'upload') {
    return <UploadStep t={t} onSubmit={runReconcile} onDemo={runDemo} />;
  }
  if (phase === 'analyzing' || !run) {
    return <div className="recon"><AnalyzingStep t={t} /></div>;
  }

  const verdict = run.verdict || 'minor';
  const verdictBadge = { critical: 'badge-high', minor: 'badge-med', clean: 'badge-low' }[verdict] || 'badge-med';
  const verdictLabel = { critical: t.reconVerdictCritical, minor: t.reconVerdictMinor, clean: t.reconVerdictClean }[verdict];

  return (
    <div className="recon view-enter">
      <div className="recon-bar">
        <span className="chip"><Icon name="scan" size={13} /> {run.pair.contractNo || run.id}</span>
        <div style={{ minWidth: 0 }}>
          <div className="recon-bar-title">{run.pair.product || '—'}</div>
          <div className="recon-bar-sub">{run.pair.counterparty} · {run.pair.date}</div>
        </div>
        <div className="recon-bar-right">
          <div className="seg seg-sm">
            <button className={view === 'docs' ? 'on' : ''} onClick={() => setView('docs')}>{t.reconViewDocs}</button>
            <button className={view === 'table' ? 'on' : ''} onClick={() => setView('table')}>{t.reconViewTable}</button>
          </div>
          <span className={'badge-risk ' + verdictBadge}>{verdictLabel}</span>
          <button className="btn btn-subtle btn-sm" onClick={addEditsToTasks}><Icon name="check" size={14} /> {t.reconAddTasks}</button>
          <button className="btn btn-subtle btn-sm" onClick={exportReport}><Icon name="upload" size={14} style={{ transform: 'rotate(180deg)' }} /> {t.reconExport}</button>
          <button className="btn btn-primary btn-sm" onClick={() => { setPhase('upload'); setRun(null); setApplied({}); }}><Icon name="refresh" size={14} /> {t.reconRerun}</button>
        </div>
      </div>

      {warning ? (
        <div className="recon-warn" style={{ borderRadius: 0 }}>
          <Icon name="alert" size={13} /> {t.analyzingSub} — режим фолбеку (без сервера). {warning}
        </div>
      ) : null}

      <div className="recon-body">
        <div className="doc-scroll" ref={docScrollRef}>
          {view === 'docs' ? (
            <>
              <div className="recon-doc-tabs">
                <button className={'recon-doc-tab' + (docTab === 'contract' ? ' on' : '')} onClick={() => setDocTab('contract')}>
                  <Icon name="doc" size={14} /> {t.reconDocContract}
                </button>
                <button className={'recon-doc-tab' + (docTab === 'handover' ? ' on' : '')} onClick={() => setDocTab('handover')}>
                  <Icon name="scales" size={14} /> {t.reconDocHandover}
                </button>
              </div>
              <div className="recon-legend">
                <span><span className="recon-legend-dot" style={{ background: 'var(--risk-low)' }} />{t.reconLegendOk}</span>
                <span><span className="recon-legend-dot" style={{ background: 'var(--risk-high)' }} />{t.reconLegendMismatch}</span>
                <span><span className="recon-legend-dot" style={{ background: 'var(--risk-med)' }} />{t.reconLegendFlag}</span>
              </div>
              {docTab === 'contract'
                ? <ContractDocView doc={run.docs.contract} onPick={pickCat} selectedCat={selectedCat} applied={applied} />
                : <HandoverDocView doc={run.docs.handover} onPick={pickCat} selectedCat={selectedCat} applied={applied} t={t} />}
            </>
          ) : (
            <CompareTable rows={run.rows} t={t} selectedCat={selectedCat} onPick={pickCat} />
          )}
        </div>
        <div className="panel-wrap">
          <FindingsPanel t={t}
                         findings={run.findings}
                         sevFilter={sevFilter}
                         setSevFilter={setSevFilter}
                         selectedCat={selectedCat}
                         onPick={pickCat}
                         applied={applied}
                         onApply={(id) => setApplied(a => ({ ...a, [id]: true }))} />
        </div>
      </div>
    </div>
  );
}

export { Reconcile, RECON_HISTORY_KEY, RECON_OPEN_KEY };
