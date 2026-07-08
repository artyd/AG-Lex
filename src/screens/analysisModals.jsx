/* ============================================================
   Lexena — analysis extras: redline diff, approval route,
   comments, auto deadlines
   ============================================================ */
import { useState, useEffect } from 'react';
import { Icon } from '../ui/Icon';
import { Modal, toast } from '../ui/components';
import { UserAvatar } from '../lib/labels';
import { api } from '../lib/api';
import { LX } from '../data/lx';

/* ---- word-level diff (LCS) ---- */
function wordDiff(a, b) {
  const A = a.split(/(\s+)/), B = b.split(/(\s+)/);
  const n = A.length, m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = []; let i = 0, j = 0;
  const push = (type, text) => { const last = out[out.length - 1]; if (last && last.type === type) last.text += text; else out.push({ type, text }); };
  while (i < n && j < m) {
    if (A[i] === B[j]) { push('eq', A[i]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { push('del', A[i]); i++; }
    else { push('ins', B[j]); j++; }
  }
  while (i < n) { push('del', A[i]); i++; }
  while (j < m) { push('ins', B[j]); j++; }
  return out;
}

function RedlineText({ a, b }) {
  const parts = wordDiff(a, b);
  return (
    <span>
      {parts.map((p, i) => p.type === 'eq'
        ? <span key={i}>{p.text}</span>
        : p.type === 'del'
          ? <del key={i} className="rl-del">{p.text}</del>
          : <ins key={i} className="rl-ins">{p.text}</ins>)}
    </span>
  );
}

function DiffModal({ open, onClose, t }) {
  const pairs = LX.diffPairs;
  const ins = pairs.reduce((s, p) => s + wordDiff(p.a, p.b).filter(x => x.type === 'ins').length, 0);
  const del = pairs.reduce((s, p) => s + wordDiff(p.a, p.b).filter(x => x.type === 'del').length, 0);
  return (
    <Modal open={open} onClose={onClose} icon="scan" wide
      title={t.compareTitle}
      sub={`${LX.versions[0].label} → ${LX.versions[1].label}`}>
      <div style={{ display: 'flex', gap: 14, marginBottom: 'var(--s4)' }}>
        <span className="diff-stat"><span className="rl-ins" style={{ padding: '2px 6px' }}>+{ins}</span> {t.added2}</span>
        <span className="diff-stat"><span className="rl-del" style={{ padding: '2px 6px' }}>−{del}</span> {t.removed2}</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {pairs.map((p, i) => (
          <div key={i} className="diff-block">
            <span className="badge-risk badge-info" style={{ marginBottom: 8, display: 'inline-block' }}>{p.clause}</span>
            <div className="diff-text"><RedlineText a={p.a} b={p.b} /></div>
          </div>
        ))}
      </div>
    </Modal>
  );
}

function ApprovalModal({ open, onClose, t, steps, setSteps }) {
  const advance = () => {
    setSteps(prev => {
      const idx = prev.findIndex(s => s.status === 'current');
      if (idx < 0) return prev;
      const next = prev.map((s, i) => i === idx ? { ...s, status: 'done', date: '09.06.2026' } : s);
      if (idx + 1 < next.length) next[idx + 1] = { ...next[idx + 1], status: 'current' };
      return next;
    });
  };
  const cur = steps.find(s => s.status === 'current');
  const allDone = steps.every(s => s.status === 'done');
  const isSign = cur && cur.role.toLowerCase().includes('підпис');

  return (
    <Modal open={open} onClose={onClose} icon="checkCircle" title={t.approvalTitle}
      footer={allDone
        ? <button className="btn btn-ghost" onClick={onClose}>{t.close}</button>
        : <>
            <button className="btn btn-subtle" onClick={onClose}>{t.close}</button>
            <button className="btn btn-primary" onClick={() => { advance(); toast(isSign ? t.signed : t.approveDone, isSign ? 'check' : 'checkCircle'); }}>
              <Icon name={isSign ? 'check' : 'checkCircle'} size={15} /> {isSign ? t.sign : t.approve}
            </button>
          </>}>
      <div className="appr-route">
        {steps.map((s, i) => {
          const u = LX.userById[s.user];
          return (
            <div key={i} className={'appr-step appr-' + s.status}>
              <div className="appr-rail"><span className="appr-node">{s.status === 'done' ? <Icon name="check" size={13} stroke={3} /> : i + 1}</span>{i < steps.length - 1 ? <span className="appr-line" /> : null}</div>
              <div style={{ flex: 1, paddingBottom: 14 }}>
                <div style={{ fontWeight: 650, fontSize: 14 }}>{s.role}</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
                  <UserAvatar id={s.user} size={22} />
                  <span style={{ fontSize: 12.5, color: 'var(--text-2)' }}>{u.name}</span>
                  <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-3)' }}>{s.date}</span>
                </div>
                <span className={'appr-badge appr-badge-' + s.status}>{s.status === 'done' ? t.stepDone : s.status === 'current' ? t.stepCurrent : t.stepPending}</span>
              </div>
            </div>
          );
        })}
      </div>
      {allDone ? <div className="sign-stamp"><Icon name="checkCircle" size={18} /> {t.signedBy} — {LX.userById['u1'].name}</div> : null}
    </Modal>
  );
}

function CommentsModal({ open, onClose, t, comments, setComments }) {
  const [text, setText] = useState('');
  const add = () => {
    if (!text.trim()) return;
    const mentions = LX.team.filter(u => text.includes('@' + u.name)).map(u => u.name);
    setComments(cs => [...cs, { id: 'c' + Date.now(), clause: '—', author: 'u1', ts: '09.06 зараз', text: text.trim(), mentions, resolved: false }]);
    setText(''); toast(t.commentAdded, 'check');
  };
  const toggle = (id) => setComments(cs => cs.map(c => c.id === id ? { ...c, resolved: !c.resolved } : c));
  const renderText = (txt) => txt.split(/(@[А-ЯІЇЄҐA-Z][а-яіїєґa-z]+\s[А-ЯІЇЄҐA-Z][а-яіїєґa-z]+)/).map((p, i) =>
    p.startsWith('@') ? <span key={i} className="mention">{p}</span> : <span key={i}>{p}</span>);

  return (
    <Modal open={open} onClose={onClose} icon="bell" title={t.commentsTitle}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 'var(--s4)' }}>
        {comments.map(c => {
          const u = LX.userById[c.author];
          return (
            <div key={c.id} className={'cmt' + (c.resolved ? ' cmt-resolved' : '')}>
              <UserAvatar id={c.author} size={30} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontWeight: 650, fontSize: 13.5 }}>{u.name}</span>
                  <span className="chip" style={{ fontSize: 10.5, padding: '1px 7px' }}>{t.clauseC} {c.clause}</span>
                  <span style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--text-3)' }}>{c.ts}</span>
                </div>
                <div style={{ fontSize: 13.5, lineHeight: 1.5, marginTop: 4 }}>{renderText(c.text)}</div>
                <button className="btn btn-subtle btn-sm" style={{ marginTop: 6 }} onClick={() => toggle(c.id)}>
                  {c.resolved ? <><Icon name="refresh" size={13} /> {t.resolvedC}</> : <><Icon name="check" size={13} /> {t.resolve}</>}
                </button>
              </div>
            </div>
          );
        })}
      </div>
      <div className="cmt-input">
        <textarea value={text} placeholder={t.addComment} rows={2}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) add(); }} />
        <button className="btn btn-primary btn-sm" onClick={add} disabled={!text.trim()} style={{ alignSelf: 'flex-end' }}><Icon name="arrowR" size={14} /></button>
      </div>
    </Modal>
  );
}

function DeadlinesModal({ open, onClose, t }) {
  const [tab, setTab] = useState('deadl');
  const [added, setAdded] = useState(new Set());
  const [remind, setRemind] = useState(new Set());
  const riskTone = { high: 'var(--risk-high)', med: 'var(--risk-med)', low: 'var(--risk-low)' };
  const freqLabel = { monthly: t.freqMonthly, quarterly: t.freqQuarterly, ongoing: t.freqOngoing, oneoff: t.freqOneoff };
  const freqIcon = { monthly: 'refresh', quarterly: 'refresh', ongoing: 'clock', oneoff: 'calendar' };
  const partyLabel = { zam: t.partyZam, vyk: t.partyVyk, both: t.partyBoth };

  const addOne = (d) => {
    if (added.has(d.id)) return;
    setAdded(s => new Set(s).add(d.id));
    toast(t.addedToCal, 'calendar');
  };
  const addAll = () => LX.deadlines.forEach(addOne);
  const remindOne = (o) => {
    if (remind.has(o.id) || !o.nextDate) return;
    setRemind(s => new Set(s).add(o.id));
    toast(t.obReminderSet, 'calendar');
  };
  const remindAll = () => LX.obligations.filter(o => o.nextDate).forEach(remindOne);

  const footer = <>
    <button className="btn btn-subtle" onClick={onClose}>{t.close}</button>
    {tab === 'deadl'
      ? <button className="btn btn-primary" onClick={addAll}><Icon name="calendar" size={15} /> {t.addAllToCal}</button>
      : <button className="btn btn-primary" onClick={remindAll}><Icon name="bell" size={15} /> {t.obAddAllRem}</button>}
  </>;

  return (
    <Modal open={open} onClose={onClose} icon="calendar" title={t.obligTitle} sub={t.obligSub} footer={footer}>
      <div className="seg sum-toggle" style={{ marginBottom: 'var(--s4)' }}>
        <button className={tab === 'deadl' ? 'on' : ''} onClick={() => setTab('deadl')}><Icon name="calendar" size={14} /> {t.tabDeadl} <span className="aitab-n">{LX.deadlines.length}</span></button>
        <button className={tab === 'oblig' ? 'on' : ''} onClick={() => setTab('oblig')}><Icon name="refresh" size={14} /> {t.tabOblig} <span className="aitab-n">{LX.obligations.length}</span></button>
      </div>

      {tab === 'deadl' ? (
        <div className="view-enter" style={{ display: 'flex', flexDirection: 'column', gap: 9 }} key="d">
          {LX.deadlines.map(d => {
            const isAdded = added.has(d.id);
            const dt = new Date(d.date).toLocaleDateString('uk-UA', { day: '2-digit', month: 'long', year: 'numeric' });
            return (
              <div className="dl-card" key={d.id}>
                <span className="dl-dot" style={{ background: riskTone[d.risk] }} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 13.5 }}>{d.title}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-3)' }}>{dt} · {d.basis}</div>
                </div>
                {isAdded
                  ? <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--risk-low)' }}>✓</span>
                  : <button className="btn btn-subtle btn-sm" onClick={() => addOne(d)}><Icon name="plus" size={14} /> {t.addToCal}</button>}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="view-enter" style={{ display: 'flex', flexDirection: 'column', gap: 9 }} key="o">
          {LX.obligations.map(o => {
            const isR = remind.has(o.id);
            const dt = o.nextDate ? new Date(o.nextDate).toLocaleDateString('uk-UA', { day: '2-digit', month: 'long', year: 'numeric' }) : null;
            return (
              <div className="dl-card" key={o.id}>
                <span className="ob-freq-ic" style={{ color: riskTone[o.risk] }}><Icon name={freqIcon[o.freq]} size={15} /></span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 13.5 }}>{o.title}</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 5, alignItems: 'center' }}>
                    <span className="ob-chip ob-party">{partyLabel[o.party]}</span>
                    <span className="ob-chip">{freqLabel[o.freq]}</span>
                    <span style={{ fontSize: 11.5, color: 'var(--text-3)' }}>{o.basis}{dt ? ' · ' + t.obNext + ': ' + dt : ''}</span>
                  </div>
                </div>
                {o.nextDate
                  ? (isR
                    ? <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--risk-low)' }}>✓</span>
                    : <button className="btn btn-subtle btn-sm" onClick={() => remindOne(o)}><Icon name="bell" size={14} /> {t.obAddRem}</button>)
                  : <span className="ob-tracked">{t.obTracked}</span>}
              </div>
            );
          })}
        </div>
      )}
    </Modal>
  );
}

/* ---- Contract summary / plain-language explanation ---- */
function SummaryModal({ open, onClose, t, data, contractMarkdown }) {
  const [mode, setMode] = useState('pro');
  // Live summary from /api/summary. Cached per mode so toggling
  // back doesn't re-fetch.
  const [summaries, setSummaries] = useState({});  // { pro: string, plain: string }
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  const apiMode = mode === 'pro' ? 'legal' : 'plain';
  const liveSummary = summaries[mode];

  useEffect(() => {
    if (!open) return;
    if (summaries[mode] != null) return;  // cached
    if (!contractMarkdown) return;        // nothing to summarise
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    api.request('/api/summary', {
      method: 'POST',
      body: { contract: contractMarkdown, mode: apiMode },
    }).then(res => {
      if (cancelled) return;
      setSummaries(s => ({ ...s, [mode]: res?.summary ?? '' }));
    }).catch(_e => {
      if (cancelled) return;
      setFailed(true);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [open, mode, contractMarkdown]);

  const findings = data?.findings || [];
  const keyData = data?.keyData || [];
  const missing = data?.missing || [];
  const highs = findings.filter(f => f.level === 'high');
  const medN = findings.filter(f => f.level === 'med').length;

  const copy = () => {
    if (!liveSummary) return;
    try { navigator.clipboard.writeText(liveSummary); } catch (_e) {}
    toast(t.sumCopied, 'check');
  };

  const noDoc = !contractMarkdown;

  return (
    <Modal open={open} onClose={onClose} icon="sparkle" title={t.sumTitle} wide
      footer={<>
        <button className="btn btn-subtle" onClick={copy} disabled={!liveSummary}><Icon name="doc" size={15} /> {t.sumCopy}</button>
        <button className="btn btn-primary" onClick={onClose}>{t.close}</button>
      </>}>
      <div className="seg sum-toggle">
        <button className={mode === 'pro' ? 'on' : ''} onClick={() => setMode('pro')}><Icon name="scales" size={14} /> {t.sumPro}</button>
        <button className={mode === 'plain' ? 'on' : ''} onClick={() => setMode('plain')}><Icon name="sparkle" size={14} fill={true} /> {t.sumPlain}</button>
      </div>

      {noDoc ? (
        <div className="sum-disclaimer" style={{ marginTop: 8, color: 'var(--text-3)' }}>
          <Icon name="alert" size={13} /> {t.sumNoDoc || 'Завантажте договір, щоб згенерувати резюме.'}
        </div>
      ) : failed ? (
        <div className="sum-disclaimer" style={{ marginTop: 8, color: 'var(--risk-med)' }}>
          <Icon name="alert" size={13} /> {t.sumOffline || 'AI-резюме недоступне (API помилка). Спробуйте пізніше.'}
        </div>
      ) : null}

      {loading && !liveSummary ? (
        <div className="tr-loading"><span className="pulse" /> {t.sumLoading || t.trTranslating || 'Генеруємо…'}</div>
      ) : liveSummary ? (
        <div className="sum-body view-enter" key={'live-' + mode}>
          <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 14, lineHeight: 1.55, margin: 0 }}>{liveSummary}</pre>
        </div>
      ) : (keyData.length || findings.length || missing.length) ? (
        <div className="sum-body view-enter" key="offline-facts">
          {keyData.length ? (
            <div className="sum-sec">
              <div className="sum-h">{t.sumTerms}</div>
              <div className="sum-terms">
                {keyData.map((k, i) => (
                  <div key={i} className="sum-term">
                    <span className="sum-term-ic"><Icon name={k.icon || 'doc'} size={15} /></span>
                    <span><span className="sum-term-l">{k.label}</span><span className="sum-term-v">{k.value}</span></span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          {findings.length ? (
            <div className="sum-sec">
              <div className="sum-h">{t.sumRisks} <span className="sum-count">{highs.length} {t.sumCritical} · {medN} {t.sumModerate}</span></div>
              <div className="sum-risks">
                {highs.map(f => (
                  <div key={f.id} className="sum-risk">
                    <span className="badge-risk badge-high" style={{ flexShrink: 0 }}>{f.clause}</span>
                    <div><div className="sum-risk-t">{f.title}</div><div className="sum-risk-l">{f.law}</div></div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          {missing.length ? (
            <div className="sum-sec">
              <div className="sum-h">{t.sumMissing}</div>
              <div className="sum-chips">{missing.map((m, i) => <span key={i} className="sum-chip"><Icon name="alert" size={12} /> {m.title}</span>)}</div>
            </div>
          ) : null}
        </div>
      ) : null}
    </Modal>
  );
}

/* ---- Legal document translation (UA ⇄ EN) ---- */
function TranslateModal({ open, onClose, t, contractMarkdown }) {
  const [dir, setDir] = useState('uaen'); // uaen | enua
  const [loading, setLoading] = useState(false);
  // Live translation from /api/translate. Cached per direction.
  const [byDir, setByDir] = useState({});  // { uaen: {pairs, glossary, translation}, enua: ... }
  const [failed, setFailed] = useState(false);

  const apiDirection = dir === 'uaen' ? 'ua_en' : 'en_ua';
  const live = byDir[dir];

  useEffect(() => {
    if (!open) return;
    if (byDir[dir]) return;  // cached
    if (!contractMarkdown) return;
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    api.request('/api/translate', {
      method: 'POST',
      body: { text: contractMarkdown, direction: apiDirection },
    }).then(res => {
      if (cancelled) return;
      setByDir(s => ({
        ...s,
        [dir]: {
          pairs: res?.pairs ?? [],
          glossary: res?.glossary ?? [],
          translation: res?.translation ?? '',
        },
      }));
    }).catch(_e => {
      if (cancelled) return;
      setFailed(true);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [open, dir, contractMarkdown]);

  const srcKey = dir === 'uaen' ? 'ua' : 'en';
  const tgtKey = dir === 'uaen' ? 'en' : 'ua';
  const srcLang = dir === 'uaen' ? 'УКР' : 'ENG';
  const tgtLang = dir === 'uaen' ? 'ENG' : 'УКР';

  const pairsToRender = live
    ? live.pairs.map(p => ({ ua: dir === 'uaen' ? p.src : p.tgt, en: dir === 'uaen' ? p.tgt : p.src }))
    : [];
  const glossaryToRender = live
    ? live.glossary.map(g => [dir === 'uaen' ? g.src : g.tgt, dir === 'uaen' ? g.tgt : g.src])
    : [];

  const copy = () => {
    if (!live) return;
    try { navigator.clipboard.writeText(live.translation); } catch (_e) {}
    toast(t.trCopied, 'check');
  };

  const noDoc = !contractMarkdown;

  return (
    <Modal open={open} onClose={onClose} icon="globe" title={t.trTitle} sub={t.trSub} wide
      footer={<>
        <button className="btn btn-subtle" onClick={copy} disabled={!live}><Icon name="doc" size={15} /> {t.trCopy}</button>
        <button className="btn btn-primary" onClick={onClose}>{t.close}</button>
      </>}>
      <div className="tr-bar">
        <div className="seg">
          <button className={dir === 'uaen' ? 'on' : ''} onClick={() => setDir('uaen')}>УКР → ENG</button>
          <button className={dir === 'enua' ? 'on' : ''} onClick={() => setDir('enua')}>ENG → УКР</button>
        </div>
      </div>

      {noDoc ? (
        <div className="tr-note" style={{ color: 'var(--text-3)' }}>
          <Icon name="alert" size={13} /> {t.trNoDoc || 'Завантажте договір, щоб згенерувати переклад.'}
        </div>
      ) : failed ? (
        <div className="tr-note" style={{ color: 'var(--risk-med)' }}>
          <Icon name="alert" size={13} /> {t.trOffline || 'AI-переклад недоступний (API помилка). Спробуйте пізніше.'}
        </div>
      ) : null}

      {glossaryToRender.length ? (
        <div className="tr-gloss">
          <div className="tr-gloss-h">{t.trGlossary}</div>
          <div className="tr-gloss-list">
            {glossaryToRender.map((g, i) => {
              const ua = g[0], en = g[1];
              return (
                <span key={i} className="tr-gloss-item">{dir === 'uaen' ? ua : en} <Icon name="arrowR" size={11} /> <b>{dir === 'uaen' ? en : ua}</b></span>
              );
            })}
          </div>
        </div>
      ) : null}

      {loading ? (
        <div className="tr-loading"><span className="pulse" /> {t.trTranslating}</div>
      ) : pairsToRender.length ? (
        <div className="tr-doc view-enter" key={dir}>
          <div className="tr-colhead"><span>{t.trSource} · {srcLang}</span><span>{t.trTarget} · {tgtLang}</span></div>
          {pairsToRender.map((p, i) => (
            <div key={i} className={'tr-row' + (p.head ? ' tr-row-head' : '')}>
              <div className="tr-cell tr-src">{p[srcKey]}</div>
              <div className="tr-cell tr-tgt">{p[tgtKey]}</div>
            </div>
          ))}
        </div>
      ) : null}
      <div className="tr-note"><Icon name="alert" size={13} /> {t.trNote}</div>
    </Modal>
  );
}

export { DiffModal, ApprovalModal, CommentsModal, DeadlinesModal, SummaryModal, TranslateModal, wordDiff };
