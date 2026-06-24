/* ============================================================
   ChatWindow — message thread + composer for the AI Lawyer.

   Hydrates from /api/chat/sessions/{id}/messages on session switch
   and sends via /api/lawyer-chat with the session id, so the server
   loads + persists the conversation. Optimistic local-append keeps
   the UI snappy.

   Helpers (renderAnswer, useTypewriter, BotBubble, sourceMeta) are
   lifted verbatim from the legacy screens/LawyerChat.jsx to keep
   the citation rendering identical.
   ============================================================ */
import { useEffect, useRef, useState } from 'react';
import { Icon } from '../../ui/Icon';
import { api, ApiError } from '../../lib/api';
import { toast } from '../../ui/components';

// Source → human label + Legal Search filter id. Must stay in sync with the
// LegalSearch screen filter values so citation jumps land on the right tab.
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

const _CITE_RE = /\(((?:ст\.?\s*)\d+[\w\-.]*\s+[Ѐ-ӿ]+|art\.?\s*\d+[\w\-.]*\s+\w+)\)/gi;
const _BOLD_RE = /\*\*([^*\n]+)\*\*/g;

function renderInline(text) {
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

export function ChatWindow({
  sessionId,
  ensureSession,
  onSessionPatched,
  onSessionMissing,
  onOpenSidebar,
  showMenuButton,
  t,
  setRoute,
}) {
  const [msgs, setMsgs] = useState([]);
  const [input, setInput] = useState('');
  const [thinking, setThinking] = useState(false);
  const [usage, setUsage] = useState(null);
  const [hydrating, setHydrating] = useState(false);
  const scrollRef = useRef(null);
  const inputRef = useRef(null);

  // Hydrate the thread whenever the active session changes. A null
  // sessionId means "empty state" — clear the window.
  useEffect(() => {
    if (!sessionId) {
      setMsgs([]);
      setUsage(null);
      return;
    }
    // Skip the fetch for optimistic temp ids — there's nothing on the
    // server yet, and the row is moments away from being swapped.
    if (sessionId.startsWith('tmp-')) {
      setMsgs([]);
      setUsage(null);
      return;
    }
    let cancelled = false;
    setHydrating(true);
    api.chat.messages.list(sessionId)
      .then(rows => {
        if (cancelled) return;
        const mapped = (rows || []).map(r => (
          r.role === 'user'
            ? { role: 'user', text: r.content }
            // Historical assistant turns lost their citations on persist —
            // render plain text without the source-card section.
            : { role: 'bot', text: r.content, cited: [], warnings: [], fresh: false }
        ));
        setMsgs(mapped);
        setUsage(null);
      })
      .catch(e => {
        if (cancelled) return;
        if (e instanceof ApiError && e.status === 404) {
          // Stale id (deleted on another device). Surface to parent so
          // the sidebar can drop us to the next session / empty state.
          onSessionMissing?.(sessionId);
          return;
        }
        toast(t.lawErrNet || 'Не вдалося завантажити історію.', 'alert');
      })
      .finally(() => { if (!cancelled) setHydrating(false); });
    return () => { cancelled = true; };
  }, [sessionId, onSessionMissing, t]);

  // Keep the thread scrolled to the latest turn.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs, thinking, hydrating]);

  // Auto-focus on mount + after session switch.
  useEffect(() => { inputRef.current?.focus(); }, [sessionId]);

  const jumpToLaw = (cited, meta) => {
    try {
      localStorage.setItem('aglex_legal_jump', JSON.stringify({
        articleNumber: cited.article_number,
        filter: meta.filter,
        ts: Date.now(),
      }));
    } catch { /* private mode — fine */ }
    setRoute('legal');
  };

  const send = async () => {
    const text = input.trim();
    if (!text || thinking) return;

    // Ensure an active session exists (auto-create if user typed before
    // clicking "+ Новий чат"). The parent owns session creation; we just
    // ask for an id.
    let sid = sessionId;
    if (!sid || sid.startsWith('tmp-')) {
      try {
        sid = await ensureSession();
      } catch {
        toast(t.lawErrNet || 'Не вдалося створити чат.', 'alert');
        return;
      }
      if (!sid) return;
    }

    const userMsg = { role: 'user', text };
    setMsgs(m => [...m.map(x => x.role === 'bot' ? { ...x, fresh: false } : x), userMsg]);
    setInput('');
    setThinking(true);

    try {
      const res = await api.chat.send({ question: text, sessionId: sid });
      setMsgs(m => [...m, {
        role: 'bot',
        text: res.answer || '',
        cited: res.cited_articles || [],
        warnings: res.warnings || [],
        fresh: true,
      }]);
      setUsage(res.usage || null);
      // Refresh the sidebar row (title may have changed on first turn,
      // updated_at always bumps).
      onSessionPatched?.(sid, {
        title: res.session_title,
        updated_at: new Date().toISOString(),
      });
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        // Session vanished mid-flight (deleted in another tab). Drop the
        // optimistic user message and notify the parent.
        setMsgs(m => m.slice(0, -1));
        onSessionMissing?.(sid);
        toast(t.lawErrMissing || 'Чат було видалено.', 'alert');
      } else {
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
      }
    } finally {
      setThinking(false);
    }
  };

  const empty = msgs.length === 0 && !thinking && !hydrating;
  const cacheHint = usage && usage.cache_read_input_tokens
    ? (t.lawCachedHint || 'Кеш заощадив') + ' ' + usage.cache_read_input_tokens.toLocaleString() + ' ' + (t.lawTokens || 'токенів')
    : null;

  return (
    <div className="cl-window">
      {showMenuButton ? (
        <button
          type="button"
          className="cl-window-menu"
          onClick={onOpenSidebar}
          aria-label={t.lawOpenSidebar || 'Історія чатів'}
        >
          <Icon name="menu" size={17} />
        </button>
      ) : null}

      <div className="cop-scroll cl-scroll" ref={scrollRef}>
        <div className="cop-inner cl-inner">
          {empty ? (
            <div className="cl-welcome view-enter">
              <div className="lc-hero-av cl-hero-av" aria-hidden="true">
                <Icon name="scales" size={26} />
                <span className="lc-hero-glow" />
              </div>
              <h1 className="cl-hero-t">{t.lawTitle || 'AI-адвокат'}</h1>
              <p className="cl-hero-s">
                {t.lawHeroSub || 'Юридичний асистент · Claude. Поставте питання — відповім коротко, з посиланнями на статті.'}
              </p>
            </div>
          ) : (
            <div className="cop-thread cl-thread">
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

      <div className="cop-composer lc-composer cl-composer">
        <div className="cop-composer-inner">
          <div className="cop-input lc-input">
            <Icon name="scales" size={16} style={{ color: 'var(--accent)' }} />
            <input
              ref={inputRef}
              value={input}
              placeholder={t.lawPlaceholder || 'Поставте питання…'}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
              }}
            />
            <button
              className="cop-send"
              disabled={!input.trim() || thinking}
              onClick={send}
              aria-label={t.lawSend || 'Надіслати'}
            >
              <Icon name="send" size={17} />
            </button>
          </div>
          <div className="lc-foot">
            <span className="lc-disc">
              {t.lawDisclaimer || 'Відповіді ШІ — рекомендаційні, не замінюють юридичну консультацію.'}
            </span>
            {cacheHint ? (
              <span className="lc-cache">
                <Icon name="sparkle" size={11} fill={true} /> {cacheHint}
              </span>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
