/* ============================================================
   AG Lex — Practice copilot (AI-помічник)
   A workspace-wide assistant: answers questions over matters,
   contracts, tasks, deadlines, invoices, clients & team, and
   returns clickable result cards. Deterministic keyword engine.
   ============================================================ */
import { useState, useRef, useEffect } from 'react';
import { Icon } from '../ui/Icon';
import { DEMO } from '../data/demo';
import { LX } from '../data/lx';
import { I18N } from '../data/i18n';
import { roleLabel } from '../lib/labels';

const COP_TODAY = new Date(2026, 5, 9);
function copParseDue(due) { const m = String(due || '').split('.'); if (m.length < 2) return null; return new Date(2026, parseInt(m[1], 10) - 1, parseInt(m[0], 10)); }
function copFmtDate(d) { return d.toLocaleDateString('uk-UA', { day: '2-digit', month: 'short' }); }

/* ---- answer engine ---- */
function copilotAnswer(q) {
  const D = DEMO;
  const s = (q || '').toLowerCase();
  const card = (icon, title, sub, route, risk) => ({ icon, title, sub, route, risk });
  const has = (...ks) => ks.some(k => s.includes(k));

  // judicial disputes
  if (has('спір', 'спор', 'суд', 'позов', 'litig')) {
    const ms = LX.matters.filter(m => /спір|суд/i.test(m.type));
    return { text: `Активних судових спорів: ${ms.length}. Найгарячіший — спір з підряду ОСББ «Зарічне» (4 відкриті задачі).`,
      cards: ms.map(m => card('scales', m.title, `${m.code} · ${m.client}`, 'matters')) };
  }
  // active matters
  if (has('справ', 'matter', 'дел', 'проваджен')) {
    const ms = LX.matters.filter(m => m.status === 'active');
    return { text: `Зараз активних справ: ${ms.length}.`,
      cards: ms.map(m => card('folder', m.title, `${m.code} · ${m.client} · ${m.openTasks} задач`, 'matters')) };
  }
  // NDA / confidentiality
  if (has('nda', 'нерозголош', 'конфіденц')) {
    const cs = D.library.filter(c => /nda|нерозголош/i.test(c.name + ' ' + c.type));
    return { text: `Знайдено документів про нерозголошення: ${cs.length}. NDA зі Sky Labs — на стадії узгодження.`,
      cards: cs.map(c => card('book', c.name, `${c.client} · ${c.date}`, 'library', c.risk)) };
  }
  // lease
  if (has('оренд', 'lease', 'приміщ')) {
    const cs = D.library.filter(c => /оренд/i.test(c.name + ' ' + c.type));
    return { text: `Договорів оренди: ${cs.length}. Зверніть увагу на строк повідомлення про припинення.`,
      cards: cs.map(c => card('folder', c.name, `${c.client} · ${c.date}`, 'library', c.risk)) };
  }
  // deadlines this week / upcoming
  if (has('строк', 'дедлайн', 'термін', 'deadline', 'тижд', 'календар')) {
    const up = D.tasks.map(t => ({ ...t, d: new Date(t.date) })).filter(t => t.d >= COP_TODAY).sort((a, b) => a.d - b.d).slice(0, 5);
    const week = up.filter(t => (t.d - COP_TODAY) / 86400000 <= 7);
    return { text: `Найближчі строки: ${week.length} цього тижня, ${up.length} у найближчий час. Два з них критичні.`,
      cards: up.map(t => card('calendar', t.title, `${t.client} · ${copFmtDate(t.d)}`, 'calendar', t.risk)) };
  }
  // invoices / billing
  if (has('рахун', 'білінг', 'інвойс', 'оплат', 'несплач', 'invoice', 'борг')) {
    const unpaid = LX.invoices.filter(i => i.status !== 'paid');
    const sum = unpaid.reduce((a, i) => a + i.amount, 0);
    return { text: `Неоплачених рахунків: ${unpaid.length} на суму ${sum.toLocaleString('uk-UA')} ₴.`,
      cards: unpaid.map(i => card('coins', `${i.num} · ${i.client}`, `${i.period} · ${i.amount.toLocaleString('uk-UA')} ₴ · ${i.status === 'sent' ? 'надіслано' : 'чернетка'}`, 'billing', i.status === 'draft' ? 'med' : 'low')) };
  }
  // overdue / my tasks
  if (has('задач', 'таск', 'task', 'роботи', 'доруч')) {
    const overdue = LX.tasks.filter(t => { const d = copParseDue(t.due); return d && d < COP_TODAY && t.col !== 'done'; });
    if (has('простроч', 'overdue', 'горить', 'термінов') || overdue.length) {
      return { text: `Прострочених задач: ${overdue.length}. Потребують негайної уваги.`,
        cards: overdue.map(t => card('alert', t.title, `${t.matter} · до ${t.due}`, 'tasks', t.priority)) };
    }
    const open = LX.tasks.filter(t => t.col !== 'done').slice(0, 5);
    return { text: `Відкритих задач: ${LX.tasks.filter(t => t.col !== 'done').length}.`,
      cards: open.map(t => card('check', t.title, `${t.matter} · до ${t.due}`, 'tasks', t.priority)) };
  }
  // risks / high-risk contracts
  if (has('ризик', 'risk', 'небезпе', 'проблемн')) {
    const hi = D.library.filter(c => c.risk === 'high');
    return { text: `Договорів з високим ризиком: ${hi.length}. У поточному договорі «Северин» — 3 критичні ризики (передоплата, відповідальність, розірвання).`,
      cards: hi.map(c => card('alert', c.name, `${c.client} · оцінка ${c.score}`, 'library', 'high')) };
  }
  // approvals
  if (has('погодж', 'апрув', 'approval', 'підпис')) {
    const cur = LX.approval.find(a => a.status === 'current');
    return { text: `На погодженні: договір 2026/04-К очікує вашого рішення (етап «${cur ? cur.role : 'Погодження'}»).`,
      cards: [card('checkCircle', 'Договір про надання послуг', 'Маршрут погодження · етап погодження', 'analyze', 'med')] };
  }
  // clients
  if (has('клієнт', 'client', 'контрагент компані')) {
    return { text: `Активних клієнтів: ${D.clients.length}.`,
      cards: D.clients.slice(0, 5).map(c => card('building', c.name, `${c.sector} · ${c.contracts} договорів`, 'clients')) };
  }
  // team
  if (has('команд', 'юрист', 'хто ', 'team', 'колег', 'співробіт')) {
    return { text: `У команді ${LX.team.length} осіб.`,
      cards: LX.team.slice(0, 5).map(u => card('clients', u.name, roleLabel(I18N.uk, u.role) + ' · ' + u.email, 'team')) };
  }
  // direct name lookup
  const hit = D.library.find(c => s.length > 3 && c.name.toLowerCase().includes(s.slice(0, 8)));
  if (hit) {
    return { text: `Знайдено договір «${hit.name}».`, cards: [card('doc', hit.name, `${hit.client} · ${hit.date}`, 'library', hit.risk)] };
  }
  // contracts generic
  if (has('договор', 'контракт', 'contract', 'угод')) {
    return { text: `У бібліотеці ${D.library.length} договорів. Останні:`,
      cards: D.library.slice(0, 5).map(c => card('doc', c.name, `${c.client} · ${c.date}`, 'library', c.risk)) };
  }
  // fallback
  return { text: 'Я шукаю по всьому простору: справи, договори, задачі, строки, рахунки, клієнти й команда. Спробуйте запитати про активні справи, строки цього тижня, прострочені задачі або несплачені рахунки.', cards: [] };
}

const COP_SUGGEST = ['Які справи зараз активні?', 'Покажи судові спори', 'Які строки цього тижня?', 'Прострочені задачі', 'Несплачені рахунки', 'Договори з високим ризиком'];

function CopCards({ cards, setRoute }) {
  if (!cards || !cards.length) return null;
  const tone = { high: 'var(--risk-high)', med: 'var(--risk-med)', low: 'var(--risk-low)' };
  return (
    <div className="cop-cards">
      {cards.map((c, i) => (
        <button key={i} className="cop-card" onClick={() => setRoute(c.route)}>
          <span className="cop-card-ic" style={c.risk ? { color: tone[c.risk] || 'var(--accent)' } : null}><Icon name={c.icon} size={16} /></span>
          <span className="cop-card-tx"><span className="cop-card-t">{c.title}</span><span className="cop-card-s">{c.sub}</span></span>
          <Icon name="chevR" size={15} style={{ color: 'var(--text-3)', flexShrink: 0 }} />
        </button>
      ))}
    </div>
  );
}

function Copilot({ t, setRoute }) {
  const D = DEMO;
  const [msgs, setMsgs] = useState([]);
  const [input, setInput] = useState('');
  const [thinking, setThinking] = useState(false);
  const scrollRef = useRef(null);

  useEffect(() => { const el = scrollRef.current; if (el) el.scrollTop = el.scrollHeight; }, [msgs, thinking]);

  const send = (q) => {
    const text = (q == null ? input : q).trim();
    if (!text || thinking) return;
    setMsgs(m => [...m, { role: 'user', text }]);
    setInput('');
    setThinking(true);
    setTimeout(() => {
      const a = copilotAnswer(text);
      setMsgs(m => [...m, { role: 'bot', text: a.text, cards: a.cards }]);
      setThinking(false);
    }, 520);
  };

  // digest
  const hiRisk = D.library.filter(c => c.risk === 'high').length;
  const week = D.tasks.filter(tk => { const d = new Date(tk.date); return d >= COP_TODAY && (d - COP_TODAY) / 86400000 <= 7; }).length;
  const overdue = LX.tasks.filter(tk => { const d = copParseDue(tk.due); return d && d < COP_TODAY && tk.col !== 'done'; }).length;
  const digest = [
    { icon: 'alert', label: t.digHighRisk, n: hiRisk, route: 'library', risk: 'high' },
    { icon: 'calendar', label: t.digWeek, n: week, route: 'calendar', risk: 'med' },
    { icon: 'checkCircle', label: t.digApproval, n: 1, route: 'analyze', risk: 'med' },
    { icon: 'check', label: t.digOverdue, n: overdue, route: 'calendar', risk: 'high' },
  ];

  const empty = msgs.length === 0;
  return (
    <div className="page cop-page">
      <div className="cop-scroll" ref={scrollRef}>
        <div className="cop-inner">
          {empty ? (
            <div className="cop-welcome view-enter">
              <div className="cop-orb"><Icon name="sparkle" size={26} fill={true} /></div>
              <h1 className="cop-greet">{t.copilotGreeting}</h1>
              <p className="cop-greet-sub">{t.copilotSub}</p>

              <div className="cop-digest">
                <div className="cop-digest-h">{t.copilotDigest}</div>
                <div className="cop-digest-grid">
                  {digest.map((d, i) => (
                    <button key={i} className="cop-digest-card" onClick={() => setRoute(d.route)}>
                      <span className="cop-digest-ic" style={{ color: { high: 'var(--risk-high)', med: 'var(--risk-med)', low: 'var(--risk-low)' }[d.risk] }}><Icon name={d.icon} size={16} /></span>
                      <span className="cop-digest-n">{d.n}</span>
                      <span className="cop-digest-l">{d.label}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="cop-try">{t.copilotTry}</div>
              <div className="cop-chips">
                {COP_SUGGEST.map((q, i) => <button key={i} className="cop-chip" onClick={() => send(q)}>{q}</button>)}
              </div>
            </div>
          ) : (
            <div className="cop-thread">
              {msgs.map((m, i) => (
                <div key={i} className={'cop-msg cop-' + m.role}>
                  {m.role === 'bot' ? <span className="cop-av"><Icon name="sparkle" size={14} fill={true} /></span> : null}
                  <div className="cop-bubble">
                    <div className="cop-text">{m.text}</div>
                    {m.role === 'bot' ? <CopCards cards={m.cards} setRoute={setRoute} /> : null}
                  </div>
                </div>
              ))}
              {thinking ? (
                <div className="cop-msg cop-bot">
                  <span className="cop-av"><Icon name="sparkle" size={14} fill={true} /></span>
                  <div className="cop-bubble"><div className="cop-typing"><span /><span /><span /></div></div>
                </div>
              ) : null}
            </div>
          )}
        </div>
      </div>

      <div className="cop-composer">
        <div className="cop-composer-inner">
          {!empty ? (
            <div className="cop-chips cop-chips-row">
              {COP_SUGGEST.slice(0, 4).map((q, i) => <button key={i} className="cop-chip" onClick={() => send(q)}>{q}</button>)}
            </div>
          ) : null}
          <div className="cop-input">
            <input value={input} placeholder={t.copilotPlaceholder}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') send(); }} />
            <button className="cop-send" disabled={!input.trim() || thinking} onClick={() => send()}><Icon name="send" size={17} /></button>
          </div>
        </div>
      </div>
    </div>
  );
}

export { Copilot };
