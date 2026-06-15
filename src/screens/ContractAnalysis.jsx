/* ============================================================
   Lexena — Contract analysis view (centerpiece)
   Document with inline highlights + tooltips + AI panel + AI chat
   ============================================================ */
import { useState, useEffect, useRef, useMemo } from 'react';
import { Icon } from '../ui/Icon';
import { Modal, ScoreRing, toast } from '../ui/components';
import { UserAvatar } from '../lib/labels';
import { api } from '../lib/api';
import { DEMO } from '../data/demo';
import { LX } from '../data/lx';
import { DiffModal, ApprovalModal, CommentsModal, DeadlinesModal, SummaryModal, TranslateModal } from './analysisModals';

const LEVEL_COLOR = {
  high: 'var(--risk-high)', med: 'var(--risk-med)', low: 'var(--risk-low)', info: 'var(--info)',
};

/* ---------- Inline highlighted document ---------- */
function ContractDoc({ contract, fById, active, applied, highlightsOn, segRefs, onHover, onPick, onAsk, addedClauses, t }) {
  const clickTimer = useRef(null);

  const handleClick = (id) => {
    if (clickTimer.current) return; // dblclick will clear
    clickTimer.current = setTimeout(() => { clickTimer.current = null; onPick(id); }, 230);
  };
  const handleDouble = (id) => {
    if (clickTimer.current) { clearTimeout(clickTimer.current); clickTimer.current = null; }
    onAsk(id);
  };

  const renderPara = (para, key) => {
    if (typeof para === 'string') return <p className="doc-p" key={key}>{para}</p>;
    return (
      <p className="doc-p" key={key}>
        {para.map((seg, i) => {
          if (typeof seg === 'string') return <span key={i}>{seg}</span>;
          const f = fById[seg.f];
          const isApplied = applied[seg.f];
          const lv = isApplied ? 'low' : seg.lv;
          const text = isApplied && f && f.suggest ? f.suggest.to : seg.t;
          return (
            <mark key={i}
              ref={el => { if (el) segRefs.current[seg.f] = el; }}
              className={'hl hl-' + lv + (active === seg.f ? ' hl-active' : '') + (isApplied ? ' hl-done' : '') + (highlightsOn ? '' : ' hl-off')}
              onMouseEnter={(e) => !isApplied && highlightsOn && onHover(f, e)}
              onMouseMove={(e) => !isApplied && highlightsOn && onHover(f, e)}
              onMouseLeave={() => onHover(null)}
              onClick={() => { onHover(null); handleClick(seg.f); }}
              onDoubleClick={() => { onHover(null); handleDouble(seg.f); }}>
              {isApplied ? <Icon name="check" size={13} stroke={2.6} style={{ verticalAlign: '-2px', marginRight: 2 }} /> : null}
              {text}
            </mark>
          );
        })}
      </p>
    );
  };

  return (
    <div className="doc">
      <div className="doc-head">
        <h1 className="doc-title">{contract.title}</h1>
        <div className="doc-meta">{contract.number} · {contract.place} · {contract.date}</div>
      </div>
      {contract.preamble.map((p, i) => renderPara(p, 'pr' + i))}
      {contract.clauses.map((cl) => (
        <section className="doc-clause" key={cl.num} id={'clause-' + cl.num}>
          <h3 className="doc-clause-title">{cl.num}. {cl.title}</h3>
          {cl.paras.map((p, i) => renderPara(p, cl.num + '-' + i))}
        </section>
      ))}
      {addedClauses.map((m, i) => (
        <section className="doc-clause doc-clause-added" key={'add' + i}>
          <h3 className="doc-clause-title">{contract.clauses.length + 1 + i}. {m.title} <span className="added-tag"><Icon name="check" size={11} stroke={3} /> {t.added}</span></h3>
          <p className="doc-p">{(contract.clauses.length + 1 + i)}.1. {m.clauseText}</p>
        </section>
      ))}
      <p className="doc-p doc-closing">{contract.closing}</p>
      <div className="doc-sign">
        <div><div className="doc-sign-line" />Замовник</div>
        <div><div className="doc-sign-line" />Виконавець</div>
      </div>
    </div>
  );
}

/* ---------- Finding card ---------- */
function FindingCard({ f, active, onClick, applied, onApply, t }) {
  const lvLabel = { high: 'badge-high', med: 'badge-med', low: 'badge-low' }[f.level];
  const isApplied = applied[f.id];
  return (
    <div id={'finding-' + f.id} className={'finding' + (active ? ' finding-active' : '') + (isApplied ? ' finding-done' : '')} onClick={onClick}
      style={{ borderLeftColor: isApplied ? 'var(--risk-low)' : LEVEL_COLOR[f.level] }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span className={'badge-risk ' + (isApplied ? 'badge-low' : lvLabel)}>{f.clause}</span>
        <span style={{ fontSize: 12, color: 'var(--text-3)', marginLeft: 'auto' }}>{isApplied ? <span style={{ color: 'var(--risk-low)', fontWeight: 700 }}>✓ {t.applied}</span> : f.severity}</span>
      </div>
      <div style={{ fontWeight: 650, fontSize: 14.5, marginBottom: 4, letterSpacing: '-0.01em' }}>{f.title}</div>
      <div style={{ fontSize: 13.5, color: 'var(--text-2)', lineHeight: 1.5 }}>{f.desc}</div>

      {f.law ? (
        <div className="law-chip"><Icon name="scales" size={12} /> {t.lawLabel}: {f.law}</div>
      ) : null}

      {f.suggest && active ? (
        <div className="suggest" onClick={e => e.stopPropagation()}>
          <div className="suggest-row suggest-from">
            <span className="suggest-tag">{t.original}</span>
            <span>«{f.suggest.from}»</span>
          </div>
          <div className="suggest-row suggest-to">
            <span className="suggest-tag suggest-tag-good"><Icon name="wand" size={12} /> {t.proposed}</span>
            <span>«{f.suggest.to}»</span>
          </div>
          <button className={'btn btn-sm ' + (isApplied ? 'btn-ghost' : 'btn-primary')} disabled={isApplied}
            style={{ marginTop: 8, opacity: isApplied ? 0.7 : 1 }}
            onClick={() => onApply(f.id)}>
            {isApplied ? <><Icon name="check" size={14} /> {t.applied}</> : <><Icon name="wand" size={14} /> {t.applySuggestion}</>}
          </button>
        </div>
      ) : f.suggest && !isApplied ? (
        <div style={{ marginTop: 8, fontSize: 12.5, color: 'var(--accent)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 5 }}>
          <Icon name="wand" size={13} /> {t.suggestRewrite}
        </div>
      ) : null}
    </div>
  );
}

/* ---------- Legal basis card ---------- */
function LegalBasis({ t, items }) {
  const [open, setOpen] = useState(false);
  const list = Array.isArray(items) && items.length ? items : DEMO.legalBasis;
  return (
    <div className="legal-card">
      <button className="legal-head" onClick={() => setOpen(o => !o)}>
        <span className="legal-ic"><Icon name="scales" size={15} /></span>
        <span style={{ flex: 1, textAlign: 'left' }}>
          <span style={{ fontWeight: 650, fontSize: 13.5, display: 'block' }}>{t.legalBasis}</span>
          <span style={{ fontSize: 11.5, color: 'var(--text-3)' }}>{t.legalBasisSub}</span>
        </span>
        <Icon name="chevD" size={16} style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.18s', color: 'var(--text-3)' }} />
      </button>
      {open && (
        <div className="legal-list">
          {list.map((l, i) => (
            <div className="legal-item" key={i}>
              <span className={'legal-scope legal-' + l.scope}>{l.scope === 'EU' ? 'ЄС' : 'UA'}</span>
              <span style={{ flex: 1 }}>
                <span style={{ fontWeight: 600, fontSize: 13 }}>{l.code}</span>
                <span style={{ display: 'block', fontSize: 11.5, color: 'var(--text-3)' }}>{l.ref}</span>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------- AI Chat (Phase 3.1: backed by POST /api/analyze) ---------- */
// Map the API's `used_articles` into the clause-jump refs the UI already
// renders. Pulls the bare clause number out of strings like "п. 2.3" so the
// double-click jump-to-clause hook keeps working.
function refsFromAnalyzeResponse(response, fallbackRefs) {
  const out = [];
  for (const a of response.used_articles || []) {
    // We jump to *contract* clauses, not codex articles — but if the answer
    // mentions a contract clause by number we can surface it. The codex
    // article numbers themselves are rendered in the answer text already.
    out.push(a.article_number);
  }
  return out.length ? out : (fallbackRefs || []);
}

// Fall back to the prototype's deterministic engine so the chat keeps working
// when running Vite without the FastAPI backend (or with no API_KEY set).
function deterministicAnswer(q) {
  const lc = q.toLowerCase();
  const hit = DEMO.chat.answers.find(e => e.keys.some(k => lc.includes(k)));
  return hit || { a: DEMO.chat.fallback, refs: [] };
}

function Chat({ t, inject }) {
  const D = DEMO;
  const [msgs, setMsgs] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const endRef = useRef(null);

  useEffect(() => {
    const sc = endRef.current && endRef.current.parentElement;
    if (sc) sc.scrollTop = sc.scrollHeight;
  }, [msgs, busy]);

  // Build the contract section payload that Claude grounds the answer on. For
  // now we send the current DEMO contract; once the screen carries an uploaded
  // contract in state, swap this for the active section.
  function activeSection() {
    return {
      title: DEMO.contract && DEMO.contract.title,
      text: DEMO.contract
        ? DEMO.contract.clauses.map(c => `${c.num}. ${c.title}\n` +
            c.paras.map(p => Array.isArray(p)
              ? p.map(seg => typeof seg === 'string' ? seg : seg.t).join('')
              : p
            ).join('\n')
          ).join('\n\n')
        : '',
    };
  }

  async function ask(q) {
    try {
      const res = await api.request('/api/analyze', {
        method: 'POST',
        body: { question: q, contract_section: activeSection() },
      });
      return {
        text: res.answer,
        refs: refsFromAnalyzeResponse(res),
        warnings: res.warnings || [],
      };
    } catch (e) {
      // Offline dev or quota error — degrade to deterministic prototype answer
      // so the screen stays interactive. The bubble shows a small warning
      // chip so the user knows it's not a real model response.
      const det = deterministicAnswer(q);
      return { text: det.a, refs: det.refs, offline: true };
    }
  }

  // external injected question (from double-click on a clause)
  useEffect(() => {
    if (!inject || !inject.ts) return;
    let cancelled = false;
    setMsgs(m => [...m, { role: 'user', text: inject.q }]);
    setBusy(true);
    ask(inject.q).then(ans => {
      if (cancelled) return;
      // Defensive: API errors / offline fallback can return a partial object;
      // optional chaining keeps the Chat alive instead of crashing the screen.
      const refs = (ans?.refs ?? []).length ? ans.refs : (inject?.refs ?? []);
      setMsgs(m => [...m, { role: 'ai', ...(ans ?? {}), refs }]);
      setBusy(false);
    });
    return () => { cancelled = true; };
  }, [inject && inject.ts]);

  const send = async (text) => {
    const q = (text || input).trim();
    if (!q || busy) return;
    setInput('');
    setMsgs(m => [...m, { role: 'user', text: q }]);
    setBusy(true);
    const ans = await ask(q);
    setMsgs(m => [...m, { role: 'ai', ...(ans ?? {}), refs: ans?.refs ?? [] }]);
    setBusy(false);
  };

  const jumpToClause = (num) => {
    const el = document.getElementById('clause-' + num);
    const scroller = document.querySelector('.doc-scroll');
    if (el && scroller) {
      const top = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 24;
      scroller.scrollTo({ top, behavior: 'smooth' });
    }
  };

  return (
    <div className="chat view-enter">
      <div className="chat-scroll">
        {msgs.length === 0 && (
          <div className="chat-empty">
            <div className="chat-orb"><Icon name="sparkle" size={22} fill={true} /></div>
            <div style={{ fontWeight: 700, fontSize: 16, marginTop: 12 }}>{t.chatTitle}</div>
            <div style={{ fontSize: 13.5, color: 'var(--text-3)', marginTop: 4, maxWidth: 300 }}>{t.chatSub}</div>
            <div className="chat-suggest-label">{t.chatSuggest}</div>
            <div className="chat-suggests">
              {D.chat.suggestions.map((s, i) => (
                <button key={i} className="chat-chip" onClick={() => send(s)}>{s}</button>
              ))}
            </div>
          </div>
        )}

        {msgs.map((m, i) => (
          <div key={i} className={'msg msg-' + m.role}>
            {m.role === 'ai' && <span className="msg-av"><Icon name="sparkle" size={13} fill={true} /></span>}
            <div className="msg-bubble">
              {m.text}
              {m.refs && m.refs.length > 0 && (
                <div className="msg-refs">
                  {m.refs.map(r => (
                    <button key={r} className="msg-ref" onClick={() => jumpToClause(r)}>
                      <Icon name="arrowR" size={12} /> {t.chatJump} {r}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}

        {busy && (
          <div className="msg msg-ai">
            <span className="msg-av"><Icon name="sparkle" size={13} fill={true} /></span>
            <div className="msg-bubble msg-typing"><span /><span /><span />{t.chatThinking}</div>
          </div>
        )}
        <div ref={endRef} />
      </div>

      <div className="chat-input-wrap">
        <div className="chat-input">
          <input value={input} placeholder={t.chatPlaceholder}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') send(); }} />
          <button className="chat-send" onClick={() => send()} disabled={!input.trim() || busy} aria-label="send">
            <Icon name="arrowR" size={17} />
          </button>
        </div>
        <div className="chat-disclaimer">{t.chatDisclaimer}</div>
      </div>
    </div>
  );
}

/* ---------- AI panel ---------- */
function AiPanel({ t, tab, setTab, active, setActive, applied, onApply, onApplyAll, scrollToSeg, chatInject, addedSet, onAddClause, data, isDemo }) {
  // `data` (always defined) is the merged real-or-demo bundle from
  // ContractAnalysis. Demo-only fields (missing/keyData/summary) still come
  // from DEMO until the backend learns to return them (Task 5/future).
  const findings = data.findings;
  const comparison = data.comparison;
  const legalBasis = data.legalBasis;
  const missing = data.missing;
  const keyData = data.keyData;
  const summary = data.summary;
  const warnings = data.warnings;
  const [filter, setFilter] = useState('all');

  const appliedWeight = findings.reduce((s, f) => s + (applied[f.id] ? (f.weight || 0) : 0), 0);
  const liveScore = Math.min(92, (data.score?.value || 0) + appliedWeight);
  const openHigh = findings.filter(f => f.level === 'high' && !applied[f.id]).length;
  const openMed = findings.filter(f => f.level === 'med' && !applied[f.id]).length;
  const resolved = findings.filter(f => applied[f.id]).length;
  const scoreLabel = liveScore >= 80 ? t.scoreLow : liveScore >= 58 ? t.scoreMed : t.scoreHigh;
  const scoreColor = liveScore >= 75 ? 'var(--risk-low)' : liveScore >= 55 ? 'var(--risk-med)' : 'var(--risk-high)';

  const fixable = findings.filter(f => f.suggest);
  const allFixed = fixable.every(f => applied[f.id]);
  const filtered = filter === 'all' ? findings : findings.filter(f => f.level === (filter === 'crit' ? 'high' : 'med'));

  const tabs = [
    { id: 'risks', label: t.tabRisks, n: openHigh + openMed },
    { id: 'chat', label: t.tabChat, icon: 'sparkle' },
    { id: 'summary', label: t.tabSummary },
    { id: 'data', label: t.tabData },
    { id: 'missing', label: t.tabMissing, n: missing.length - addedSet.size },
    { id: 'compare', label: t.tabCompare },
  ];

  const statusMap = {
    ok: ['var(--risk-low)', t.statusOk, 'check'],
    warn: ['var(--risk-med)', t.statusWarn, 'alert'],
    deviate: ['var(--risk-med)', t.statusDeviate, 'flag'],
    missing: ['var(--risk-high)', t.statusMissing, 'x'],
  };

  return (
    <div className="aipanel">
      <div className="aipanel-head">
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, color: 'var(--accent)', fontWeight: 700, fontSize: 13.5, marginBottom: 12 }}>
          <Icon name="sparkle" size={16} fill={true} /> {t.aiAnalysis}
          {isDemo ? (
            <span title={t.demoBadgeSub || ''} style={{
              marginLeft: 'auto', fontSize: 10.5, fontWeight: 800, letterSpacing: '0.06em',
              textTransform: 'uppercase', color: 'var(--text-3)',
              border: '1px solid var(--border)', borderRadius: 999, padding: '2px 8px',
            }}>{t.demoBadge || 'demo'}</span>
          ) : null}
        </div>
        {warnings.length > 0 ? (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 7, marginBottom: 10,
            padding: '6px 10px', borderRadius: 8,
            background: 'var(--risk-med-soft)', color: 'var(--risk-med)',
            fontSize: 12.5,
          }}>
            <Icon name="alert" size={13} />
            <span style={{ flex: 1 }}>{warnings.join(' · ')}</span>
          </div>
        ) : null}
        <div className="score-block">
          <ScoreRing value={liveScore} size={66} />
          <div>
            <div style={{ fontSize: 12.5, color: 'var(--text-3)', fontWeight: 600 }}>{t.riskScore}</div>
            <div style={{ fontSize: 17, fontWeight: 700, color: scoreColor }}>{scoreLabel}</div>
            <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
              <span className="mini-stat"><b style={{ color: 'var(--risk-high)' }}>{openHigh}</b> {t.critShort}</span>
              <span className="mini-stat"><b style={{ color: 'var(--risk-med)' }}>{openMed}</b> {t.modShort}</span>
              {resolved > 0 && <span className="mini-stat"><b style={{ color: 'var(--risk-low)' }}>{resolved}</b> {t.riskResolved}</span>}
            </div>
          </div>
        </div>
      </div>

      <div className="aitabs">
        {tabs.map(tb => (
          <button key={tb.id} className={'aitab' + (tab === tb.id ? ' on' : '')} onClick={() => setTab(tb.id)}>
            {tb.icon ? <Icon name={tb.icon} size={13} fill={true} /> : null}
            {tb.label}{tb.n != null ? <span className="aitab-n">{tb.n}</span> : null}
          </button>
        ))}
      </div>

      {tab === 'chat'
        ? <Chat t={t} inject={chatInject} />
        : (
        <div className="aipanel-body">
          {tab === 'risks' && (
            <div className="view-enter" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <LegalBasis t={t} items={legalBasis} />
              <div className="risk-toolbar">
                <div className="seg seg-sm">
                  {[['all', t.filterAll], ['crit', t.filterCrit], ['mod', t.filterMod]].map(([id, lbl]) => (
                    <button key={id} className={filter === id ? 'on' : ''} onClick={() => setFilter(id)}>{lbl}</button>
                  ))}
                </div>
              </div>
              <button className={'btn ' + (allFixed ? 'btn-ghost' : 'btn-primary')} disabled={allFixed}
                onClick={onApplyAll} style={{ justifyContent: 'center', width: '100%' }}>
                {allFixed ? <><Icon name="check" size={15} /> {t.allApplied}</> : <><Icon name="wand" size={15} /> {t.applyAll} ({fixable.filter(f => !applied[f.id]).length})</>}
              </button>
              {filtered.map(f => (
                <FindingCard key={f.id} f={f} t={t} applied={applied}
                  active={active === f.id}
                  onApply={onApply}
                  onClick={() => { setActive(active === f.id ? null : f.id); scrollToSeg(f.id); }} />
              ))}
            </div>
          )}

          {tab === 'summary' && (
            <div className="view-enter">
              <div className="ai-callout">
                <Icon name="sparkle" size={15} fill={true} style={{ color: 'var(--accent)', flexShrink: 0, marginTop: 2 }} />
                <div>
                  <div style={{ fontWeight: 700, marginBottom: 6 }}>{t.summaryTitle}</div>
                  <p style={{ margin: 0, fontSize: 14, lineHeight: 1.6, color: 'var(--text-2)' }}>{summary}</p>
                </div>
              </div>
              <LegalBasis t={t} items={legalBasis} />
            </div>
          )}

          {tab === 'data' && (
            <div className="view-enter" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              {keyData.map((d, i) => (
                <div className="data-card" key={i}>
                  <div className="data-ic"><Icon name={d.icon} size={16} /></div>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 11.5, color: 'var(--text-3)', fontWeight: 600 }}>{d.label}</div>
                    <div style={{ fontSize: 14, fontWeight: 650, letterSpacing: '-0.01em' }}>{d.value}</div>
                    <div style={{ fontSize: 11.5, color: 'var(--text-3)' }}>{d.sub}</div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {tab === 'missing' && (
            <div className="view-enter">
              <div style={{ fontSize: 13, color: 'var(--text-3)', marginBottom: 10 }}>{t.missingSub}</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                {missing.map((m, i) => {
                  const added = addedSet.has(i);
                  return (
                    <div className={'miss-card' + (added ? ' miss-done' : '')} key={i}>
                      <div className="miss-ic" style={added ? { background: 'var(--risk-low-soft)', color: 'var(--risk-low)' } : null}>
                        <Icon name={added ? 'check' : 'x'} size={13} stroke={2.6} />
                      </div>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 650, fontSize: 14 }}>{m.title}</div>
                        <div style={{ fontSize: 12.5, color: 'var(--text-2)', marginTop: 2 }}>{m.note}</div>
                        {m.law ? <div className="law-chip" style={{ marginTop: 6 }}><Icon name="scales" size={11} /> {m.law}</div> : null}
                      </div>
                      {added
                        ? <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--risk-low)', whiteSpace: 'nowrap' }}>✓ {t.added}</span>
                        : <button className="btn btn-sm btn-subtle" onClick={() => onAddClause(i)}><Icon name="plus" size={14} /> {t.addClause}</button>}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {tab === 'compare' && (
            <div className="view-enter">
              <div style={{ fontSize: 13, color: 'var(--text-3)', marginBottom: 10 }}>{t.compareSub}</div>
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {comparison.map((c, i) => {
                  const [col, label, ic] = statusMap[c.status];
                  return (
                    <div className="cmp-row" key={i}>
                      <span className="cmp-ic" style={{ background: `color-mix(in oklab, ${col} 16%, transparent)`, color: col }}>
                        <Icon name={ic} size={12} stroke={2.6} />
                      </span>
                      <span style={{ fontWeight: 600, fontSize: 13.5, flex: 1 }}>{c.clause}</span>
                      <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{c.note}</span>
                      <span className="cmp-status" style={{ color: col }}>{label}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------- Protocol modal content ---------- */
function ProtocolModal({ open, onClose, t, findings }) {
  const list = Array.isArray(findings) ? findings : DEMO.findings;
  const rows = list.filter(f => f.suggest);
  const copyAll = () => {
    const text = rows.map((f, i) => `${i + 1}. ${f.clause} — ${f.title}\n  ${t.protoCurrent}: ${f.suggest.from}\n  ${t.protoProposed}: ${f.suggest.to}\n  ${t.protoBasis}: ${f.law || '—'}`).join('\n\n');
    try { navigator.clipboard.writeText(text); } catch (e) {}
    toast(t.copied, 'check');
  };
  return (
    <Modal open={open} onClose={onClose} title={t.protocolTitle} sub={t.protocolSub} icon="scales" wide
      footer={<>
        <button className="btn btn-subtle" onClick={onClose}>{t.close}</button>
        <button className="btn btn-primary" onClick={copyAll}><Icon name="doc" size={15} /> {t.copy}</button>
      </>}>
      <table className="proto-table">
        <thead>
          <tr><th style={{ width: 64 }}>{t.protoClause}</th><th>{t.protoCurrent}</th><th>{t.protoProposed}</th></tr>
        </thead>
        <tbody>
          {rows.map((f, i) => (
            <tr key={f.id}>
              <td><span className="badge-risk badge-info">{f.clause}</span></td>
              <td className="proto-from">{f.suggest.from}</td>
              <td className="proto-to">{f.suggest.to}<div className="proto-law"><Icon name="scales" size={11} /> {f.law}</div></td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}

/* ---------- Analyzing overlay ---------- */
function AnalyzingOverlay({ t }) {
  const steps = t.analyzeSteps;
  const [step, setStep] = useState(0);
  const [pct, setPct] = useState(6);
  useEffect(() => {
    const si = setInterval(() => setStep(s => Math.min(s + 1, steps.length - 1)), 460);
    const pi = setInterval(() => setPct(p => Math.min(p + Math.random() * 14 + 4, 98)), 230);
    return () => { clearInterval(si); clearInterval(pi); };
  }, []);
  return (
    <div className="analyzing">
      <div className="analyzing-card">
        <div className="analyzing-orb"><Icon name="sparkle" size={26} fill={true} /></div>
        <div style={{ fontSize: 18, fontWeight: 700, marginTop: 16 }}>{t.analyzing}</div>
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

/* ---------- Pending document handoff (Fix 2) ---------- */
const PENDING_ANALYSIS_KEY = 'aglex_pending_analysis';

// Pop the pending document once. Returns null if nothing is queued or the
// payload is malformed. Always clears the key so re-opening the screen is a
// clean slate.
function popPendingAnalysis() {
  if (typeof localStorage === 'undefined') return null;
  const raw = localStorage.getItem(PENDING_ANALYSIS_KEY);
  if (!raw) return null;
  try { localStorage.removeItem(PENDING_ANALYSIS_KEY); } catch (_e) {}
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.markdown) return null;
    return parsed;
  } catch (_e) {
    return null;
  }
}

function PendingAnalysisBanner({ t, name, status, analysis, onRetry, onClose }) {
  const findings = (analysis && analysis.findings) || [];
  const score = analysis && analysis.score;
  const warnings = (analysis && analysis.warnings) || [];
  return (
    <div style={{
      borderBottom: '1px solid var(--border)',
      background: 'var(--panel)',
      padding: 'var(--s4) var(--s5)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span className="chip"><Icon name="wand" size={13} /> {t.builder || 'Конструктор'}</span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontWeight: 700, fontSize: 14, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {name}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
            {status === 'loading' ? (t.analyzing || 'Аналізуємо документ…') : null}
            {status === 'ready' && score
              ? `${findings.length} ризиків · оцінка ${score.value}/100 · ${score.label}`
              : null}
            {status === 'error' ? (
              'Документ завантажено. Натисніть «Аналізувати» вручну.'
            ) : null}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {status === 'error' ? (
            <button className="btn btn-primary btn-sm" onClick={onRetry}>
              <Icon name="refresh" size={14} /> Аналізувати
            </button>
          ) : null}
          <button className="icon-btn icon-btn-sm" onClick={onClose} aria-label="close">
            <Icon name="x" size={16} />
          </button>
        </div>
      </div>

      {status === 'loading' ? (
        <div style={{ marginTop: 'var(--s4)', height: 4, background: 'var(--border)', borderRadius: 2, overflow: 'hidden' }}>
          <div style={{ height: '100%', width: '40%', background: 'var(--accent)', animation: 'progress-slide 1.4s ease-in-out infinite' }} />
        </div>
      ) : null}

      {status === 'ready' && findings.length > 0 ? (
        <div style={{ marginTop: 'var(--s4)', display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {findings.slice(0, 6).map((f, i) => (
            <div key={f.id || i} style={{
              padding: '6px 10px',
              borderRadius: 999,
              border: '1px solid var(--border)',
              fontSize: 12,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
            }}>
              <span className={'badge-risk ' + ({ high: 'badge-high', med: 'badge-med', low: 'badge-low' }[f.level] || 'badge-med')}
                    style={{ fontSize: 10 }}>{f.clause}</span>
              <span style={{ fontWeight: 600 }}>{f.title}</span>
              {f.law ? <span style={{ color: 'var(--text-3)' }}>· {f.law}</span> : null}
            </div>
          ))}
          {findings.length > 6 ? (
            <span style={{ alignSelf: 'center', fontSize: 12, color: 'var(--text-3)' }}>
              +{findings.length - 6}
            </span>
          ) : null}
        </div>
      ) : null}

      {warnings.length > 0 ? (
        <div style={{ marginTop: 'var(--s3)', fontSize: 12, color: 'var(--risk-med)' }}>
          <Icon name="alert" size={11} /> {warnings.join(' · ')}
        </div>
      ) : null}
    </div>
  );
}

/* ---------- Main analysis view ---------- */
function ContractAnalysis({ t, incoming }) {
  const D = DEMO;
  // Real analysis result from POST /api/analyze/contract. Null until the
  // round-trip completes (or never, in demo mode).
  const [analysis, setAnalysis] = useState(null);
  // 'demo'    — no incoming doc, showing DEMO with a badge
  // 'loading' — incoming.markdown is being analyzed
  // 'ready'   — analysis received, panels show real findings
  // 'error'   — API failed, degraded to DEMO with badge
  const [analysisStatus, setAnalysisStatus] = useState(incoming ? 'loading' : 'demo');

  // Merged data source: real fields override DEMO when available. `missing` /
  // `keyData` / `summary` aren't returned by /api/analyze/contract yet — they
  // stay on DEMO until Task 5/future extends the backend.
  const data = useMemo(() => ({
    findings: analysis?.findings ?? D.findings,
    comparison: analysis?.comparison ?? D.comparison,
    legalBasis: analysis?.legal_basis ?? D.legalBasis,
    score: analysis?.score ?? D.score,
    warnings: analysis?.warnings ?? [],
    missing: D.missing,
    keyData: D.keyData,
    summary: D.summary,
  }), [analysis, D]);
  const isDemo = analysisStatus === 'demo' || analysisStatus === 'error';

  const fById = useMemo(() => Object.fromEntries(data.findings.map(f => [f.id, f])), [data.findings]);
  const [phase, setPhase] = useState('loading');
  const [tab, setTab] = useState('risks');
  const [active, setActive] = useState(null);
  const [applied, setApplied] = useState({});
  const [highlightsOn, setHighlightsOn] = useState(true);
  const [tooltip, setTooltip] = useState(null);     // { f, x, y }
  const [protocolOpen, setProtocolOpen] = useState(false);
  const [addedSet, setAddedSet] = useState(new Set());
  const [chatInject, setChatInject] = useState(null);
  const [verOpen, setVerOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [curVer, setCurVer] = useState('v2');
  const [diffOpen, setDiffOpen] = useState(false);
  const [apprOpen, setApprOpen] = useState(false);
  const [commOpen, setCommOpen] = useState(false);
  const [dlOpen, setDlOpen] = useState(false);
  const [sumOpen, setSumOpen] = useState(false);
  const [trOpen, setTrOpen] = useState(false);
  const [apprSteps, setApprSteps] = useState(LX.approval);
  const [comments, setComments] = useState(LX.comments);

  // Mount: if we got an uploaded doc, analyze it for real. Cancellable so a
  // route change mid-flight doesn't write to a stale state.
  const liveRef = useRef(true);
  useEffect(() => {
    liveRef.current = true;
    if (!incoming || !incoming.markdown) return () => { liveRef.current = false; };
    let cancelled = false;
    (async () => {
      try {
        const res = await api.analyzeContract({
          markdown: incoming.markdown,
          sections: incoming.sections,
        });
        if (cancelled || !liveRef.current) return;
        setAnalysis(res);
        setAnalysisStatus('ready');
        setPhase('ready');
      } catch (_e) {
        if (cancelled || !liveRef.current) return;
        // Backend down or 502 — surface as demo fallback so the screen stays
        // useful. A toast at the call site would be nicer but the existing
        // demo flow shows the badge + same content, which is the safest UX.
        toast(t.uploadError || 'Analysis failed', 'alert');
        setAnalysisStatus('error');
        setPhase('ready');
      }
    })();
    return () => { cancelled = true; liveRef.current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incoming]);
  // Fix 2: state for the document handoff from DocBuilder ("Відкрити в аналізі").
  // `pendingDoc.markdown` is the freshly-generated contract; `pendingStatus`
  // tracks the auto-triggered /api/analyze/contract round-trip.
  const [pendingDoc, setPendingDoc] = useState(null);          // {markdown, name, typeId} | null
  const [pendingStatus, setPendingStatus] = useState('idle');  // idle | loading | ready | error
  const [pendingAnalysis, setPendingAnalysis] = useState(null);
  const segRefs = useRef({});
  const docScrollRef = useRef(null);

  // Fix 2: load pending document from DocBuilder handoff. One-shot: the
  // localStorage key is cleared *immediately* (inside popPendingAnalysis) so a
  // subsequent visit to this screen doesn't accidentally re-trigger analysis.
  // Audit fix #6: ref-based cancellation flag prevents state writes after
  // unmount (route change during in-flight /api/analyze/contract).
  const pendingAlive = useRef(true);
  useEffect(() => {
    pendingAlive.current = true;
    const pending = popPendingAnalysis();
    if (!pending) return () => { pendingAlive.current = false; };
    const niceName = `Чернетка${pending.typeId ? ` (${pending.typeId})` : ''}`;
    setPendingDoc({ markdown: pending.markdown, name: niceName, typeId: pending.typeId });
    runPendingAnalysis(pending.markdown);
    return () => { pendingAlive.current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function runPendingAnalysis(markdown) {
    if (!pendingAlive.current) return;
    setPendingStatus('loading');
    try {
      const res = await api.request('/api/analyze/contract', {
        method: 'POST',
        body: { markdown },
      });
      if (!pendingAlive.current) return;
      setPendingAnalysis(res);
      setPendingStatus('ready');
    } catch (_e) {
      // Don't kill the UX on API failure — fall back to the manual retry
      // banner. The screen still shows the prototype document underneath.
      if (!pendingAlive.current) return;
      setPendingStatus('error');
    }
  }

  // Demo polish: 2.35s fake overlay only when there's no real incoming doc.
  // With incoming.markdown the analyze() effect above drives phase → 'ready'
  // once the real API call resolves (or errors out).
  useEffect(() => {
    if (phase !== 'loading') return;
    if (incoming && incoming.markdown) return;
    const tm = setTimeout(() => setPhase('ready'), 2350);
    return () => clearTimeout(tm);
  }, [phase, incoming]);

  const scrollToSeg = (id) => {
    const el = segRefs.current[id];
    const scroller = docScrollRef.current;
    if (el && scroller) {
      const top = el.offsetTop - scroller.clientHeight / 2 + 40;
      scroller.scrollTo({ top, behavior: 'smooth' });
    }
  };
  const scrollFindingCard = (id) => {
    setTimeout(() => {
      const el = document.getElementById('finding-' + id);
      if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }, 60);
  };

  const onApply = (id) => setApplied(a => ({ ...a, [id]: true }));
  const onApplyAll = () => {
    const next = {};
    data.findings.forEach(f => { if (f.suggest) next[f.id] = true; });
    setApplied(a => ({ ...a, ...next }));
    toast(t.allApplied, 'wand');
  };
  const reanalyze = () => { setPhase('loading'); setActive(null); setApplied({}); setTab('risks'); setAddedSet(new Set()); };

  // hover tooltip
  const onHover = (f, e) => {
    if (!f) { setTooltip(null); return; }
    setTooltip({ f, x: e.clientX, y: e.clientY });
  };
  // single click → open in right panel
  const onPick = (id) => {
    setTab('risks'); setActive(id); scrollToSeg(id); scrollFindingCard(id);
  };
  // double click → ask in chat
  const onAsk = (id) => {
    const f = fById[id];
    const num = (f.clause.match(/\d+/) || ['1'])[0];
    const q = `${t.chatJump} ${f.clause}: ${f.title}?`;
    const a = `${f.desc}${f.law ? ' (' + t.lawLabel + ': ' + f.law + ')' : ''}${f.suggest ? ' ' + t.proposed + ': ' + f.suggest.to : ''}`;
    setTab('chat');
    setChatInject({ q: f.title + ' — ' + f.clause + '?', a, refs: [num], ts: Date.now() });
  };
  const onAddClause = (idx) => {
    setAddedSet(s => { const n = new Set(s); n.add(idx); return n; });
    toast(t.clauseAdded, 'check');
  };

  const addedClauses = data.missing.filter((_, i) => addedSet.has(i));

  return (
    <div className="analysis">
      <div className="analysis-bar">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
          <span className="chip"><Icon name="doc" size={13} /> {D.contract.number}</span>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 15, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{D.contract.title}</div>
            <div style={{ fontSize: 12, color: 'var(--text-3)' }}>{D.keyData[0].value} · {D.contract.date}</div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto' }}>
          <label className="hl-toggle">
            <input type="checkbox" checked={highlightsOn} onChange={e => setHighlightsOn(e.target.checked)} />
            <span className="hl-track"><span className="hl-knob" /></span>
            {t.highlightOn}
          </label>
          <div style={{ position: 'relative' }}>
            <button className="btn btn-ghost btn-sm" onClick={() => setVerOpen(o => !o)}>
              <Icon name="book" size={15} /> {LX.versions.find(v => v.id === curVer).label} <Icon name="chevD" size={13} />
            </button>
            {verOpen && <>
              <div className="menu-backdrop" onClick={() => setVerOpen(false)} />
              <div className="menu" style={{ minWidth: 280 }}>
                <div className="menu-head">{t.versionsTitle}</div>
                {LX.versions.map(v => (
                  <button key={v.id} className={'ver-item' + (curVer === v.id ? ' on' : '')} onClick={() => { setCurVer(v.id); setVerOpen(false); }}>
                    <UserAvatar id={v.author} size={26} />
                    <span style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                      <span style={{ fontWeight: 600, fontSize: 13.5, display: 'block' }}>{v.label}{v.current ? ' · ' + t.currentVer : v.draft ? ' · ' + t.draftVer : ''}</span>
                      <span style={{ fontSize: 11.5, color: 'var(--text-3)' }}>{v.note} · {v.date}</span>
                    </span>
                    {v.changes > 0 ? <span className="ver-chg">+{v.changes}</span> : null}
                  </button>
                ))}
                <button className="menu-item" style={{ marginTop: 4, borderTop: '1px solid var(--border)', borderRadius: 0, paddingTop: 10 }} onClick={() => { setVerOpen(false); setDiffOpen(true); }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}><Icon name="scan" size={15} /> {t.compare}</span>
                </button>
              </div>
            </>}
          </div>
          <button className="btn btn-ghost btn-sm" onClick={() => setTab('chat')}><Icon name="sparkle" size={15} fill={true} /> {t.tabChat}</button>
          <button className="btn btn-primary btn-sm" onClick={() => setProtocolOpen(true)}><Icon name="scales" size={15} /> {t.protocol}</button>
          <div style={{ position: 'relative' }}>
            <button className="icon-btn" style={{ width: 34, height: 34 }} onClick={() => setMoreOpen(o => !o)} aria-label="more"><Icon name="menu" size={18} /></button>
            {moreOpen && <>
              <div className="menu-backdrop" onClick={() => setMoreOpen(false)} />
              <div className="menu">
                <button className="menu-item" onClick={() => { setMoreOpen(false); setSumOpen(true); }}><span style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Icon name="sparkle" size={15} fill={true} /> {t.sumMenu}</span></button>
                <button className="menu-item" onClick={() => { setMoreOpen(false); setTrOpen(true); }}><span style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Icon name="globe" size={15} /> {t.trMenu}</span></button>
                <button className="menu-item" onClick={() => { setMoreOpen(false); setDiffOpen(true); }}><span style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Icon name="scan" size={15} /> {t.compareTitle}</span></button>
                <button className="menu-item" onClick={() => { setMoreOpen(false); setApprOpen(true); }}><span style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Icon name="checkCircle" size={15} /> {t.approvalTitle}</span></button>
                <button className="menu-item" onClick={() => { setMoreOpen(false); setCommOpen(true); }}><span style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Icon name="bell" size={15} /> {t.comments}</span><span className="aitab-n">{comments.filter(c => !c.resolved).length}</span></button>
                <button className="menu-item" onClick={() => { setMoreOpen(false); setDlOpen(true); }}><span style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Icon name="calendar" size={15} /> {t.obligTitle}</span></button>
                <button className="menu-item" onClick={() => { setMoreOpen(false); reanalyze(); }}><span style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Icon name="refresh" size={15} /> {t.reanalyze}</span></button>
              </div>
            </>}
          </div>
        </div>
      </div>

      {pendingDoc ? (
        <PendingAnalysisBanner
          t={t}
          name={pendingDoc.name}
          status={pendingStatus}
          analysis={pendingAnalysis}
          onRetry={() => runPendingAnalysis(pendingDoc.markdown)}
          onClose={() => { setPendingDoc(null); setPendingAnalysis(null); setPendingStatus('idle'); }}
        />
      ) : null}

      <div className="analysis-body">
        <div className="doc-scroll" ref={docScrollRef}>
          {phase === 'loading'
            ? <AnalyzingOverlay t={t} />
            : <div className="view-enter">
                <ContractDoc contract={D.contract} fById={fById} active={active} applied={applied}
                  highlightsOn={highlightsOn} segRefs={segRefs} addedClauses={addedClauses} t={t}
                  onHover={onHover} onPick={onPick} onAsk={onAsk} />
              </div>}
          {tooltip && (
            <div className="hl-tip" style={{ left: tooltip.x, top: tooltip.y }}>
              <div className="hl-tip-head">
                <span className={'badge-risk ' + { high: 'badge-high', med: 'badge-med', low: 'badge-low' }[tooltip.f.level]}>{tooltip.f.clause}</span>
                <span style={{ fontWeight: 650, fontSize: 13 }}>{tooltip.f.title}</span>
              </div>
              <div className="hl-tip-desc">{tooltip.f.desc}</div>
              {tooltip.f.law ? <div className="hl-tip-law"><Icon name="scales" size={11} /> {tooltip.f.law}</div> : null}
              <div className="hl-tip-hint">{t.hoverHint}</div>
            </div>
          )}
        </div>
        <div className={'panel-wrap' + (phase === 'loading' ? ' panel-loading' : '')}>
          {phase === 'ready'
            ? <AiPanel t={t} tab={tab} setTab={setTab} active={active} setActive={setActive}
                applied={applied} onApply={onApply} onApplyAll={onApplyAll} scrollToSeg={scrollToSeg}
                chatInject={chatInject} addedSet={addedSet} onAddClause={onAddClause}
                data={data} isDemo={isDemo} />
            : <PanelSkeleton />}
        </div>
      </div>

      <ProtocolModal open={protocolOpen} onClose={() => setProtocolOpen(false)} t={t} findings={data.findings} />
      <DiffModal open={diffOpen} onClose={() => setDiffOpen(false)} t={t} />
      <SummaryModal open={sumOpen} onClose={() => setSumOpen(false)} t={t} />
      <TranslateModal open={trOpen} onClose={() => setTrOpen(false)} t={t} />
      <ApprovalModal open={apprOpen} onClose={() => setApprOpen(false)} t={t} steps={apprSteps} setSteps={setApprSteps} />
      <CommentsModal open={commOpen} onClose={() => setCommOpen(false)} t={t} comments={comments} setComments={setComments} />
      <DeadlinesModal open={dlOpen} onClose={() => setDlOpen(false)} t={t} />
    </div>
  );
}

function PanelSkeleton() {
  return (
    <div style={{ padding: 'var(--s5)' }}>
      <div className="skel" style={{ height: 90, marginBottom: 18 }} />
      <div className="skel" style={{ height: 34, marginBottom: 16 }} />
      {[0,1,2,3].map(i => <div key={i} className="skel" style={{ height: 78, marginBottom: 12 }} />)}
    </div>
  );
}

export { ContractAnalysis };
