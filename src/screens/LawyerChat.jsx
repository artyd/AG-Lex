/* ============================================================
   AG Lex — Lawyer Chat (AI-адвокат).
   Conversational legal assistant grounded in the codex via
   /api/lawyer-chat. Persona: 30-year senior lawyer. Each bot
   reply streams character-by-character and ends with clickable
   citation cards that jump to the Legal Search screen.
   ============================================================ */
import { useState, useRef, useEffect } from 'react';
import { Icon } from '../ui/Icon';
import { api, ApiError } from '../lib/api';
import { toast } from '../ui/components';

// Suggestion chips, surfaced on the welcome state. Tuned to questions where
// the codex actually has good UA + ЦК coverage so a cold-start demo lands.
const LAW_SUGGEST_UK = [
  'Як одностороннє розірвання договору регулюється ЦКУ?',
  'Який строк позовної давності за договірними зобовʼязаннями?',
  'Що робити, якщо контрагент прострочив оплату на 60 днів?',
  'Які підстави для зменшення неустойки судом?',
  'Чи можна стягнути моральну шкоду за порушення договору?',
];
const LAW_SUGGEST_EN = [
  'How is unilateral contract termination regulated under the Civil Code?',
  'What is the statute of limitations for contractual obligations?',
  'What if the counterparty is 60 days late on payment?',
  'On what grounds can a court reduce a contractual penalty?',
  'Can moral damages be recovered for breach of contract?',
];

// Source → human label + Legal Search filter id. Keep this stable with the
// `LegalSearch` screen filter values so jumps land in the right tab.
const SOURCE_LABEL = {
  'ЦКУ': { label: 'ЦКУ', tone: 'accent', filter: 'code' },
  'ГКУ': { label: 'ГКУ', tone: 'accent', filter: 'code' },
  'ЦПК': { label: 'ЦПК', tone: 'info', filter: 'law' },
  'ГПК': { label: 'ГПК', tone: 'info', filter: 'law' },
  'EU_GDPR': { label: 'GDPR', tone: 'low', filter: 'eu' },
};
function sourceMeta(source) {
  return SOURCE_LABEL[source] || { label: source || '—', tone: 'muted', filter: 'all' };
}

// Light markdown-ish renderer.
// The system prompt asks for:
//   1) **bold** on the lead sentence,
//   2) plain paragraphs,
//   3) a numbered list at the end ("1. ...", "2. ...").
// We split on blank lines, then per paragraph either render a <ol> (when
// every line starts with "N. ") or a <p> with **bold** segments turned into
// <strong>. Citations like "(ст. 651 ЦКУ)" become a styled chip via regex.
const _CITE_RE = /\(((?:ст\.?\s*)\d+[\w\-.]*\s+[Ѐ-ӿ]+|art\.?\s*\d+[\w\-.]*\s+\w+)\)/gi;
const _BOLD_RE = /\*\*([^*\n]+)\*\*/g;

function renderInline(text) {
  // First wrap citations, then bolds. Output is a flat array of strings + nodes.
  const parts = [];
  let last = 0;
  let key = 0;
  const matches = [...text.matchAll(_CITE_RE)];
  matches.forEach((m) => {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(<span key={'c' + (key++)} className="lc-cite">{m[1]}</span>);
    last = m.index + m[0].length;
  });
  if (last < text.length) parts.push(text.slice(last));
  // Now bold-walk the string segments only.
  return parts.flatMap((p, i) => {
    if (typeof p !== 'string') return [p];
    const segs = [];
    let l = 0;
    let bk = 0;
    [...p.matchAll(_BOLD_RE)].forEach((bm) => {
      if (bm.index > l) segs.push(p.slice(l, bm.index));
      segs.push(<strong key={'b' + i + '-' + (bk++)}>{bm[1]}</strong>);
      l = bm.index + bm[0].length;
    });
    if (l < p.length) segs.push(p.slice(l));
    return segs.length ? segs : [p];
  });
}

function renderAnswer(text) {
  // Split into paragraphs on blank lines.
  const paras = text.replace(/\r/g, '').split(/\n\s*\n/).map(s => s.trim()).filter(Boolean);
  return paras.map((p, i) => {
    const lines = p.split('\n').map(l => l.trim()).filter(Boolean);
    const numbered = lines.every(l => /^\d+\.\s+/.test(l));
    if (numbered) {
      return (
        <ol key={i} className="lc-list">
          {lines.map((l, j) => (
            <li key={j}>{renderInline(l.replace(/^\d+\.\s+/, ''))}</li>
          ))}
        </ol>
      );
    }
    return <p key={i}>{renderInline(p)}</p>;
  });
}

// Character-by-character reveal. We expose a hook that returns the
// currently-visible substring + a `done` flag so the parent can swap to
// the fully-rendered version once the animation completes (otherwise we'd
// re-parse markdown on every frame).
function useTypewriter(full, enabled, speed = 14) {
  const [shown, setShown] = useState(enabled ? '' : full);
  const [done, setDone] = useState(!enabled);
  const rafRef = useRef(0);
  useEffect(() => {
    if (!enabled) { setShown(full); setDone(true); return; }
    let i = 0;
    setShown('');
    setDone(false);
    let last = performance.now();
    const step = (now) => {
      const dt = now - last;
      // chars to advance this frame — speed is "chars per ~16ms tick"
      const inc = Math.max(1, Math.floor((dt / 16) * (speed / 6)));
      i = Math.min(full.length, i + inc);
      setShown(full.slice(0, i));
      last = now;
      if (i < full.length) {
        rafRef.current = requestAnimationFrame(step);
      } else {
        setDone(true);
      }
    };
    rafRef.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafRef.current);
  }, [full, enabled, speed]);
  return { shown, done };
}

function BotBubble({ msg, t, onJumpToLaw }) {
  // Animate only the most recent bot reply (msg.fresh). Older replies in
  // history re-render fully so scrolling back doesn't replay the typewriter.
  const { shown, done } = useTypewriter(msg.text, !!msg.fresh, 14);
  const showCards = done && Array.isArray(msg.cited) && msg.cited.length > 0;
  return (
    <div className="cop-msg cop-bot lc-msg-enter">
      <span className="lc-av" aria-hidden="true">
        <Icon name="scales" size={15} />
      </span>
      <div className="cop-bubble lc-bubble">
        <div className="cop-text lc-text">
          {renderAnswer(shown)}
          {!done ? <span className="lc-caret" aria-hidden="true" /> : null}
        </div>
        {showCards ? (
          <div className="lc-sources">
            <div className="lc-sources-h">{t.lawSources || 'Підстава'}</div>
            <div className="cop-cards">
              {msg.cited.map((c, i) => {
                const m = sourceMeta(c.source);
                return (
                  <button key={i} className="cop-card lc-source-card"
                    onClick={() => onJumpToLaw(c, m)}>
                    <span className={'cop-card-ic lc-src-' + m.tone}>
                      <Icon name="book" size={14} />
                    </span>
                    <span className="cop-card-tx">
                      <span className="cop-card-t">
                        ст. {c.article_number || '—'}{c.title ? ' · ' + c.title : ''}
                      </span>
                      <span className="cop-card-s">{m.label}</span>
                    </span>
                    <Icon name="chevR" size={14} style={{ color: 'var(--text-3)' }} />
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}
        {done && Array.isArray(msg.warnings) && msg.warnings.length ? (
          <div className="lc-warn">
            <Icon name="alert" size={13} />
            <span>{msg.warnings[0]}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function LawyerChat({ t, setRoute, lang }) {
  const [msgs, setMsgs] = useState([]);
  const [input, setInput] = useState('');
  const [thinking, setThinking] = useState(false);
  const [usage, setUsage] = useState(null);
  const scrollRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs, thinking]);

  // Auto-focus on mount so the user can start typing immediately.
  useEffect(() => { inputRef.current?.focus(); }, []);

  const suggest = (lang === 'en' ? LAW_SUGGEST_EN : LAW_SUGGEST_UK);

  const jumpToLaw = (cited, meta) => {
    // Stash a hint for LegalSearch so it can pre-filter on open. Best-effort
    // — if the screen ignores the hint, the user still lands on the right tab.
    try {
      localStorage.setItem('aglex_legal_jump', JSON.stringify({
        articleNumber: cited.article_number,
        filter: meta.filter,
        ts: Date.now(),
      }));
    } catch (_e) { /* private mode — fine */ }
    setRoute('legal');
  };

  const send = async (q) => {
    const text = (q == null ? input : q).trim();
    if (!text || thinking) return;
    // Push user turn + clear input optimistically.
    const newUser = { role: 'user', text };
    // Mark prior bot messages as "not fresh" so only the upcoming reply types out.
    setMsgs(m => [...m.map(x => x.role === 'bot' ? { ...x, fresh: false } : x), newUser]);
    setInput('');
    setThinking(true);
    // Build the history snapshot we send: every prior msg with role mapped.
    // (We compute against the previous `msgs` value via a stale closure on
    // purpose — the user turn we just pushed becomes `question`, not history.)
    const history = msgs.map(m => ({
      role: m.role === 'bot' ? 'assistant' : 'user',
      text: m.text,
    }));
    try {
      const res = await api.request('/api/lawyer-chat', {
        method: 'POST',
        body: { question: text, history },
      });
      setMsgs(m => [...m, {
        role: 'bot',
        text: res.answer || '',
        cited: res.cited_articles || [],
        warnings: res.warnings || [],
        fresh: true,
      }]);
      setUsage(res.usage || null);
    } catch (e) {
      const detail = e instanceof ApiError
        ? (e.status === 502 ? (t.lawErrUpstream || 'Сервіс ШІ тимчасово недоступний.')
            : e.status === 403 ? (t.lawErrForbidden || 'У вас немає доступу до ШІ-відповідей.')
            : e.message)
        : (t.lawErrNet || 'Не вдалося відправити запит — перевірте звʼязок.');
      setMsgs(m => [...m, {
        role: 'bot',
        text: '**' + (t.lawErrTitle || 'Не вийшло отримати відповідь.') + '** ' + detail,
        cited: [],
        warnings: [],
        fresh: true,
        error: true,
      }]);
      toast(detail, 'alert');
    } finally {
      setThinking(false);
    }
  };

  const empty = msgs.length === 0;
  // Token-saved hint for the composer.
  const cacheHint = usage && usage.cache_read_input_tokens
    ? (t.lawCachedHint || 'Кеш заощадив') + ' ' + usage.cache_read_input_tokens.toLocaleString() + ' ' + (t.lawTokens || 'токенів')
    : null;

  return (
    <div className="page cop-page lc-page">
      <div className="cop-scroll" ref={scrollRef}>
        <div className="cop-inner">
          {empty ? (
            <div className="cop-welcome view-enter lc-welcome">
              <div className="lc-hero-av" aria-hidden="true">
                <Icon name="scales" size={28} />
                <span className="lc-hero-glow" />
              </div>
              <h1 className="cop-greet">{t.lawTitle || 'AI-адвокат'}</h1>
              <p className="cop-greet-sub">
                {t.lawSub || '30 років практики, договірне й господарське право. Запитуйте — відповім коротко й по суті, з посиланнями на статті.'}
              </p>

              <div className="lc-creds">
                <span className="lc-cred"><Icon name="scales" size={13} /> {t.lawCred1 || 'Цивільне та господарське право'}</span>
                <span className="lc-cred"><Icon name="book" size={13} /> {t.lawCred2 || 'Грунтується на ЦКУ, ГКУ, ГДПР'}</span>
                <span className="lc-cred"><Icon name="sparkle" size={13} fill={true} /> {t.lawCred3 || 'Економний режим — кеш токенів'}</span>
              </div>

              <div className="cop-try lc-try">{t.lawTry || 'Спробуйте запитати'}</div>
              <div className="cop-chips lc-chips">
                {suggest.map((q, i) => (
                  <button key={i} className="cop-chip lc-chip" onClick={() => send(q)}>
                    {q}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="cop-thread">
              {msgs.map((m, i) => (
                m.role === 'user' ? (
                  <div key={i} className="cop-msg cop-user lc-msg-enter">
                    <div className="cop-bubble">
                      <div className="cop-text">{m.text}</div>
                    </div>
                  </div>
                ) : (
                  <BotBubble key={i} msg={m} t={t} onJumpToLaw={jumpToLaw} />
                )
              ))}
              {thinking ? (
                <div className="cop-msg cop-bot lc-msg-enter">
                  <span className="lc-av lc-av-think" aria-hidden="true">
                    <Icon name="scales" size={15} />
                  </span>
                  <div className="cop-bubble lc-bubble">
                    <div className="lc-thinking-row">
                      <div className="cop-typing"><span /><span /><span /></div>
                      <span className="lc-thinking-l">{t.lawThinking || 'Шукаю в кодексах…'}</span>
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          )}
        </div>
      </div>

      <div className="cop-composer lc-composer">
        <div className="cop-composer-inner">
          {!empty ? (
            <div className="cop-chips cop-chips-row lc-chips">
              {suggest.slice(0, 4).map((q, i) => (
                <button key={i} className="cop-chip lc-chip" onClick={() => send(q)}>{q}</button>
              ))}
            </div>
          ) : null}
          <div className="cop-input lc-input">
            <Icon name="scales" size={16} style={{ color: 'var(--accent)' }} />
            <input ref={inputRef} value={input}
              placeholder={t.lawPlaceholder || 'Запитайте адвоката…'}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
            <button className="cop-send" disabled={!input.trim() || thinking} onClick={() => send()}
              aria-label={t.lawSend || 'Надіслати'}>
              <Icon name="send" size={17} />
            </button>
          </div>
          <div className="lc-foot">
            <span className="lc-disc">{t.lawDisclaimer || 'Відповіді ШІ — рекомендаційні, не замінюють юридичну консультацію.'}</span>
            {cacheHint ? <span className="lc-cache"><Icon name="sparkle" size={11} fill={true} /> {cacheHint}</span> : null}
          </div>
        </div>
      </div>
    </div>
  );
}

export { LawyerChat };
