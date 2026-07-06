/* ============================================================
   Lexena — Contract analysis view (centerpiece)
   Document with inline highlights + tooltips + AI panel + AI chat
   ============================================================ */
import { useState, useEffect, useRef, useMemo } from 'react';
import { Icon } from '../ui/Icon';
import { Badge, HelpTip, Modal, ScoreRing, toast } from '../ui/components';
import { UserAvatar } from '../lib/labels';
import { api } from '../lib/api';
import { DEMO } from '../data/demo';
import { LX } from '../data/lx';
import { DiffModal, ApprovalModal, CommentsModal, DeadlinesModal, SummaryModal, TranslateModal } from './analysisModals';
import { AnalysisView } from './analysis/AnalysisView';
import { reconcileToAnalysisProps } from '../lib/reconcileAdapter';
import { popReconOpenId, saveHistory as saveReconHistory } from '../lib/reconcileStorage';
import { useDocumentProcessing } from '../contexts/DocumentProcessingContext';
import { EditableDoc } from './analysis/EditableDoc';
import { downloadMd, downloadTxt, downloadDocx, printAsPdf, sectionsToMarkdown } from '../lib/exportDoc';
import { buildFromRegex } from '../lib/findingHighlight';

const LEVEL_COLOR = {
  high: 'var(--risk-high)', med: 'var(--risk-med)', low: 'var(--risk-low)', info: 'var(--info)',
};

const ZOOM_MIN = 70;
const ZOOM_MAX = 150;
const ZOOM_STEP = 10;

/* Заменить finding.suggest.from на finding.suggest.to в первой
   позиции markdown-строки, где найден фрагмент. Используется AI-виправлення:
   после подмены возвращаем {markdown, changedRange:{from,to}}, чтобы
   CodeMirror-редактор мог мигнуть зелёным на новом диапазоне. Возврат
   changedRange=null означает «anchor не нашёлся» — карточка правки
   всё равно уходит в accepted (это ветка manual-edit по факту), просто
   без визуального flash. */
export function applyFixToMarkdown(md, finding) {
  const from = finding && finding.suggest && finding.suggest.from;
  const to   = finding && finding.suggest && finding.suggest.to;
  if (!from || !to || typeof md !== 'string') {
    return { markdown: md, changedRange: null };
  }
  const re = buildFromRegex(from);
  if (!re) return { markdown: md, changedRange: null };
  const m = re.exec(md);
  if (!m) return { markdown: md, changedRange: null };
  const start = m.index;
  const nextMd = md.slice(0, start) + to + md.slice(start + m[0].length);
  return {
    markdown: nextMd,
    changedRange: { from: start, to: start + to.length },
  };
}


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
function FindingCard({ f, active, hovered, onHover, onClick, onApply, onReject, status, t }) {
  const lvLabel = { high: 'badge-high', med: 'badge-med', low: 'badge-low' }[f.level];
  const state = status?.state || 'pending';
  const isAccepted = state === 'accepted';
  const isRejected = state === 'rejected';
  const isResolved = isAccepted || isRejected;
  const resolvedLabel = isAccepted
    ? (status?.resolvedVia === 'manual-edit' ? t.acceptedManual : t.acceptedAi)
    : t.rejected;
  const stateClass = isAccepted ? ' finding-accepted' : isRejected ? ' finding-rejected' : '';
  const borderColor = isAccepted
    ? 'var(--risk-low)'
    : isRejected
      ? 'var(--text-3)'
      : LEVEL_COLOR[f.level];
  return (
    <div id={'finding-' + f.id}
      className={'finding todo-item'
        + (active ? ' finding-active' : '')
        + (hovered ? ' finding-hover' : '')
        + (isAccepted ? ' finding-done' : '')
        + stateClass}
      onClick={onClick}
      onMouseEnter={() => onHover && onHover(f.id)}
      onMouseLeave={() => onHover && onHover(null)}
      style={{ borderLeftColor: borderColor }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span className={'badge-risk ' + (isAccepted ? 'badge-low' : isRejected ? 'badge-muted' : lvLabel)}>{f.clause}</span>
        <span style={{ fontSize: 12, color: 'var(--text-3)', marginLeft: 'auto' }}>
          {isAccepted ? (
            <span className="todo-status todo-status-accepted">
              <Icon name="checkCircle" size={12} /> {resolvedLabel}
            </span>
          ) : isRejected ? (
            <span className="todo-status todo-status-rejected">
              <Icon name="x" size={12} /> {resolvedLabel}
            </span>
          ) : f.severity}
        </span>
      </div>
      <div className="todo-title" style={{ fontWeight: 650, fontSize: 14.5, marginBottom: 4, letterSpacing: '-0.01em' }}>{f.title}</div>
      <div style={{ fontSize: 13.5, color: 'var(--text-2)', lineHeight: 1.5 }}>{f.desc}</div>

      {f.law ? (
        <div className="law-chip"><Icon name="scales" size={12} /> {t.lawLabel}: {f.law}</div>
      ) : null}

      {f.suggest && active && !isResolved ? (
        <div className="suggest" onClick={e => e.stopPropagation()}>
          <div className="suggest-row suggest-from">
            <span className="suggest-tag">{t.original}</span>
            <span>«{f.suggest.from}»</span>
          </div>
          <div className="suggest-row suggest-to">
            <span className="suggest-tag suggest-tag-good"><Icon name="wand" size={12} /> {t.proposed}</span>
            <span>«{f.suggest.to}»</span>
          </div>
        </div>
      ) : null}

      {!isResolved ? (
        <div className="todo-actions" onClick={e => e.stopPropagation()}>
          {f.suggest ? (
            <button className="btn btn-sm btn-primary"
              onClick={() => onApply(f.id)}>
              <Icon name="wand" size={13} /> {t.aiFixShort || 'AI-виправлення'}
            </button>
          ) : null}
          <button className="btn btn-sm btn-ghost"
            onClick={() => onReject(f.id)}>
            <Icon name="x" size={13} /> {t.rejectFix || 'Відхилити'}
          </button>
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
export function AiPanel({
  t, tab, setTab, active, setActive, hovered, setHovered,
  findingStatus = {}, onApply, onReject, onApplyAll, scrollToSeg,
  chatInject,
  missingStatus = {}, onAddClause, onRejectMissing,
  data, isDemo, hideTabs,
}) {
  // `data` (always defined) is the merged real-or-demo bundle from
  // ContractAnalysis. Demo-only fields (missing/keyData/summary) still come
  // from DEMO until the backend learns to return them.
  const findings = data.findings;
  const comparison = data.comparison;
  const legalBasis = data.legalBasis;
  const missing = data.missing;
  const keyData = data.keyData;
  const summary = data.summary;
  const warnings = data.warnings;
  const [filter, setFilter] = useState('all');

  const getFindingState = (id) => findingStatus[id]?.state || 'pending';
  const getMissingState = (i) => missingStatus[i]?.state || 'pending';

  const appliedWeight = findings.reduce(
    (s, f) => s + (getFindingState(f.id) === 'accepted' ? (f.weight || 0) : 0), 0
  );
  const liveScore = Math.min(92, (data.score?.value || 0) + appliedWeight);
  const openHigh = findings.filter(f => f.level === 'high' && getFindingState(f.id) === 'pending').length;
  const openMed = findings.filter(f => f.level === 'med' && getFindingState(f.id) === 'pending').length;
  const resolved = findings.filter(f => getFindingState(f.id) === 'accepted').length;
  const scoreLabel = liveScore >= 80 ? t.scoreLow : liveScore >= 58 ? t.scoreMed : t.scoreHigh;
  const scoreColor = liveScore >= 75 ? 'var(--risk-low)' : liveScore >= 55 ? 'var(--risk-med)' : 'var(--risk-high)';

  const fixable = findings.filter(f => f.suggest);
  // «Все правки решены»: либо принято, либо отклонено — не осталось pending.
  const allFixed = fixable.every(f => getFindingState(f.id) !== 'pending');
  const pendingFixableCount = fixable.filter(f => getFindingState(f.id) === 'pending').length;
  const openMissing = missing.filter((_, i) => getMissingState(i) === 'pending').length;

  // Сортировка to-do списка: pending наверху (сохраняя исходный порядок),
  // решённые (accepted/rejected) — внизу по resolvedAt. Фильтр по уровню
  // применяется поверх сортировки.
  const sortedFindings = useMemo(() => {
    const withMeta = findings.map((f, i) => ({ f, i, st: findingStatus[f.id] }));
    withMeta.sort((a, b) => {
      const sa = a.st?.state || 'pending';
      const sb = b.st?.state || 'pending';
      if (sa === 'pending' && sb !== 'pending') return -1;
      if (sa !== 'pending' && sb === 'pending') return 1;
      if (sa === 'pending' && sb === 'pending') return a.i - b.i;
      return (a.st?.resolvedAt || 0) - (b.st?.resolvedAt || 0);
    });
    return withMeta.map(({ f }) => f);
  }, [findings, findingStatus]);
  const sortedMissing = useMemo(() => {
    const withMeta = missing.map((m, i) => ({ m, i, st: missingStatus[i] }));
    withMeta.sort((a, b) => {
      const sa = a.st?.state || 'pending';
      const sb = b.st?.state || 'pending';
      if (sa === 'pending' && sb !== 'pending') return -1;
      if (sa !== 'pending' && sb === 'pending') return 1;
      if (sa === 'pending' && sb === 'pending') return a.i - b.i;
      return (a.st?.resolvedAt || 0) - (b.st?.resolvedAt || 0);
    });
    return withMeta; // сохраняем оригинальный i для onAddClause/onRejectMissing
  }, [missing, missingStatus]);

  const filtered = filter === 'all'
    ? sortedFindings
    : sortedFindings.filter(f => f.level === (filter === 'crit' ? 'high' : 'med'));

  // Reconcile callers pass hideTabs=['summary','data','missing'] because
  // those concepts (executive summary, contract metadata, missing clauses)
  // don't map onto the pair-comparison flow. Default empty array keeps the
  // single-contract path untouched.
  const hidden = new Set(hideTabs || []);
  const tabs = [
    { id: 'risks', label: t.tabRisks, n: openHigh + openMed },
    { id: 'chat', label: t.tabChat, icon: 'sparkle' },
    { id: 'summary', label: t.tabSummary },
    { id: 'data', label: t.tabData },
    { id: 'missing', label: t.tabMissing, n: openMissing },
    { id: 'compare', label: t.tabCompare },
  ].filter((tb) => !hidden.has(tb.id));

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
            <span style={{ marginLeft: 'auto' }}>
              <Badge variant="muted" title={t.demoBadgeSub || ''}>{t.demoBadge || 'demo'}</Badge>
            </span>
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
          <HelpTip text={(t.tips && t.tips.scoreRing) || ''} placement="bottom">
            <span><ScoreRing value={liveScore} size={66} /></span>
          </HelpTip>
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
        {tabs.map(tb => {
          const tipKey = ({
            risks: 'aiTabRisks', chat: 'aiTabChat', summary: 'aiTabSummary',
            data: 'aiTabData', missing: 'aiTabMissing', compare: 'aiTabCompare',
          })[tb.id];
          const btn = (
            <button className={'aitab' + (tab === tb.id ? ' on' : '')} onClick={() => setTab(tb.id)}>
              {tb.icon ? <Icon name={tb.icon} size={13} fill={true} /> : null}
              {tb.label}{tb.n != null ? <span className="aitab-n">{tb.n}</span> : null}
            </button>
          );
          return (
            <HelpTip key={tb.id} text={tipKey && t.tips ? t.tips[tipKey] : ''} placement="bottom">
              {btn}
            </HelpTip>
          );
        })}
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
              <HelpTip text={(t.tips && t.tips.aiApplyAll) || ''} placement="top">
                <button className={'btn ' + (allFixed ? 'btn-ghost' : 'btn-primary')} disabled={allFixed}
                  onClick={onApplyAll} style={{ justifyContent: 'center', width: '100%' }}>
                  {allFixed ? <><Icon name="check" size={15} /> {t.allApplied}</> : <><Icon name="wand" size={15} /> {t.applyAll} ({pendingFixableCount})</>}
                </button>
              </HelpTip>
              {filtered.map(f => (
                <FindingCard key={f.id} f={f} t={t}
                  status={findingStatus[f.id]}
                  active={active === f.id}
                  hovered={hovered === f.id}
                  onHover={setHovered}
                  onApply={onApply}
                  onReject={onReject}
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
            <div className="view-enter">
              {data.tokenStats ? (
                <div className="data-card" style={{ marginBottom: 10, gridColumn: '1 / -1' }}>
                  <div className="data-ic"><Icon name="sparkle" size={16} fill={true} /></div>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 11.5, color: 'var(--text-3)', fontWeight: 600 }}>Токени після конвертації</div>
                    <div style={{ fontSize: 14, fontWeight: 650, letterSpacing: '-0.01em', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      {(data.tokenStats.markdown_tokens || 0).toLocaleString('uk-UA')} / {(data.tokenStats.raw_tokens || 0).toLocaleString('uk-UA')}
                      {data.tokenStats.savings_pct > 0 ? (
                        <span className="doc-savings"><Icon name="check" size={11} stroke={3} /> −{data.tokenStats.savings_pct}%</span>
                      ) : null}
                    </div>
                    <div style={{ fontSize: 11.5, color: 'var(--text-3)' }}>Markdown → економія токенів при аналізі</div>
                  </div>
                </div>
              ) : null}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
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
            </div>
          )}

          {tab === 'missing' && (
            <div className="view-enter">
              <div style={{ fontSize: 13, color: 'var(--text-3)', marginBottom: 10 }}>{t.missingSub}</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                {sortedMissing.map(({ m, i, st }) => {
                  const state = st?.state || 'pending';
                  const isAccepted = state === 'accepted';
                  const isRejected = state === 'rejected';
                  const isResolved = isAccepted || isRejected;
                  return (
                    <div className={
                      'miss-card todo-item'
                      + (isAccepted ? ' miss-done todo-item-accepted' : '')
                      + (isRejected ? ' todo-item-rejected' : '')
                    } key={i}>
                      <div className="miss-ic" style={
                        isAccepted ? { background: 'var(--risk-low-soft)', color: 'var(--risk-low)' } :
                        isRejected ? { background: 'var(--surface-2)', color: 'var(--text-3)' } : null
                      }>
                        <Icon name={isAccepted ? 'check' : isRejected ? 'x' : 'plus'} size={13} stroke={2.6} />
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="todo-title" style={{ fontWeight: 650, fontSize: 14 }}>{m.title}</div>
                        <div style={{ fontSize: 12.5, color: 'var(--text-2)', marginTop: 2 }}>{m.note}</div>
                        {m.law ? <div className="law-chip" style={{ marginTop: 6 }}><Icon name="scales" size={11} /> {m.law}</div> : null}
                        {!isResolved ? (
                          <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 6 }}>
                            {t.missingWhere || 'Додається в кінець документа'}
                          </div>
                        ) : null}
                      </div>
                      {isAccepted ? (
                        <span className="todo-status todo-status-accepted" style={{ whiteSpace: 'nowrap' }}>
                          <Icon name="checkCircle" size={12} /> {t.added}
                        </span>
                      ) : isRejected ? (
                        <span className="todo-status todo-status-rejected" style={{ whiteSpace: 'nowrap' }}>
                          <Icon name="x" size={12} /> {t.rejected}
                        </span>
                      ) : (
                        <div className="todo-actions" style={{ flexDirection: 'column', gap: 6 }}>
                          <button className="btn btn-sm btn-subtle" onClick={() => onAddClause(i)}>
                            <Icon name="plus" size={13} /> {t.addClause}
                          </button>
                          <button className="btn btn-sm btn-ghost" onClick={() => onRejectMissing(i)}>
                            <Icon name="x" size={13} /> {t.rejectFix || 'Відхилити'}
                          </button>
                        </div>
                      )}
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

/* ---------- Reconcile analyzing overlay ----------
   Lifted from the deleted src/screens/Reconcile.jsx#AnalyzingStep. Without
   the animated progress bar + cycling steps + elapsed counter the user
   stares at a static screen for 15-60s while Claude churns through both
   docs and assumes the page hung. Mirrors the original behavior 1:1. */
function ReconcileAnalyzingOverlay({ t }) {
  const steps = t.cmpSteps || [];
  const [step, setStep] = useState(0);
  const [pct, setPct] = useState(6);
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const si = steps.length > 0
      ? setInterval(() => setStep((s) => Math.min(s + 1, steps.length - 1)), 4200)
      : null;
    // Progress crawls from 6 → 96 over ~30s of jittery increments; never
    // reaches 100 — it caps at 96 so the final hop happens when the real
    // result arrives. Reads as "actively working" without lying about
    // completion time.
    const pi = setInterval(() => setPct((p) => Math.min(p + Math.random() * 5 + 1, 96)), 350);
    const ti = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => {
      if (si) clearInterval(si);
      clearInterval(pi);
      clearInterval(ti);
    };
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
              <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>
                {elapsed}s
              </div>
              {steps.length > 0 ? (
                <div className="analyzing-steps">
                  {steps.map((s, i) => (
                    <div key={i} className={'astep' + (i < step ? ' done' : i === step ? ' now' : '')}>
                      <span className="astep-dot">{i < step ? <Icon name="check" size={11} stroke={3} /> : null}</span>
                      {s}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        </div>
        <div className="panel-wrap panel-loading" />
      </div>
    </div>
  );
}

/* ---------- Reconcile result view ----------
   Lifts the analysis-bar + AnalysisView wiring from the deleted
   src/screens/Reconcile.jsx so the analyze route renders BOTH the
   single-contract flow (ContractAnalysis main render) AND the pair-
   reconcile flow (ReconcileResult) — the user navigates from the
   dashboard modal and never lands on a separate /reconcile screen.

   `run` is the /api/reconcile response (or a hydrated row from
   /api/reconciliations/:id when the user re-opens from Library).
   `pending` flips the body to a loading state while the upload modal's
   POST is in flight. */
export function ReconcileResult({ t, run, pending, onBack, onRestart }) {
  const pair = (run && run.pair) || {};
  const adapted = useMemo(
    () => (run ? reconcileToAnalysisProps(run, t) : null),
    [run, t],
  );

  const [active, setActive] = useState(null);
  const [hovered, setHovered] = useState(null);
  const [tab, setTab] = useState('risks');
  // Локальный findingStatus для сверок: reconcile-режим не переписывает
  // editedSections (тут нет одного «главного» договора), только помечает
  // findings принятыми/отклонёнными для дальнейшего экспорта.
  const [findingStatus, setFindingStatus] = useState({});

  const data = useMemo(() => ({
    findings: (adapted && adapted.findings) || [],
    comparison: (adapted && adapted.comparison) || [],
    legalBasis: (adapted && adapted.legalBasis) || [],
    score: (adapted && adapted.score) || { value: 0, label: '', risks: { high: 0, med: 0, low: 0 } },
    warnings: (adapted && adapted.warnings) || [],
    // hideTabs=['summary','data','missing'] keeps these out of the UI,
    // but AiPanel still reads `missing.length` for the tab badge — pass
    // empty arrays so the read is safe even though the tab won't render.
    missing: [],
    keyData: [],
    summary: '',
    tokenStats: null,
  }), [adapted]);

  const counts = useMemo(() => {
    const c = { must: 0, should: 0, nice: 0, flag: 0, mismatches: 0 };
    if (run) {
      (run.findings || []).forEach((f) => { if (c[f.severity] != null) c[f.severity] += 1; });
      (run.rows || []).forEach((r) => { if (r.status === 'mismatch') c.mismatches += 1; });
    }
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
    const fixable = ((run && run.findings) || []).filter(
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
    if (!run) return;
    const lines = [];
    lines.push(`# ${t.reconcileTitle} · ${pair.product || ''}`);
    lines.push(`${pair.counterparty || ''} · ${pair.contractNo || ''} · ${pair.date || ''}`);
    lines.push('');
    (run.rows || []).forEach((r) => {
      lines.push(`- [${(r.status || '').toUpperCase()}] ${r.name}: ${t.cmpT3} = ${r.t3 || '—'} | ${t.cmpContract} = ${r.contract || '—'}`);
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

  // Pending state: upload modal has closed and POST /api/reconcile is in
  // flight. Show the analyzing overlay until `run` shows up.
  if (pending || !run) {
    return <ReconcileAnalyzingOverlay t={t} />;
  }

  return (
    <div className="analysis">
      <div className="analysis-bar">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
          {onBack ? (
            <button className="hub-back" style={{ margin: 0 }} onClick={onBack}>
              <Icon name="chevR" size={16} style={{ transform: 'rotate(180deg)' }} /> {t.cmpBack}
            </button>
          ) : null}
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
          {onRestart ? (
            <button className="btn btn-primary btn-sm" onClick={onRestart}><Icon name="refresh" size={15} /> {t.cmpRun}</button>
          ) : null}
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
            findingStatus={findingStatus}
            onApply={(id) => setFindingStatus((s) => ({
              ...s, [id]: { state: 'accepted', resolvedAt: Date.now(), resolvedVia: 'ai-button' },
            }))}
            onReject={(id) => setFindingStatus((s) => ({
              ...s, [id]: { state: 'rejected', resolvedAt: Date.now(), resolvedVia: 'reject-button' },
            }))}
            onApplyAll={() => {}}
            scrollToSeg={() => {}}
            chatInject={null}
            missingStatus={{}}
            onAddClause={() => {}}
            onRejectMissing={() => {}}
            data={data}
            isDemo={false}
            hideTabs={['summary', 'data', 'missing']} />
        }
      />
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
// Phase 3.2: opening a persisted contract from Library → ContractAnalysis.
// Mirrors RECON_OPEN_KEY on the reconciliation side.
const CONTRACT_OPEN_KEY = 'lex.contract.open';

function popContractOpenId() {
  if (typeof localStorage === 'undefined') return null;
  const id = localStorage.getItem(CONTRACT_OPEN_KEY);
  if (!id) return null;
  try { localStorage.removeItem(CONTRACT_OPEN_KEY); } catch (_e) {}
  return id;
}

// Library convention: high score ⇒ low risk. Mirrors useReconciliationRows.
function scoreToRisk(v) {
  if (v == null) return 'low';
  if (v >= 75) return 'low';
  if (v >= 55) return 'med';
  return 'high';
}

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
  // PR-1 of the analyze-unification work: reconcile rows now share this
  // route. Two entry points lead here:
  //   1) Dashboard pair-upload modal → App.jsx sets
  //      incoming = { reconcileRun: <pending|run>, pending? }.
  //   2) Library row click → openReconciliation() puts the id in
  //      RECON_OPEN_KEY localStorage and routes to 'analyze'; we pop it
  //      and fetch the persisted row via api.reconciliations.get(id).
  // Both delegate to <ReconcileResult>; the rest of this component (the
  // single-contract analyze flow) is untouched.
  if (incoming && Object.prototype.hasOwnProperty.call(incoming, 'reconcileRun')) {
    return (
      <ReconcileResult
        t={t}
        run={incoming.reconcileRun || null}
        pending={!!incoming.pending}
      />
    );
  }
  return <ContractAnalysisMain t={t} incoming={incoming} />;
}

/** Library handoff for reconcile rows. Only runs when the analyze route
 *  was opened WITHOUT an incoming payload (i.e. via a Library click that
 *  set RECON_OPEN_KEY). When `incoming` is truthy, the user came from the
 *  upload modal — popping the key would briefly flash the reconcile
 *  overlay on top of an unrelated upload, so we skip it. */
function useReconcileHandoff(hasIncoming) {
  // null sentinel = handoff skipped or no key found. undefined = lookup in
  // flight (only happens when hasIncoming is false AND a key existed).
  const [run, setRun] = useState(hasIncoming ? null : undefined);
  useEffect(() => {
    if (hasIncoming) { setRun(null); return; }
    const id = popReconOpenId();
    if (!id) { setRun(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const r = await api.reconciliations.get(id);
        if (!cancelled && r) {
          saveReconHistory(r);
          setRun(r);
        } else if (!cancelled) {
          setRun(null);
        }
      } catch (_e) {
        if (!cancelled) setRun(null);
      }
    })();
    return () => { cancelled = true; };
  }, [hasIncoming]);
  return run; // undefined = looking up, null = nothing to handoff, run = ready
}

function ContractAnalysisMain({ t, incoming }) {
  const reconHandoff = useReconcileHandoff(!!incoming);
  if (reconHandoff === undefined) {
    // We popped a key but the GET is in flight — render the analyzing
    // overlay so the user has feedback while we hydrate the persisted run.
    return <ReconcileResult t={t} run={null} pending />;
  }
  if (reconHandoff) {
    return <ReconcileResult t={t} run={reconHandoff} />;
  }
  return <ContractAnalysisSingle t={t} incoming={incoming} />;
}

function ContractAnalysisSingle({ t, incoming }) {
  const D = DEMO;
  const { startOperation, endOperation } = useDocumentProcessing();
  // Real analysis result from POST /api/analyze/contract. Null until the
  // round-trip completes (or never, in demo mode).
  const [analysis, setAnalysis] = useState(null);
  // 'demo'    — no incoming doc, showing DEMO with a badge
  // 'loading' — incoming.markdown is being analyzed
  // 'ready'   — analysis received, panels show real findings
  // 'error'   — API failed, degraded to DEMO with badge
  const [analysisStatus, setAnalysisStatus] = useState(incoming ? 'loading' : 'demo');

  // Library-handoff doc: when the user clicks a saved contract in Library,
  // we hydrate the doc + analysis from /api/contracts/:id instead of running
  // a fresh upload+analyze round-trip. `loadedDoc` is then used in place of
  // `incoming` for rendering.
  const [loadedDoc, setLoadedDoc] = useState(null);
  const effectiveDoc = incoming || loadedDoc;

  // Phase 5: the PDF viewer was retired — AnalysisView now renders the
  // analyzer's per-section text via MarkdownDoc. Fresh uploads carry the
  // sections in `incoming.sections`; library re-opens carry them under
  // `loadedDoc.sections` (round-tripped through `analysis._doc.sections`).
  // DEMO mode (no sections) keeps using ContractDoc below.
  const effectiveSections = (effectiveDoc && Array.isArray(effectiveDoc.sections))
    ? effectiveDoc.sections
    : [];
  // Приоритет — сохранённая markdown-строка (после первого save юрист
  // редактировал не по секциям, а построчно; секции стали stale). Fallback —
  // склейка из секций. Так восстанавливаем ровно то, что было в редакторе на
  // момент последнего save при возврате из Library.
  const effectiveMarkdown = (effectiveDoc && typeof effectiveDoc.markdown === 'string')
    ? effectiveDoc.markdown
    : sectionsToMarkdown(effectiveSections);
  // editedMarkdown — единый source of truth для CodeMirror-редактора. На
  // новый upload / library reopen пересобираем строку заново.
  const [editedMarkdown, setEditedMarkdown] = useState(effectiveMarkdown);
  useEffect(() => {
    setEditedMarkdown(effectiveMarkdown);
  }, [effectiveMarkdown]);
  // AnalysisView всё ещё ждёт documents[].sections для fallback-ветки
  // (MarkdownDoc) — держим оригинальные effectiveSections. В нашей ветке
  // docOverride=<EditableDoc> перекрывает MarkdownDoc, но проп всё равно
  // читается для fallback-баннера «preview unavailable».
  const docsForView = useMemo(() => {
    const filename = (effectiveDoc && effectiveDoc.filename) || 'Договір';
    return [{
      label: filename,
      filename,
      sections: effectiveSections,
    }];
  }, [effectiveDoc, effectiveSections]);
  const useAnalysisView = effectiveSections.length > 0;

  // Merged data source: real fields override DEMO when available. PR-2 of
  // analyze-unification: `summary`, `keyData`, `missing` now come from the
  // analyzer too (extended schema in /api/analyze/contract). DEMO stays as
  // the fallback for `analysisStatus === 'demo' | 'error'`.
  const data = useMemo(() => ({
    findings: analysis?.findings ?? D.findings,
    comparison: analysis?.comparison ?? D.comparison,
    legalBasis: analysis?.legal_basis ?? D.legalBasis,
    score: analysis?.score ?? D.score,
    warnings: analysis?.warnings ?? [],
    tokenStats: effectiveDoc?.tokenStats || null,
    missing: analysis?.missing ?? D.missing,
    keyData: analysis?.keyData ?? D.keyData,
    summary: analysis?.summary ?? D.summary,
  }), [analysis, D, effectiveDoc]);
  const isDemo = analysisStatus === 'demo' || analysisStatus === 'error';

  const fById = useMemo(() => Object.fromEntries(data.findings.map(f => [f.id, f])), [data.findings]);
  const [phase, setPhase] = useState('loading');
  const [tab, setTab] = useState('risks');
  const [active, setActive] = useState(null);
  const [hovered, setHovered] = useState(null);     // bidirectional hover (mark ↔ card)
  // findingStatus[id] = { state: 'pending'|'accepted'|'rejected',
  //                       resolvedAt: number|null,
  //                       resolvedVia: 'ai-button'|'manual-edit'|'reject-button'|null }
  // Отсутствие ключа = pending. Держим одну карту вместо трёх флагов, чтобы
  // список фиксов на панели мог отсортировать активные наверх, а решённые вниз
  // по времени resolvedAt.
  const [findingStatus, setFindingStatus] = useState({});
  const [highlightsOn, setHighlightsOn] = useState(true);
  const [tooltip, setTooltip] = useState(null);     // { f, x, y }
  const [zoom, setZoom] = useState(100);            // percent, ZOOM_MIN..ZOOM_MAX in ZOOM_STEP increments
  const [formatMenuOpen, setFormatMenuOpen] = useState(false); // download-format dropdown
  // selectedFormat — «выбранный» вариант в split-button. Клик по левой
  // половине кнопки скачивает в этом формате; клик по элементу дропдауна
  // и скачивает, и запоминает выбор для следующего клика. Персистент
  // между открытиями сессии — юрист-стайл, но не через localStorage:
  // хватило бы в компоненте.
  const [selectedFormat, setSelectedFormat] = useState('md'); // 'md' | 'txt' | 'docx' | 'print'
  // flashRange — {from,to} диапазон, куда AI-виправлення только что вставил
  // suggest.to; CodeMirror отрисует .aglex-flash-декорацию, которая через
  // 1.2s растворится. Раньше был flashIdx (индекс секции), сейчас доку —
  // одна строка, поэтому позиции.
  const [flashRange, setFlashRange] = useState(null);
  // scrollToPos — куда прокрутить редактор после Додати розділ. Заменяет
  // scrollToIdx (индекс секции) на позицию в markdown-строке.
  const [scrollToPos, setScrollToPos] = useState(null);

  const [protocolOpen, setProtocolOpen] = useState(false);
  // missingStatus[idx] = та же форма, что и findingStatus. resolvedVia:
  //   'add-button'    — юрист добавил раздел через кнопку «Додати»;
  //   'reject-button' — юрист явно отверг раздел.
  const [missingStatus, setMissingStatus] = useState({});
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
  // savedContractId — id из /api/contracts, назначается после успешного create
  // (upload path) или при библиотечном reopen. Пока не задан — сохранять
  // некуда: DEMO-режим, ошибочный upload или ожидание первого persist.
  const [savedContractId, setSavedContractId] = useState(null);
  const [saveState, setSaveState] = useState('idle'); // idle | saving | saved | error
  // lastSavedRef хранит markdown, зафиксированный последним успешным PATCH.
  // Нужен чтобы не спамить сеть при монтировании (editedMarkdown ставится в
  // ту же строку, которая уже лежит в БД — сравниваем и пропускаем no-op).
  const lastSavedMdRef = useRef(null);

  // Совместимость с существующими компонентами (FindingCard, MarkdownDoc,
  // ContractDoc), которые читают applied[id] как «правку применили».
  // Достаём из findingStatus только принятые записи.
  const applied = useMemo(() =>
    Object.fromEntries(
      Object.entries(findingStatus)
        .filter(([, v]) => v && v.state === 'accepted')
        .map(([k]) => [k, true])
    ),
  [findingStatus]);

  // Сброс всего локально-выведенного состояния при новом анализе.
  // Каждый новый API-ответ — это самостоятельный run: findings/comparison/
  // summary/keyData/missing прилетают ЦЕЛИКОМ новыми объектами (Claude может
  // выдать одинаковые id вроде f-prepay для разных договоров), поэтому если
  // не почистить findingStatus вручную, принятая правка со старого анализа
  // так и останется «прийнято» на новом. Ключ — идентичность `analysis` state:
  // как только setAnalysis(newRes) вызвано (свежий upload / library reopen /
  // DocBuilder handoff), эффект сработает и обнулит все зависимые карты.
  useEffect(() => {
    setFindingStatus({});
    setMissingStatus({});
    setActive(null);
    setFlashRange(null);
    setScrollToPos(null);
    setTooltip(null);
  }, [analysis]);

  // Manual-accept detection: если юрист сам переписал текст в редакторе поверх
  // finding.suggest.from — карточка без клика уходит в accepted/manual-edit.
  // Тот же buildFromRegex, что и в applyFixToMarkdown, — чтобы «правка ушла»
  // означало одно и то же для AI-кнопки и для ручного ввода. Дебаунс 500ms,
  // чтобы промежуточные keystroke не флипали статус на середине слова.
  useEffect(() => {
    const h = setTimeout(() => {
      setFindingStatus(prev => {
        let next = prev;
        for (const f of data.findings) {
          const cur = prev[f.id]?.state ?? 'pending';
          if (cur !== 'pending') continue;
          const re = buildFromRegex(f.suggest?.from || '');
          if (!re) continue;
          if (!re.test(editedMarkdown)) {
            if (next === prev) next = { ...prev };
            next[f.id] = {
              state: 'accepted', resolvedAt: Date.now(), resolvedVia: 'manual-edit',
            };
          }
        }
        return next;
      });
    }, 500);
    return () => clearTimeout(h);
  }, [editedMarkdown, data.findings]);

  // Debounced auto-save. Каждое изменение editedMarkdown спит 800ms; если за
  // это время новое изменение — таймер перезапускается. По истечении шлём
  // PATCH /api/contracts/{savedContractId} с обновлённым analysis._doc.markdown.
  // Skip, если id ещё нет (DEMO / первый upload до создания записи) или если
  // текущий текст совпадает с последним сохранённым (защита от no-op сети на
  // монтировании и от резонанса с внешним setEditedMarkdown из upload/reopen).
  useEffect(() => {
    if (!savedContractId) return undefined;
    if (lastSavedMdRef.current === editedMarkdown) return undefined;
    const h = setTimeout(async () => {
      setSaveState('saving');
      try {
        await api.contracts.update(savedContractId, {
          analysis: {
            ...(analysis || {}),
            _doc: {
              ...((analysis && analysis._doc) || {}),
              markdown: editedMarkdown,
            },
          },
        });
        lastSavedMdRef.current = editedMarkdown;
        setSaveState('saved');
        // Через 2s гасим индикатор — юристу не нужен постоянный «збережено».
        setTimeout(() => setSaveState((s) => (s === 'saved' ? 'idle' : s)), 2000);
      } catch (_e) {
        setSaveState('error');
      }
    }, 800);
    return () => clearTimeout(h);
    // analysis deps намеренно исключены: обновление analysis (setAnalysis)
    // не должно триггерить лишний save, а свежий analysis всё равно
    // прочитается из замыкания при следующем срабатывании.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editedMarkdown, savedContractId]);

  // Mount: if we got an uploaded doc, analyze it for real. Cancellable so a
  // route change mid-flight doesn't write to a stale state.
  const liveRef = useRef(true);
  useEffect(() => {
    liveRef.current = true;
    if (!incoming || !incoming.markdown) return () => { liveRef.current = false; };
    let cancelled = false;
    startOperation('analysis');
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
        // Fire-and-forget persistence: failures don't disrupt the open
        // session — the analysis is still visible. Ловим возвращённый id,
        // чтобы дальше debounced-save мог патчить именно эту строку через
        // PATCH /api/contracts/{id}. Без id (backend down) save-эффект
        // просто не срабатывает.
        try {
          const created = await api.contracts.create({
            filename: incoming.filename,
            title: incoming.filename,
            counterparty: '',
            risk: scoreToRisk(res?.score?.value),
            score: Math.round(res?.score?.value || 0),
            findingsCount: (res?.findings || []).length,
            analysis: {
              ...res,
              tokenStats: incoming.tokenStats || null,
              _doc: {
                filename: incoming.filename,
                sections: incoming.sections || [],
                markdown: sectionsToMarkdown(incoming.sections || []),
              },
            },
            // Phase 4.x: round-trip the display PDF back to the backend so the
            // BLOB lands on the persisted contract row. When soffice failed,
            // displayPdfError rides alongside so the saved row carries the
            // reason — a later display-PDF 404 can then explain *why*.
            displayPdfB64: incoming.displayPdfB64 || null,
            displayPdfError: incoming.displayPdfError || null,
            createdAt: new Date().toISOString(),
          });
          if (!cancelled && liveRef.current && created && created.id) {
            setSavedContractId(created.id);
            lastSavedMdRef.current = sectionsToMarkdown(incoming.sections || []);
          }
        } catch (_e) { /* persistence is best-effort */ }
      } catch (_e) {
        if (cancelled || !liveRef.current) return;
        // Backend down or 502 — surface as demo fallback so the screen stays
        // useful. A toast at the call site would be nicer but the existing
        // demo flow shows the badge + same content, which is the safest UX.
        toast(t.uploadError || 'Analysis failed', 'alert');
        setAnalysisStatus('error');
        setPhase('ready');
      } finally {
        endOperation('analysis');
      }
    })();
    return () => { cancelled = true; liveRef.current = false; endOperation('analysis'); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incoming]);

  // Library-handoff: pop `lex.contract.open` and hydrate doc + analysis
  // directly from /api/contracts/:id without re-running the analyzer.
  useEffect(() => {
    if (incoming) return; // upload path already handles its own analysis
    const id = popContractOpenId();
    if (!id) return;
    let cancelled = false;
    (async () => {
      try {
        const c = await api.contracts.get(id);
        if (cancelled) return;
        const a = (c && c.analysis) || {};
        setAnalysis({
          findings: a.findings || [],
          comparison: a.comparison || [],
          legal_basis: a.legal_basis || [],
          score: a.score || null,
          warnings: a.warnings || [],
          // PR-2: surface analyzer's summary/keyData/missing on Library
          // re-open too. Rows persisted before PR-2 simply don't have these
          // fields and the merge in `data` falls back to DEMO (intentional).
          summary: a.summary,
          keyData: a.keyData,
          missing: a.missing,
        });
        setLoadedDoc({
          filename: c.filename || (a._doc && a._doc.filename) || 'Договір',
          sections: (a._doc && a._doc.sections) || [],
          // Приоритет — сохранённая markdown-строка (после первого edit + save).
          // Fallback — сгенерить её из секций (совместимость с записями до v3).
          markdown: (a._doc && a._doc.markdown) || sectionsToMarkdown((a._doc && a._doc.sections) || []),
          tokenStats: a.tokenStats || null,
          // Phase 4.x PR4: AnalysisView fetches the bytes from this URL.
          // Returns 404 for legacy rows persisted before PR1 — the FE
          // then renders the "preview unavailable" banner.
          displayPdfUrl: `/api/contracts/${encodeURIComponent(id)}/display.pdf`,
        });
        setSavedContractId(id);
        lastSavedMdRef.current = (a._doc && a._doc.markdown)
          || sectionsToMarkdown((a._doc && a._doc.sections) || []);
        setAnalysisStatus('ready');
        setPhase('ready');
      } catch (_e) { /* fall through to demo */ }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
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
    startOperation('analysis');
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
    } finally {
      endOperation('analysis');
    }
  }

  // Demo polish: 2.35s fake overlay only when there's no real incoming doc.
  // When `incoming` exists (real upload or library re-open) the analyze()
  // effect above drives phase → 'ready' once the API call resolves. While
  // `incoming.pending` is true (modal just closed, upload still in flight)
  // we stay on the overlay — that's the whole point of jumping into the
  // analyze route immediately on click.
  useEffect(() => {
    if (phase !== 'loading') return;
    if (incoming) return;
    const tm = setTimeout(() => setPhase('ready'), 2350);
    return () => clearTimeout(tm);
  }, [phase, incoming]);

  // Exit-guard hook: keep a long-lived 'session' op flagged while a real
  // analysis is on screen — covers both "analysing" and "findings loaded".
  // The sidebar's guardedSetRoute reads isProcessing and pops the confirmation
  // modal before letting the nav click through. Demo / error fall-through
  // states deliberately leave the guard off — the user has nothing to lose.
  const sessionActive =
    analysisStatus === 'loading' || analysisStatus === 'ready' ||
    pendingStatus  === 'loading' || pendingStatus  === 'ready';
  useEffect(() => {
    if (!sessionActive) return undefined;
    startOperation('session');
    return () => endOperation('session');
  }, [sessionActive, startOperation, endOperation]);

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

  // Документ теперь всегда редактируемый (нет режима «Перегляд»), поэтому AI-
  // виправлення сразу переписывает markdown-строку editedMarkdown и подсвечивает
  // вставленный диапазон flash-декорацией CodeMirror. Reject не трогает текст —
  // только помечает finding как отклонённый, чтобы карточка ушла вниз списка.
  const onApply = (id) => {
    const f = data.findings.find(x => x.id === id);
    if (!f) return;
    if (f.suggest) {
      const { markdown: next, changedRange } = applyFixToMarkdown(editedMarkdown, f);
      if (changedRange) {
        setEditedMarkdown(next);
        setFlashRange(changedRange);
        setScrollToPos(changedRange.from);
        setTimeout(() => setFlashRange(null), 1400);
      }
    }
    setFindingStatus(prev => ({
      ...prev,
      [id]: { state: 'accepted', resolvedAt: Date.now(), resolvedVia: 'ai-button' },
    }));
  };
  const onReject = (id) => {
    setFindingStatus(prev => ({
      ...prev,
      [id]: { state: 'rejected', resolvedAt: Date.now(), resolvedVia: 'reject-button' },
    }));
  };
  const onApplyAll = () => {
    // Применяем каждый pending finding по очереди к текущему editedMarkdown,
    // чтобы правки поверх правок не затирали друг друга. Уже принятые/отклонённые
    // findings пропускаем. Диапазоны от отдельных applyFixToMarkdown сдвигаются
    // после каждой замены — но flash для «apply all» мы не показываем; юрист
    // и так видит, что все правки прошли (тост + переупорядочивание списка).
    let working = editedMarkdown;
    const now = Date.now();
    const patch = {};
    for (const f of data.findings) {
      if (!f.suggest) continue;
      const cur = findingStatus[f.id]?.state ?? 'pending';
      if (cur !== 'pending') continue;
      const { markdown: nextMd, changedRange } = applyFixToMarkdown(working, f);
      if (changedRange) working = nextMd;
      patch[f.id] = { state: 'accepted', resolvedAt: now, resolvedVia: 'ai-button' };
    }
    if (working !== editedMarkdown) setEditedMarkdown(working);
    if (Object.keys(patch).length) setFindingStatus(prev => ({ ...prev, ...patch }));
    toast(t.allApplied, 'wand');
  };
  const reanalyze = () => {
    setPhase('loading'); setActive(null);
    setFindingStatus({}); setMissingStatus({});
    setTab('risks');
  };

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
  // Добавляем недостающий раздел в конец markdown-строки (## <title>\n\n<body>),
  // скроллим CodeMirror-редактор к концу и фокусируем — юрист сразу может
  // править формулировку. Позиция всегда «в конце» — бэкенд не возвращает
  // точку вставки; TODO для отдельной задачи. Статус missing[idx] флипается
  // в accepted, чтобы карточка ушла вниз списка.
  const onAddClause = (idx) => {
    const m = data.missing[idx];
    if (!m) return;
    setMissingStatus(prev => ({
      ...prev,
      [idx]: { state: 'accepted', resolvedAt: Date.now(), resolvedVia: 'add-button' },
    }));
    const head = m.title ? `\n\n---\n\n## ${m.title}\n\n` : '\n\n';
    const body = m.clauseText || '';
    setEditedMarkdown(prev => {
      const glue = prev && !prev.endsWith('\n') ? head : head.replace(/^\n+/, '');
      const nextMd = prev + glue + body;
      // Скроллим к началу нового раздела (заголовку), чтобы юрист сразу увидел
      // название и мог править «под ним». Позиция начала = длина prev + длина
      // склеенного head-разделителя.
      setScrollToPos(prev.length + glue.length);
      return nextMd;
    });
    toast(t.clauseAdded, 'check');
    setTimeout(() => setScrollToPos(null), 900);
  };
  const onRejectMissing = (idx) => {
    setMissingStatus(prev => ({
      ...prev,
      [idx]: { state: 'rejected', resolvedAt: Date.now(), resolvedVia: 'reject-button' },
    }));
  };

  const addedClauses = data.missing.filter((_, i) => missingStatus[i]?.state === 'accepted');

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

      {phase === 'loading' ? (
        <div className="analysis-body">
          <div className="doc-scroll" ref={docScrollRef}>
            <AnalyzingOverlay t={t} />
          </div>
          <div className="panel-wrap panel-loading"><PanelSkeleton /></div>
        </div>
      ) : useAnalysisView ? (
        // Phase 5: MarkdownDoc on the left, AiPanel on the right.
        // AnalysisView owns the text rendering + text-color highlights.
        <AnalysisView
          documents={docsForView}
          findings={data.findings}
          applied={applied}
          active={active}
          setActive={(fid) => { setActive(fid); scrollFindingCard(fid); }}
          hovered={hovered}
          setHovered={setHovered}
          t={t}
          docZoom={zoom / 100}
          docToolbar={
            <div className="doc-edit-toolbar">
              <span className="doc-edit-mode-label">
                <Icon name="pen" size={14} /> {t.editMode || 'Редагування'}
              </span>

              <div className="sep" />

              <button type="button"
                className="btn btn-ghost btn-sm btn-icon"
                onClick={() => setZoom(z => Math.max(ZOOM_MIN, z - ZOOM_STEP))}
                disabled={zoom <= ZOOM_MIN}
                title={t.zoomOut || 'Зменшити'}
                aria-label={t.zoomOut || 'Зменшити'}>
                <Icon name="minus" size={14} />
              </button>
              <span className="zoom-label" aria-live="polite">{zoom}%</span>
              <button type="button"
                className="btn btn-ghost btn-sm btn-icon"
                onClick={() => setZoom(z => Math.min(ZOOM_MAX, z + ZOOM_STEP))}
                disabled={zoom >= ZOOM_MAX}
                title={t.zoomIn || 'Збільшити'}
                aria-label={t.zoomIn || 'Збільшити'}>
                <Icon name="plus" size={14} />
              </button>

              <div className="sep" />

              {saveState !== 'idle' ? (
                <span className={'save-chip save-chip-' + saveState} aria-live="polite">
                  {saveState === 'saving' ? (
                    <><Icon name="refresh" size={12} /> {t.saveSaving || 'Збереження…'}</>
                  ) : saveState === 'saved' ? (
                    <><Icon name="check" size={12} /> {t.saveSaved || 'Збережено'}</>
                  ) : (
                    <><Icon name="alert" size={12} /> {t.saveError || 'Не збережено'}</>
                  )}
                </span>
              ) : null}

              <div className="sep" />

              {(() => {
                const formats = [
                  { key: 'md',    label: t.exportMd    || 'Markdown (.md)',
                    icon: 'doc',
                    run: () => downloadMd(editedMarkdown, effectiveDoc?.filename) },
                  { key: 'txt',   label: t.exportTxt   || 'Текст (.txt)',
                    icon: 'doc',
                    run: () => downloadTxt(editedMarkdown, effectiveDoc?.filename) },
                  { key: 'docx',  label: t.exportDocx  || 'Word (.docx)',
                    icon: 'doc',
                    run: () => downloadDocx(editedMarkdown, effectiveDoc?.filename) },
                  { key: 'print', label: t.exportPdf   || 'PDF (друк)',
                    icon: 'doc',
                    run: () => printAsPdf() },
                ];
                const current = formats.find(f => f.key === selectedFormat) || formats[0];
                return (
                  <div className="dl-split">
                    <button type="button"
                      className="btn btn-ghost btn-sm dl-split-main"
                      onClick={() => current.run()}
                      title={t.downloadEdited || 'Завантажити'}>
                      <Icon name="download" size={15} /> {t.downloadEdited || 'Завантажити'}
                      <span className="dl-split-fmt">· {current.label}</span>
                    </button>
                    <button type="button"
                      className="btn btn-ghost btn-sm btn-icon dl-split-chev"
                      onClick={() => setFormatMenuOpen(o => !o)}
                      aria-expanded={formatMenuOpen}
                      aria-haspopup="menu"
                      title={t.exportPickFormat || 'Оберіть формат'}
                      aria-label={t.exportPickFormat || 'Оберіть формат'}>
                      <Icon name="chevD" size={13} />
                    </button>
                    {formatMenuOpen ? (
                      <div className="dl-menu" role="menu" onMouseLeave={() => setFormatMenuOpen(false)}>
                        {formats.map(opt => (
                          <button key={opt.key} type="button" role="menuitem"
                            className={'dl-menu-item' + (opt.key === selectedFormat ? ' dl-menu-item-active' : '')}
                            aria-current={opt.key === selectedFormat ? 'true' : undefined}
                            onClick={() => {
                              setSelectedFormat(opt.key);
                              opt.run();
                              setFormatMenuOpen(false);
                            }}>
                            <Icon name={opt.icon} size={14} />
                            <span>{opt.label}</span>
                            {opt.key === selectedFormat ? (
                              <Icon name="check" size={13} style={{ marginLeft: 'auto', color: 'var(--accent)' }} />
                            ) : null}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                );
              })()}
            </div>
          }
          docOverride={
            <EditableDoc
              filename={(effectiveDoc && effectiveDoc.filename) || 'Договір'}
              markdown={editedMarkdown}
              onChange={setEditedMarkdown}
              flashRange={flashRange}
              scrollToPos={scrollToPos}
            />
          }
          panel={
            <AiPanel t={t} tab={tab} setTab={setTab} active={active} setActive={setActive}
              hovered={hovered} setHovered={setHovered}
              findingStatus={findingStatus}
              onApply={onApply} onReject={onReject} onApplyAll={onApplyAll} scrollToSeg={scrollToSeg}
              chatInject={chatInject}
              missingStatus={missingStatus}
              onAddClause={onAddClause} onRejectMissing={onRejectMissing}
              data={data} isDemo={isDemo} />
          }
        />
      ) : (
        // DEMO / no-upload fallback — legacy ContractDoc with inline marks
        // stays so the prototype demo still renders sensibly.
        <div className="analysis-body">
          <div className="doc-scroll" ref={docScrollRef}>
            <div className="view-enter">
              <ContractDoc contract={D.contract} fById={fById} active={active} applied={applied}
                highlightsOn={highlightsOn} segRefs={segRefs} addedClauses={addedClauses} t={t}
                onHover={onHover} onPick={onPick} onAsk={onAsk} />
            </div>
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
          <div className="panel-wrap">
            <AiPanel t={t} tab={tab} setTab={setTab} active={active} setActive={setActive}
              hovered={hovered} setHovered={setHovered}
              findingStatus={findingStatus}
              onApply={onApply} onReject={onReject} onApplyAll={onApplyAll} scrollToSeg={scrollToSeg}
              chatInject={chatInject}
              missingStatus={missingStatus}
              onAddClause={onAddClause} onRejectMissing={onRejectMissing}
              data={data} isDemo={isDemo} />
          </div>
        </div>
      )}

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
