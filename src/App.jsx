/* ============================================================
   AG Lex — App root: routing, theme, language, tweaks
   ============================================================ */
import { useState, useEffect } from 'react';
import { Icon } from './ui/Icon';
import { Sidebar, TopBar, Modal, Toaster, toast } from './ui/components';
import { TweaksPanel, TweakSection, TweakColor, TweakSelect, TweakRadio, useTweaks } from './ui/tweaks-panel';
import { roleLabel } from './lib/labels';
import { lxLoadSession, lxLogout, initialsOf, hueOf } from './lib/auth';
import { DEMO } from './data/demo';
import { LX } from './data/lx';
import { I18N } from './data/i18n';
import { Auth } from './screens/Auth';
import { Dashboard, Library, Clients, Templates, Calendar } from './screens/Views';
import { ContractAnalysis } from './screens/ContractAnalysis';
import { Reconcile } from './screens/Reconcile';
import { DocBuilder } from './screens/DocBuilder';
import { Copilot } from './screens/Copilot';
import { Litigation } from './screens/Litigation';
import { DocReview } from './screens/DocReview';
import { ConflictCheck } from './screens/ConflictCheck';
import { ClientPortal } from './screens/ClientPortal';
import { ESign } from './screens/ESign';
import { Matters, Tasks, Billing } from './screens/Practice';
import { ClauseLib, LegalSearch, Counterparty, Team, Batch } from './screens/Knowledge';

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "accent": "#cf2230",
  "font": "'Onest', system-ui, sans-serif",
  "density": "comfy",
  "dark": false
}/*EDITMODE-END*/;

// Brand palette — red is primary (red / white / black corporate identity);
// the rest are alternative accents available in the picker.
const ACCENT_OPTIONS = ['#cf2230', '#8c1420', '#2b2b2b', '#2f6fe0', '#1f9d62', '#b06b2e'];

// Ukrainian-capable UI fonts
const FONT_OPTIONS = [
  { value: "'Onest', system-ui, sans-serif", label: 'Onest' },
  { value: "'Manrope', system-ui, sans-serif", label: 'Manrope' },
  { value: "'Geologica', system-ui, sans-serif", label: 'Geologica' },
];

const PAGE_TITLES = {
  dashboard: 'dashboard', analyze: 'analyze', reconcile: 'reconcileTitle',
  builder: 'builderTitle', copilot: 'copilotTitle', library: 'libTitle', batch: 'batchTitle',
  matters: 'mattersTitle', tasks: 'tasksTitle', calendar: 'calendarTitle', billing: 'billingTitle',
  litigation: 'litTitle', review: 'reviewTitle',
  clauses: 'clauseLibTitle', legal: 'legalTitle', counterparty: 'cpTitle',
  clients: 'clientsTitle', templates: 'templatesTitle', team: 'teamTitle',
  esign: 'esignTitle', conflict: 'conflictTitle', portal: 'portalTitle',
};

export default function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const [route, setRoute] = useState(() => localStorage.getItem('lx_route') || 'dashboard');
  const [lang, setLang] = useState(() => {
    const s = localStorage.getItem('lx_lang');
    return (s === 'uk' || s === 'en') ? s : 'uk';
  });
  const [query, setQuery] = useState('');
  const [uploadOpen, setUploadOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [analyzeNonce, setAnalyzeNonce] = useState(0);
  const [user, setUser] = useState(() => lxLoadSession());
  const [notifRead, setNotifRead] = useState(() => { try { return JSON.parse(localStorage.getItem('aglex_notif_read') || '[]'); } catch (e) { return []; } });
  const L = I18N[lang];

  const theme = t.dark ? 'dark' : 'light';
  const density = t.density === 'compact' ? 0.84 : 1;

  useEffect(() => {
    const r = document.documentElement;
    r.setAttribute('data-theme', theme);
    r.style.setProperty('--accent', t.accent);
    r.style.setProperty('--font-ui', t.font);
    r.style.setProperty('--density', density);
  }, [theme, t.accent, t.font, density]);

  useEffect(() => { localStorage.setItem('lx_route', route); }, [route]);
  useEffect(() => { localStorage.setItem('lx_lang', lang); }, [lang]);
  useEffect(() => { localStorage.setItem('aglex_notif_read', JSON.stringify(notifRead)); }, [notifRead]);

  const titleKey = PAGE_TITLES[route] || 'dashboard';
  const crumb = route === 'analyze' ? L.library : null;

  // Notifications — multiple sources, with read/unread state
  const readSet = new Set(notifRead);
  const notifBase = [];
  DEMO.tasks.filter(tk => tk.risk !== 'low').slice(0, 4).forEach(tk => {
    const d = new Date(tk.date);
    notifBase.push({ id: 'dl-' + tk.id, icon: 'calendar', risk: tk.risk, title: tk.title, sub: tk.client, route: 'calendar', dateLabel: d.toLocaleDateString(L.locale, { day: '2-digit', month: 'short' }) });
  });
  const apprCur = LX.approval.find(s => s.status === 'current');
  if (apprCur) notifBase.push({ id: 'appr-cur', icon: 'checkCircle', risk: 'med', title: L.notifApproval, sub: apprCur.role, route: 'analyze' });
  LX.comments.filter(c => !c.resolved).slice(0, 2).forEach(c => {
    notifBase.push({ id: 'cm-' + c.id, icon: 'bell', risk: 'low', title: L.notifComment, sub: (L.clauseC || 'п.') + ' ' + c.clause, route: 'analyze' });
  });
  const firstTask = LX.tasks.find(k => k.col !== 'done');
  if (firstTask) notifBase.push({ id: 'tk-' + firstTask.id, icon: 'check', risk: 'low', title: L.notifTask, sub: firstTask.title, route: 'tasks' });
  const notifItems = notifBase.map(n => ({ ...n, read: readSet.has(n.id) }));
  const markAllRead = () => setNotifRead(notifBase.map(n => n.id));
  const onNotifClick = (n) => { setNotifRead(r => r.includes(n.id) ? r : [...r, n.id]); setRoute(n.route); };

  const goSearch = () => { if (query.trim()) setRoute('library'); };
  const logout = () => { lxLogout(); setUser(null); setSettingsOpen(false); setRoute('dashboard'); };
  const startUpload = () => {
    setUploadOpen(false);
    setAnalyzeNonce(n => n + 1);
    setRoute('analyze');
    toast(L.uploadDone, 'sparkle');
  };
  const startReconcile = () => {
    setUploadOpen(false);
    setAnalyzeNonce(n => n + 1);
    setRoute('reconcile');
  };
  const startBatch = () => {
    setUploadOpen(false);
    setRoute('batch');
  };

  let body;
  if (route === 'dashboard') body = <Dashboard t={L} setRoute={setRoute} user={user} />;
  else if (route === 'analyze') body = <ContractAnalysis t={L} key={'an' + analyzeNonce} />;
  else if (route === 'reconcile') body = <Reconcile t={L} key={'rc' + analyzeNonce} setRoute={setRoute} />;
  else if (route === 'builder') body = <DocBuilder t={L} setRoute={setRoute} user={user} />;
  else if (route === 'copilot') body = <Copilot t={L} setRoute={setRoute} />;
  else if (route === 'library') body = <Library t={L} setRoute={setRoute} query={query} />;
  else if (route === 'batch') body = <Batch t={L} setRoute={setRoute} />;
  else if (route === 'matters') body = <Matters t={L} setRoute={setRoute} />;
  else if (route === 'litigation') body = <Litigation t={L} setRoute={setRoute} />;
  else if (route === 'review') body = <DocReview t={L} />;
  else if (route === 'esign') body = <ESign t={L} />;
  else if (route === 'conflict') body = <ConflictCheck t={L} />;
  else if (route === 'portal') body = <ClientPortal t={L} />;
  else if (route === 'tasks') body = <Tasks t={L} />;
  else if (route === 'billing') body = <Billing t={L} />;
  else if (route === 'clauses') body = <ClauseLib t={L} />;
  else if (route === 'legal') body = <LegalSearch t={L} />;
  else if (route === 'counterparty') body = <Counterparty t={L} />;
  else if (route === 'team') body = <Team t={L} user={user} />;
  else if (route === 'clients') body = <Clients t={L} setRoute={setRoute} />;
  else if (route === 'templates') body = <Templates t={L} />;
  else if (route === 'calendar') body = <Calendar t={L} />;

  if (!user) {
    return (
      <>
        <Auth t={L} lang={lang} setLang={setLang} theme={theme}
          setTheme={(th) => setTweak('dark', th === 'dark')}
          onAuth={(u) => { setUser(u); setRoute('dashboard'); }} />
        <Toaster />
      </>
    );
  }

  return (
    <div className="app">
      <Sidebar route={route} setRoute={setRoute} t={L} riskCount={10} user={user}
        onUpload={() => setUploadOpen(true)} onSettings={() => setSettingsOpen(true)} />
      <div className="main">
        <TopBar title={L[titleKey]} crumb={crumb} t={L}
          lang={lang} setLang={setLang}
          theme={theme} setTheme={(th) => setTweak('dark', th === 'dark')}
          query={query} setQuery={setQuery} onSearchEnter={goSearch} setRoute={setRoute}
          notifItems={notifItems} onNotifClick={onNotifClick} onMarkAllRead={markAllRead} />
        {body}
      </div>

      <Toaster />

      {/* Launcher modal — analysis hub. Three hub-block cards. */}
      <Modal open={uploadOpen} onClose={() => setUploadOpen(false)} title={L.hubTitle} sub={L.hubSub} icon="sparkle" wide>
        <div className="hub-grid">
          <button className="hub-block hub-accent" onClick={startUpload}>
            <span className="hub-ic"><Icon name="doc" size={24} /></span>
            <span className="hub-block-t">{L.hubContract}</span>
            <span className="hub-block-s">{L.hubContractSub}</span>
            <span className="hub-open">{L.hubOpen} <Icon name="arrowR" size={14} /></span>
          </button>
          <button className="hub-block hub-accent" onClick={startReconcile}>
            <span className="hub-new">{L.hubNew}</span>
            <span className="hub-ic"><Icon name="scan" size={24} /></span>
            <span className="hub-block-t">{L.hubCompare}</span>
            <span className="hub-block-s">{L.hubCompareSub}</span>
            <span className="hub-open">{L.hubOpen} <Icon name="arrowR" size={14} /></span>
          </button>
          <button className="hub-block hub-muted" onClick={startBatch}>
            <span className="hub-ic"><Icon name="sparkle" size={24} fill={true} /></span>
            <span className="hub-block-t">{L.hubBatch}</span>
            <span className="hub-block-s">{L.hubBatchSub}</span>
            <span className="hub-open">{L.hubOpen} <Icon name="arrowR" size={14} /></span>
          </button>
        </div>
      </Modal>

      {/* Settings modal */}
      <Modal open={settingsOpen} onClose={() => setSettingsOpen(false)} title={L.settings} icon="settings">
        <div className="set-profile">
          <span className="ua" style={{ width: 46, height: 46, fontSize: 17, background: `oklch(0.58 0.14 ${hueOf(user.email)})` }}>{initialsOf(user.name)}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 16 }}>{user.name}</div>
            <div style={{ fontSize: 12.5, color: 'var(--text-3)' }}>{user.email} · {roleLabel(L, user.role)}</div>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={logout}><Icon name="upload" size={15} style={{ transform: 'rotate(90deg)' }} /> {L.logout}</button>
        </div>
        <hr className="divider" />
        <div className="set-row">
          <div><div className="set-label">{L.theme}</div></div>
          <div className="seg seg-sm">
            <button className={theme === 'light' ? 'on' : ''} onClick={() => setTweak('dark', false)}>{L.light}</button>
            <button className={theme === 'dark' ? 'on' : ''} onClick={() => setTweak('dark', true)}>{L.dark}</button>
          </div>
        </div>
        <div className="set-row">
          <div><div className="set-label">{L.languageLabel}</div></div>
          <div className="seg seg-sm">
            <button className={lang === 'uk' ? 'on' : ''} onClick={() => setLang('uk')}>Українська</button>
            <button className={lang === 'en' ? 'on' : ''} onClick={() => setLang('en')}>English</button>
          </div>
        </div>
        <div className="set-row">
          <div><div className="set-label">{L.density}</div></div>
          <div className="seg seg-sm">
            <button className={t.density === 'comfy' ? 'on' : ''} onClick={() => setTweak('density', 'comfy')}>{L.comfy}</button>
            <button className={t.density === 'compact' ? 'on' : ''} onClick={() => setTweak('density', 'compact')}>{L.compact}</button>
          </div>
        </div>
        <div className="set-row" style={{ border: 'none' }}>
          <div><div className="set-label">{L.accent}</div></div>
          <div style={{ display: 'flex', gap: 8 }}>
            {ACCENT_OPTIONS.map(c => (
              <button key={c} className={'set-swatch' + (t.accent === c ? ' on' : '')} style={{ background: c }} onClick={() => setTweak('accent', c)} aria-label={c} />
            ))}
          </div>
        </div>
      </Modal>

      <TweaksPanel>
        <TweakSection label={L.tweaksTitle} />
        <TweakColor label={L.accent} value={t.accent}
          options={ACCENT_OPTIONS}
          onChange={(v) => setTweak('accent', v)} />
        <TweakSelect label={L.font} value={t.font}
          options={FONT_OPTIONS}
          onChange={(v) => setTweak('font', v)} />
        <TweakRadio label={L.theme} value={theme}
          options={[{ value: 'light', label: L.light }, { value: 'dark', label: L.dark }]}
          onChange={(v) => setTweak('dark', v === 'dark')} />
        <TweakRadio label={L.density} value={t.density}
          options={[{ value: 'comfy', label: L.comfy }, { value: 'compact', label: L.compact }]}
          onChange={(v) => setTweak('density', v)} />
      </TweaksPanel>
    </div>
  );
}
