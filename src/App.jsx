/* ============================================================
   AG Lex — App root: routing, theme, language, tweaks
   ============================================================ */
import { useState, useEffect, useRef } from 'react';
import { Icon } from './ui/Icon';
import { Sidebar, TopBar, Modal, Toaster, toast } from './ui/components';
import { TweaksPanel, TweakSection, TweakColor, TweakSelect, TweakRadio, useTweaks } from './ui/tweaks-panel';
import { roleLabel } from './lib/labels';
import { lxLoadSession, lxLogout, initialsOf, hueOf } from './lib/auth';
import { api } from './lib/api';
import { connect as realtimeConnect, disconnect as realtimeDisconnect, subscribe as realtimeSubscribe } from './lib/realtime';
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
  const [contractUploadOpen, setContractUploadOpen] = useState(false);
  const [contractFile, setContractFile] = useState(null);
  const contractFileRef = useRef(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [deskOpen, setDeskOpen] = useState(false);
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

  // Phase 2.4 — server-driven notifications. Loaded once on login, then
  // appended to via `notification.new` realtime events. Marked read on
  // click (single) or via "mark all read" (bulk).
  const [serverNotifs, setServerNotifs] = useState([]);
  useEffect(() => {
    if (!user) { setServerNotifs([]); return; }
    let cancelled = false;
    api.notifications.list({ limit: 50 })
      .then(rows => { if (!cancelled) setServerNotifs(Array.isArray(rows) ? rows : []); })
      .catch(() => { /* keep empty fallback */ });
    return () => { cancelled = true; };
  }, [user]);

  // Realtime connection + subscribers. Connect on login, drop on logout,
  // and on every reconnect refetch notifications to close the gap.
  useEffect(() => {
    if (!user) return;
    realtimeConnect();
    const unsubNew = realtimeSubscribe('notification.new', (ev) => {
      const data = ev.data || {};
      const row = {
        id: data.id || ev.case_id + ':' + Date.now(),
        user_id: data.user_id,
        case_id: data.case_id || ev.case_id,
        type: data.type || 'case.updated',
        message: data.message,
        payload: data.payload,
        is_read: false,
        created_at: data.created_at || ev.ts,
      };
      setServerNotifs(s => [row, ...s.filter(n => n.id !== row.id)].slice(0, 50));
    });
    const unsubReconnect = realtimeSubscribe('realtime:reconnected', () => {
      api.notifications.list({ limit: 50 })
        .then(rows => setServerNotifs(Array.isArray(rows) ? rows : []))
        .catch(() => {});
    });
    return () => { unsubNew(); unsubReconnect(); realtimeDisconnect(); };
  }, [user]);

  // Translate server rows into the shape TopBar's bell expects.
  const notifItems = serverNotifs.map(n => {
    const icon = (n.type || '').startsWith('member.') ? 'clients'
      : (n.type || '').startsWith('case.') ? 'folder'
      : (n.type || '').startsWith('note.') ? 'pen'
      : (n.type || '').startsWith('hearing.') ? 'scales'
      : 'bell';
    return {
      id: n.id,
      icon,
      risk: 'low',
      title: n.message || L.notifTask,
      sub: n.case_id ? '#' + n.case_id : '',
      route: n.case_id ? 'matters' : 'dashboard',
      read: Boolean(n.is_read),
      caseId: n.case_id,
    };
  });
  const markAllRead = () => {
    setServerNotifs(s => s.map(n => ({ ...n, is_read: true })));
    api.notifications.markAllRead().catch(() => {});
  };
  const onNotifClick = (n) => {
    setServerNotifs(s => s.map(it => it.id === n.id ? { ...it, is_read: true } : it));
    api.notifications.markRead(n.id).catch(() => {});
    if (n.caseId) {
      try { localStorage.setItem('aglex_matter_open', n.caseId); } catch (_e) {}
    }
    if (n.route) setRoute(n.route);
  };

  const goSearch = () => { if (query.trim()) setRoute('library'); };
  const logout = () => { lxLogout(); setUser(null); setSettingsOpen(false); setRoute('dashboard'); };
  const openContractUpload = () => {
    setUploadOpen(false);
    setContractFile(null);
    setContractUploadOpen(true);
  };
  const startUpload = () => {
    setContractUploadOpen(false);
    setUploadOpen(false);
    setContractFile(null);
    setAnalyzeNonce(n => n + 1);
    setRoute('analyze');
    toast(L.uploadDone, 'sparkle');
  };
  const onContractFileChange = (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) setContractFile(f);
    e.target.value = '';
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
  const startDeskDownload = (plat) => {
    const files = { win: 'AG-Lex-Setup.exe', mac: 'AG-Lex.dmg', linux: 'AG-Lex.AppImage' };
    const filename = files[plat] || 'AG-Lex-Setup.exe';
    const blob = new Blob(['AG-Lex desktop installer — demo placeholder.\n'], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    setDeskOpen(false);
    toast(L.deskStarted + ' · ' + filename, 'download');
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
        <div className="hub-grid hub-grid-2">
          <button className="hub-block hub-accent hub-block-lg" onClick={openContractUpload}>
            <span className="hub-ic hub-ic-lg"><Icon name="doc" size={28} /></span>
            <span className="hub-block-t">{L.hubContract}</span>
            <span className="hub-block-s">{L.hubContractSub}</span>
            <span className="hub-open">{L.hubOpen} <Icon name="arrowR" size={14} /></span>
          </button>
          <button className="hub-block hub-accent hub-block-lg" onClick={startReconcile}>
            <span className="hub-new">{L.hubNew}</span>
            <span className="hub-ic hub-ic-lg"><Icon name="scan" size={28} /></span>
            <span className="hub-block-t">{L.hubCompare}</span>
            <span className="hub-block-s">{L.hubCompareSub}</span>
            <span className="hub-open">{L.hubOpen} <Icon name="arrowR" size={14} /></span>
          </button>
        </div>
        <button className="hub-block hub-muted hub-block-row" onClick={startBatch}>
          <span className="hub-ic"><Icon name="sparkle" size={22} fill={true} /></span>
          <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2, textAlign: 'left' }}>
            <span className="hub-block-t" style={{ fontSize: 15 }}>{L.hubBatch}</span>
            <span className="hub-block-s" style={{ flex: '0 0 auto' }}>{L.hubBatchSub}</span>
          </span>
          <Icon name="arrowR" size={16} style={{ color: 'var(--text-3)' }} />
        </button>
      </Modal>

      {/* Contract upload — real file dropzone */}
      <Modal open={contractUploadOpen} onClose={() => setContractUploadOpen(false)} title={L.uploadTitle} sub={L.uploadSub} icon="doc"
        footer={<>
          <button className="btn btn-subtle" onClick={() => setContractUploadOpen(false)}>{L.cancel}</button>
          <button className="btn btn-primary" onClick={startUpload} disabled={!contractFile}>
            <Icon name="sparkle" size={15} fill={true} /> {L.uploadAnalyze}
          </button>
        </>}>
        <input ref={contractFileRef} type="file" accept=".pdf,.docx,.doc" style={{ display: 'none' }} onChange={onContractFileChange} />
        {contractFile ? (
          <>
            <button className="dropzone dropzone-filled" onClick={() => contractFileRef.current && contractFileRef.current.click()}>
              <div className="dropzone-ic" style={{ background: 'var(--risk-low-soft)', color: 'var(--risk-low)' }}><Icon name="check" size={28} stroke={2.5} /></div>
              <div style={{ fontWeight: 700, fontSize: 15.5, marginTop: 12, color: 'var(--risk-low)' }}>{L.uploadSelected}</div>
              <div style={{ fontSize: 13, color: 'var(--text-3)', marginTop: 4 }}>{L.uploadHint}</div>
            </button>
            <div className="file-chip" style={{ marginTop: 12 }}>
              <span className="file-chip-ic"><Icon name="doc" size={16} /></span>
              <span style={{ flex: 1, minWidth: 0, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{contractFile.name}</span>
              <span style={{ color: 'var(--text-3)', fontSize: 12, fontFeatureSettings: '"tnum"' }}>{(contractFile.size / 1024 / 1024).toFixed(1)} МБ</span>
              <button className="icon-btn" aria-label={L.uploadRemove} onClick={() => setContractFile(null)} style={{ width: 28, height: 28 }}>
                <Icon name="x" size={14} />
              </button>
            </div>
          </>
        ) : (
          <button className="dropzone dropzone-lg" onClick={() => contractFileRef.current && contractFileRef.current.click()}>
            <div className="dropzone-ic"><Icon name="upload" size={28} /></div>
            <div style={{ fontWeight: 700, fontSize: 15.5, marginTop: 12 }}>{L.uploadDrop}</div>
            <div style={{ fontSize: 13, color: 'var(--text-3)', marginTop: 4 }}>{L.uploadHint}</div>
          </button>
        )}
        <div className="upload-demo">
          <span className="upload-demo-ic"><Icon name="sparkle" size={14} fill={true} /></span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12.5, fontWeight: 600 }}>{L.uploadDemoLabel}</div>
            <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 1 }}>{L.uploadDemoSub}</div>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={startUpload}>{L.uploadDemoBtn}</button>
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
        <div className="set-row">
          <div><div className="set-label">{L.accent}</div></div>
          <div style={{ display: 'flex', gap: 8 }}>
            {ACCENT_OPTIONS.map(c => (
              <button key={c} className={'set-swatch' + (t.accent === c ? ' on' : '')} style={{ background: c }} onClick={() => setTweak('accent', c)} aria-label={c} />
            ))}
          </div>
        </div>
        <hr className="divider" />
        <button className="desk-hero" onClick={() => { setSettingsOpen(false); setDeskOpen(true); }}>
          <span className="desk-hero-glow" aria-hidden="true" />
          <span className="desk-hero-ic"><Icon name="download" size={22} /></span>
          <span className="desk-hero-body">
            <span className="desk-hero-t">{L.deskTitle}</span>
            <span className="desk-hero-s">{L.deskSub}</span>
          </span>
          <span className="desk-hero-plats" aria-hidden="true">
            <Icon name="windows" size={13} />
            <Icon name="apple" size={13} />
            <Icon name="linux" size={13} />
          </span>
          <Icon name="chevR" size={16} className="desk-hero-chev" />
        </button>
      </Modal>

      {/* Desktop app modal — one-click OS picker */}
      <Modal open={deskOpen} onClose={() => setDeskOpen(false)} title={L.deskTitle} sub={L.deskChoose} icon="download">
        <div className="os-grid">
          <button className="os-card" onClick={() => startDeskDownload('win')}>
            <span className="os-card-ic"><Icon name="windows" size={26} /></span>
            <span className="os-card-body">
              <span className="os-card-name">{L.deskWin}</span>
              <span className="os-card-file">{L.deskWinFile}</span>
            </span>
            <span className="os-card-go"><Icon name="download" size={16} /></span>
          </button>
          <button className="os-card" onClick={() => startDeskDownload('mac')}>
            <span className="os-card-ic"><Icon name="apple" size={26} /></span>
            <span className="os-card-body">
              <span className="os-card-name">{L.deskMac}</span>
              <span className="os-card-file">{L.deskMacFile}</span>
            </span>
            <span className="os-card-go"><Icon name="download" size={16} /></span>
          </button>
          <button className="os-card" onClick={() => startDeskDownload('linux')}>
            <span className="os-card-ic"><Icon name="linux" size={26} /></span>
            <span className="os-card-body">
              <span className="os-card-name">{L.deskLinux}</span>
              <span className="os-card-file">{L.deskLinuxFile}</span>
            </span>
            <span className="os-card-go"><Icon name="download" size={16} /></span>
          </button>
        </div>
        <div className="desk-note">
          <Icon name="alert" size={14} />
          <span>{L.deskNote}</span>
        </div>
        <div className="desk-ver">{L.deskVersion}</div>
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
