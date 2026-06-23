/* ============================================================
   AG Lex — shared components: Sidebar, TopBar, GlobalSearch,
   Modal, Toaster, toast(), ScoreRing, RiskBadge, riskDot,
   SectionTitle.
   ============================================================ */
import { useState, useEffect, useRef, useMemo } from 'react';
import { Icon } from './Icon';
export { Icon };
import { HelpTip } from './HelpTip';
export { HelpTip };
import { DEMO } from '../data/demo';
import { LX } from '../data/lx';
import { hueOf, initialsOf } from '../lib/auth';
import { roleLabel } from '../lib/labels';

/* ---- Score ring ---- */
export function ScoreRing({ value, size = 72, stroke = 7, color }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const off = c * (1 - value / 100);
  const hue = value >= 75 ? 158 : value >= 55 ? 70 : 25;
  const col = color || `oklch(0.62 0.14 ${hue})`;
  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="var(--border)" strokeWidth={stroke} />
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={col} strokeWidth={stroke}
          strokeDasharray={c} strokeDashoffset={off} strokeLinecap="round"
          style={{ transition: 'stroke-dashoffset 1.1s cubic-bezier(.22,.61,.36,1)' }} />
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', flexDirection: 'column' }}>
        <div style={{ fontSize: size * 0.30, fontWeight: 700, lineHeight: 1, color: col }}>{value}</div>
      </div>
    </div>
  );
}

/** Lightweight rounded badge with optional variant + icon. Promoted from
 *  the inline-styled `demo` chip in ContractAnalysis (PR-3). Add a
 *  variant in styles.css → expand the union here.
 *  variant ∈ 'muted' (default) | 'accent' | 'warn' */
export function Badge({ variant = 'muted', icon, children, title }) {
  return (
    <span className={'ag-badge ag-badge-' + variant} title={title}>
      {icon ? <Icon name={icon} size={11} /> : null}
      {children}
    </span>
  );
}

export function RiskBadge({ level, t }) {
  const map = { high: ['badge-high', t.riskHigh], med: ['badge-med', t.riskMed], low: ['badge-low', t.riskLow] };
  const [cls, label] = map[level] || map.low;
  return <span className={'badge-risk ' + cls}>{label}</span>;
}

export function riskDot(level) {
  const c = { high: 'var(--risk-high)', med: 'var(--risk-med)', low: 'var(--risk-low)' }[level] || 'var(--text-3)';
  return <span className="chip-dot" style={{ background: c }} />;
}

/* ---- Sidebar ---- */
export function Sidebar({ route, setRoute, t, riskCount, onUpload, onSettings, user }) {
  const work = [
    { id: 'lawyer', icon: 'scales', label: t.lawNav || 'AI-адвокат' },
    { id: 'dashboard', icon: 'dashboard', label: t.dashboard },
    { id: 'builder', icon: 'wand', label: t.builder },
    { id: 'library', icon: 'library', label: t.library, badge: riskCount },
  ];
  const practice = [
    { id: 'matters', icon: 'folder', label: t.matters },
    { id: 'litigation', icon: 'flag', label: t.litigation },
    { id: 'calendar', icon: 'calendar', label: t.calendar, badge: 2 },
  ];
  const knowledge = [
    { id: 'clauses', icon: 'book', label: t.clauseLib },
    { id: 'legal', icon: 'scales', label: t.legalSearch },
    { id: 'counterparty', icon: 'building', label: t.counterparty },
  ];
  const manage = [
    { id: 'clients', icon: 'clients', label: t.clients },
    { id: 'conflict', icon: 'shield', label: t.conflict },
    { id: 'portal', icon: 'globe', label: t.portal },
    { id: 'templates', icon: 'templates', label: t.templates },
    { id: 'team', icon: 'settings', label: t.team },
  ];
  const tipsByNav = (t.tips || {});
  const navTipKey = (id) => ({
    dashboard: 'navDashboard', analyze: 'navAnalyze', builder: 'navBuilder',
    copilot: 'navCopilot', library: 'navLibrary', matters: 'navMatters',
    team: 'navTeam',
  })[id];
  const NavItem = (it) => {
    const tipKey = navTipKey(it.id);
    const btn = (
      <button className={'nav-item' + (route === it.id ? ' active' : '')} onClick={() => setRoute(it.id)}>
        <Icon name={it.icon} size={19} stroke={route === it.id ? 2.2 : 1.9} />
        <span>{it.label}</span>
        {it.badge ? <span className="nav-badge">{it.badge}</span> : null}
      </button>
    );
    return (
      <HelpTip key={it.id} text={tipKey ? tipsByNav[tipKey] : ''} placement="right">
        {btn}
      </HelpTip>
    );
  };
  const groups = [
    { id: 'work', label: t.navWork, items: work },
    { id: 'practice', label: t.navPractice, items: practice },
    { id: 'knowledge', label: t.navKnowledge, items: knowledge },
    { id: 'manage', label: t.navManage, items: manage },
  ];
  const [openG, setOpenG] = useState(() => {
    try { const s = JSON.parse(localStorage.getItem('aglex_navgroups')); if (s) return s; } catch (e) {}
    const o = {}; groups.forEach(g => { o[g.id] = g.items.some(it => it.id === route); });
    if (!Object.values(o).some(Boolean)) o.work = true;
    return o;
  });
  useEffect(() => { localStorage.setItem('aglex_navgroups', JSON.stringify(openG)); }, [openG]);
  useEffect(() => {
    const g = groups.find(x => x.items.some(it => it.id === route));
    if (g && !openG[g.id]) setOpenG(o => ({ ...o, [g.id]: true }));
  }, [route]);
  const toggleG = (id) => setOpenG(o => ({ ...o, [id]: !o[id] }));
  return (
    <aside className="sidebar">
      <div className="brand" onClick={() => setRoute('dashboard')}>
        <div className="brand-mark" style={{ fontSize: 13, letterSpacing: '-0.03em' }}>AG</div>
        <div>
          <div className="brand-name">AG Lex</div>
          <div className="brand-sub">{t.brandSub}</div>
        </div>
      </div>

      <HelpTip text={tipsByNav.hubContract} placement="right">
        <button className="btn btn-primary" style={{ justifyContent: 'center', margin: '0 6px 4px' }} onClick={onUpload}>
          <Icon name="upload" size={17} /> {t.upload}
        </button>
      </HelpTip>

      <div className="nav-scroll">
        {groups.map(g => (
          <div className="nav-group" key={g.id}>
            <button className={'nav-group-head' + (openG[g.id] ? ' open' : '')} onClick={() => toggleG(g.id)}>
              <span>{g.label}</span>
              <Icon name="chevD" size={14} />
            </button>
            {openG[g.id] ? <div className="nav-group-items">{g.items.map(NavItem)}</div> : null}
          </div>
        ))}
      </div>

      <div className="sidebar-foot">
        <HelpTip text={tipsByNav.settingsBtn} placement="right">
          <button className="nav-item" onClick={onSettings}>
            <Icon name="settings" size={19} stroke={1.9} /> <span>{t.settings}</span>
          </button>
        </HelpTip>
        <div className="user-chip" onClick={onSettings}>
          <div className="avatar" style={{ background: user ? `oklch(0.58 0.14 ${hueOf(user.email)})` : undefined }}>{user ? initialsOf(user.name) : '?'}</div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{user ? user.name : ''}</div>
            <div style={{ fontSize: 11.5, color: 'var(--sidebar-muted)' }}>{user ? roleLabel(t, user.role) : ''}</div>
          </div>
        </div>
      </div>
    </aside>
  );
}

/* ---- Global search (cross-workspace) ---- */
function buildSearchIndex(t) {
  const D = DEMO;
  const idx = [];
  (D.library || []).forEach(c => idx.push({ type: 'contract', label: c.name, sub: c.client + ' · ' + c.date, route: 'library', risk: c.risk }));
  (LX.matters || []).forEach(m => idx.push({ type: 'matter', label: m.title, sub: m.code + ' · ' + m.client, route: 'matters' }));
  (D.clients || []).forEach(c => idx.push({ type: 'client', label: c.name, sub: c.sector, route: 'clients' }));
  (LX.tasks || []).forEach(k => idx.push({ type: 'task', label: k.title, sub: k.matter, route: 'calendar' }));
  (LX.clauseLib || []).forEach(cat => (cat.items || []).forEach(it => idx.push({ type: 'clause', label: it.title, sub: cat.cat, route: 'clauses' })));
  (LX.laws || []).forEach(l => idx.push({ type: 'law', label: l.ref, sub: l.title, route: 'legal' }));
  (LX.team || []).forEach(u => idx.push({ type: 'person', label: u.name, sub: roleLabel(t, u.role), route: 'team' }));
  (D.templates || []).forEach(tp => idx.push({ type: 'template', label: tp.name, sub: tp.cat, route: 'templates' }));
  return idx;
}
const SEARCH_TYPE_ICON = { contract: 'doc', matter: 'folder', client: 'building', task: 'check', clause: 'book', law: 'scales', person: 'clients', template: 'templates' };
const SEARCH_TYPE_ORDER = ['contract', 'matter', 'client', 'task', 'clause', 'law', 'person', 'template'];

function GlobalSearch({ t, value, onChange, onNavigate, onSearchEnter }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const wrapRef = useRef(null);
  const index = useMemo(() => buildSearchIndex(t), [t.library, t.matters]);
  const typeLabel = { contract: t.library, matter: t.matters, client: t.clients, task: t.mTasks, clause: t.clauseLib, law: t.legalSearch, person: t.team, template: t.templates };

  const lc = (value || '').trim().toLowerCase();
  const results = useMemo(() => {
    if (!lc) return [];
    const hit = index.filter(it => (it.label + ' ' + it.sub).toLowerCase().includes(lc));
    const out = [];
    SEARCH_TYPE_ORDER.forEach(tp => hit.filter(h => h.type === tp).slice(0, 4).forEach(h => out.push(h)));
    return out.slice(0, 12);
  }, [lc, index]);

  useEffect(() => { setActive(0); }, [lc]);
  useEffect(() => {
    if (!open) return;
    const h = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);

  const go = (r) => { if (!r) return; onNavigate && onNavigate(r.route); setOpen(false); };
  const onKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive(a => Math.min(a + 1, results.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter') {
      if (results.length) go(results[active]);
      else if (onSearchEnter) onSearchEnter(value);
    } else if (e.key === 'Escape') { setOpen(false); }
  };

  // group results for display while keeping a flat active index
  let flat = -1;
  const groups = SEARCH_TYPE_ORDER.map(tp => ({ tp, items: results.filter(r => r.type === tp) })).filter(g => g.items.length);

  return (
    <div className="gsearch" ref={wrapRef}>
      <div className="search">
        <Icon name="search" size={17} />
        <input placeholder={t.search} value={value || ''}
          onChange={(e) => { onChange && onChange(e.target.value); setOpen(true); }}
          onFocus={() => { if (lc) setOpen(true); }}
          onKeyDown={onKey} />
        {value ? <button className="search-clear" onClick={() => { onChange && onChange(''); setOpen(false); }} aria-label="clear"><Icon name="x" size={14} /></button> : <kbd>↵</kbd>}
      </div>
      {open && lc && (
        <div className="gsearch-panel">
          {results.length === 0 ? (
            <div className="gs-empty">{t.searchNothing}</div>
          ) : groups.map(g => (
            <div key={g.tp} className="gs-group">
              <div className="gs-group-label">{typeLabel[g.tp]}</div>
              {g.items.map(r => {
                flat += 1; const i = flat;
                return (
                  <button key={i} className={'gs-item' + (active === i ? ' active' : '')}
                    onMouseEnter={() => setActive(i)} onMouseDown={(e) => { e.preventDefault(); go(r); }}>
                    <span className="gs-ic"><Icon name={SEARCH_TYPE_ICON[g.tp]} size={15} /></span>
                    <span className="gs-text">
                      <span className="gs-label">{r.label}</span>
                      <span className="gs-sub">{r.sub}</span>
                    </span>
                    {r.risk ? riskDot(r.risk) : null}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---- TopBar ---- */
export function TopBar({ title, crumb, t, lang, setLang, theme, setTheme, right, query, setQuery, onSearchEnter, setRoute, notifItems = [], onNotifClick, onMarkAllRead }) {
  const [notifOpen, setNotifOpen] = useState(false);
  const wrapRef = useRef(null);
  const unread = notifItems.filter(n => !n.read).length;
  useEffect(() => {
    if (!notifOpen) return;
    const h = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setNotifOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [notifOpen]);
  return (
    <header className="topbar">
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexShrink: 0 }}>
        {crumb ? <span className="page-crumb">{crumb} <span style={{ opacity: 0.5 }}>/</span> </span> : null}
        <span className="page-title">{title}</span>
      </div>

      <GlobalSearch t={t} value={query} onChange={setQuery} onNavigate={setRoute} onSearchEnter={onSearchEnter} />

      {right}

      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
        <div className="seg" role="tablist" aria-label="language">
          <button className={lang === 'uk' ? 'on' : ''} onClick={() => setLang('uk')}>UA</button>
          <button className={lang === 'en' ? 'on' : ''} onClick={() => setLang('en')}>EN</button>
        </div>
        <button className="icon-btn" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label="theme">
          <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={18} />
        </button>
        <div ref={wrapRef} style={{ position: 'relative' }}>
          <button className="icon-btn" aria-label="notifications" style={{ position: 'relative' }} onClick={() => setNotifOpen(o => !o)}>
            <Icon name="bell" size={18} />
            {unread > 0 && <span className="notif-count">{unread}</span>}
          </button>
          {notifOpen && (
            <div className="menu menu-notif">
              <div className="notif-head">
                <span>{t.notifTitle}{unread > 0 ? ' · ' + unread + ' ' + t.notifNew : ''}</span>
                {unread > 0 ? <button className="notif-markall" onClick={() => onMarkAllRead && onMarkAllRead()}>{t.notifMarkAll}</button> : null}
              </div>
              {notifItems.length === 0 ? (
                <div className="menu-empty">{t.notifEmpty}</div>
              ) : notifItems.map((n, i) => (
                <button key={n.id || i} className={'notif-item' + (n.read ? ' read' : '')} onClick={() => { setNotifOpen(false); onNotifClick && onNotifClick(n); }}>
                  <span className="notif-ic" style={{ color: { high: 'var(--risk-high)', med: 'var(--risk-med)', low: 'var(--accent)' }[n.risk] || 'var(--accent)' }}><Icon name={n.icon || 'bell'} size={16} /></span>
                  <span style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                    <span className="notif-title">{n.title}</span>
                    <span className="notif-sub">{n.sub}{n.dateLabel ? ' · ' + n.dateLabel : ''}</span>
                  </span>
                  {!n.read ? <span className="notif-unread" /> : null}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

/* ---- Toaster (global) ---- */
export function Toaster() {
  const [items, setItems] = useState([]);
  useEffect(() => {
    const onToast = (e) => {
      const id = Math.random().toString(36).slice(2);
      setItems(s => [...s, { id, msg: e.detail.msg, icon: e.detail.icon }]);
      setTimeout(() => setItems(s => s.filter(i => i.id !== id)), 2800);
    };
    window.addEventListener('lx-toast', onToast);
    return () => window.removeEventListener('lx-toast', onToast);
  }, []);
  return (
    <div className="toaster">
      {items.map(i => (
        <div key={i.id} className="toast">
          <Icon name={i.icon || 'checkCircle'} size={17} style={{ color: 'var(--accent)' }} />
          <span>{i.msg}</span>
        </div>
      ))}
    </div>
  );
}
export const toast = (msg, icon) => window.dispatchEvent(new CustomEvent('lx-toast', { detail: { msg, icon } }));

/* ---- Modal ---- */
export function Modal({ open, onClose, title, sub, icon, children, footer, wide }) {
  useEffect(() => {
    if (!open) return;
    const h = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className={'modal' + (wide ? ' modal-wide' : '')} onMouseDown={e => e.stopPropagation()}>
        <div className="modal-head">
          <div style={{ display: 'flex', alignItems: 'center', gap: 11, minWidth: 0 }}>
            {icon ? <span className="modal-ic"><Icon name={icon} size={18} /></span> : null}
            <div style={{ minWidth: 0 }}>
              <div className="modal-title">{title}</div>
              {sub ? <div className="modal-sub">{sub}</div> : null}
            </div>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="close"><Icon name="x" size={18} /></button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>
  );
}

/* ---- Empty / small helpers ---- */
export function SectionTitle({ children, action }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--s4)' }}>
      <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, letterSpacing: '-0.01em' }}>{children}</h2>
      {action}
    </div>
  );
}
