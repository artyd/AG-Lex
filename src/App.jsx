/* ============================================================
   AG Lex — App root: routing, theme, language, tweaks
   ============================================================ */
import { useState, useEffect, useRef } from 'react';
import { Icon } from './ui/Icon';
import { Badge, Sidebar, TopBar, Modal, Toaster, toast } from './ui/components';
import { TweaksPanel, TweakSection, TweakColor, TweakSelect, TweakRadio, TweakToggle, useTweaks } from './ui/tweaks-panel';
import { HelpTip, seedTrainingMode } from './ui/HelpTip';
import { roleLabel } from './lib/labels';
import { lxLoadSession, lxLogout, initialsOf, hueOf, AUTH_LOGOUT_EVENT, refreshSession } from './lib/auth';
import { api, ApiError } from './lib/api';
import { connect as realtimeConnect, disconnect as realtimeDisconnect, subscribe as realtimeSubscribe } from './lib/realtime';
import { DEMO } from './data/demo';
import { LX } from './data/lx';
import { I18N } from './data/i18n';
import { Auth } from './screens/Auth';
import { Dashboard, Library, Clients, Templates } from './screens/Views';
import { ContractAnalysis } from './screens/ContractAnalysis';
import { DocBuilder } from './screens/DocBuilder';
import { Copilot } from './screens/Copilot';
import { LawyerChat } from './screens/LawyerChat';
import { Litigation } from './screens/Litigation';
import { ConflictCheck } from './screens/ConflictCheck';
import { ClientPortal } from './screens/ClientPortal';
import { ESign } from './screens/ESign';
import { Matters } from './screens/Practice';
import { CalendarTasks } from './screens/practice/CalendarTasks/CalendarTasks';
import { ClauseLib, LegalSearch, Counterparty, Team, Batch } from './screens/Knowledge';

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "accent": "#cf2230",
  "font": "'Onest', system-ui, sans-serif",
  "density": "comfy",
  "dark": false,
  "training": false
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
  dashboard: 'dashboard', analyze: 'analyze',
  builder: 'builderTitle', copilot: 'copilotTitle', library: 'libTitle', batch: 'batchTitle',
  matters: 'mattersTitle', calendar: 'calendarTitle',
  litigation: 'litTitle',
  clauses: 'clauseLibTitle', legal: 'legalTitle', counterparty: 'cpTitle',
  clients: 'clientsTitle', templates: 'templatesTitle', team: 'teamTitle',
  esign: 'esignTitle', conflict: 'conflictTitle', portal: 'portalTitle',
  lawyer: 'lawTitle',
};

const DEPRECATED_ROUTES = new Set(['tasks', 'billing', 'review']);

export default function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const [route, setRoute] = useState(() => {
    const stored = localStorage.getItem('lx_route');
    if (!stored || DEPRECATED_ROUTES.has(stored)) return 'dashboard';
    return stored;
  });
  const [lang, setLang] = useState(() => {
    const s = localStorage.getItem('lx_lang');
    return (s === 'uk' || s === 'en') ? s : 'uk';
  });
  const [query, setQuery] = useState('');
  const [uploadOpen, setUploadOpen] = useState(false);
  const [contractUploadOpen, setContractUploadOpen] = useState(false);
  const [contractFile, setContractFile] = useState(null);
  const [contractUploading, setContractUploading] = useState(false);
  const contractFileRef = useRef(null);
  // Pair upload (contract + handover) — modal entry point that mirrors the
  // single-contract modal but with two square slots and one CTA.
  const [pairUploadOpen, setPairUploadOpen] = useState(false);
  const [pairContractFile, setPairContractFile] = useState(null);
  const [pairHandoverFile, setPairHandoverFile] = useState(null);
  const [pairUploading, setPairUploading] = useState(false);
  const pairContractRef = useRef(null);
  const pairHandoverRef = useRef(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [deskOpen, setDeskOpen] = useState(false);
  const [analyzeNonce, setAnalyzeNonce] = useState(0);
  // Real upload payload handed to ContractAnalysis: null = demo mode.
  // Shape for single-contract: { markdown, sections, filename, tokenStats } (from /api/upload).
  // Shape for reconcile (pair upload): { reconcileRun: <run>|null, pending?: bool, filename?: string }
  // — ContractAnalysis branches on the presence of `reconcileRun` to render
  // <ReconcileResult> instead of the single-contract analyze flow.
  const [analysisIncoming, setAnalysisIncoming] = useState(null);
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
  // Session-clear handler: api.js calls lxSessionExpired() on any 401, which
  // dispatches AUTH_LOGOUT_EVENT. Without this listener the React `user` state
  // stays sticky after the token expires and every retry surfaces the raw
  // "Missing bearer token" backend message instead of returning to /auth.
  useEffect(() => {
    const onLogout = () => {
      setUser(null);
      setAnalysisIncoming(null);
      setSettingsOpen(false);
      setUploadOpen(false);
      setContractUploadOpen(false);
      setPairUploadOpen(false);
      toast(L.sessionExpired || 'Сесія завершилась — увійдіть знову.', 'alert');
    };
    window.addEventListener(AUTH_LOGOUT_EVENT, onLogout);
    return () => window.removeEventListener(AUTH_LOGOUT_EVENT, onLogout);
  }, [L]);
  // Rolling JWT refresh: on every app open, ask the backend for a fresh token
  // for the current user. The new token comes with a full 1-year TTL, so any
  // user who opens the app at least once a year never sees a re-login screen.
  // Failures are silent — the cached token still works until it actually expires.
  useEffect(() => {
    if (!user) return;
    refreshSession().then((u) => {
      if (u) setUser(u);
    }).catch(() => { /* network noise — keep the cached session */ });
    // Intentionally only on mount: re-running on every `user` change would
    // spam /api/auth/refresh after every login.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // PR-3: keep HelpTip's local cache in sync with the training tweak.
  // useTweaks' setTweak already dispatches a 'tweakchange' event, but on
  // initial mount the cache is false-defaulted; seed it here so a refresh
  // doesn't lose the user's previous choice.
  useEffect(() => { seedTrainingMode(!!t.training); }, [t.training]);
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
  // Real path: POST the file to /api/upload, get back {markdown, sections,
  // token_stats}, hand them to ContractAnalysis via the `incoming` prop. The
  // demo path (opts.demo) bypasses upload entirely and lets ContractAnalysis
  // fall back to DEMO so the screen stays useful without a backend.
  const startUpload = async (opts = {}) => {
    const isDemo = Boolean(opts.demo) || !contractFile;
    if (isDemo) {
      setContractUploadOpen(false);
      setUploadOpen(false);
      setContractFile(null);
      setAnalysisIncoming(null);
      setAnalyzeNonce(n => n + 1);
      setRoute('analyze');
      toast(L.uploadDone, 'sparkle');
      return;
    }
    // Close the modal and jump to the analyze route IMMEDIATELY so the
    // AnalyzingOverlay paints right after the click — soffice + Claude take
    // 5–15 s and the user shouldn't stare at a frozen modal. The pending
    // marker keeps ContractAnalysis on the overlay until real data arrives.
    const file = contractFile;
    const filename = file.name;
    setContractUploadOpen(false);
    setUploadOpen(false);
    setContractFile(null);
    setAnalysisIncoming({ pending: true, filename });
    setAnalyzeNonce(n => n + 1);
    setRoute('analyze');
    try {
      setContractUploading(true);
      const res = await api.upload(file);
      setAnalysisIncoming({
        markdown: res.markdown,
        sections: res.sections,
        filename: res.filename || filename,
        tokenStats: res.token_stats,
        // Phase 4.x: base64 → kept as string for the back-half
        // (POST /api/contracts uses it as-is). PdfViewer decodes via atob.
        displayPdfB64: res.display_pdf_b64 || null,
        // When soffice failed, the backend returns the {kind, message} here
        // so the FE can forward it to POST /api/contracts and the saved
        // contract row carries the failure reason. Without this the row
        // would lose the "why" the moment we leave the upload response.
        displayPdfError: res.display_pdf_error || null,
      });
      toast(L.uploadDone, 'sparkle');
    } catch (err) {
      // 401 from /api/upload routes through lxSessionExpired() → AUTH_LOGOUT_EVENT,
      // which shows the "session expired" toast and routes back to /auth. The raw
      // "Missing bearer token" string would just confuse the user, so skip it here.
      if (!(err instanceof ApiError && err.status === 401)) {
        toast((L.uploadError || 'Upload failed') + ': ' + (err?.message || ''), 'alert');
      }
      setAnalysisIncoming(null);
      setRoute('dashboard');
    } finally {
      setContractUploading(false);
    }
  };
  const onContractFileChange = (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) setContractFile(f);
    e.target.value = '';
  };
  const startReconcile = () => {
    // Direct-nav entry point (e.g. a sidebar shortcut). With the dedicated
    // /reconcile screen gone, the only way to start a pair flow is the
    // pair-upload modal — route there instead.
    setUploadOpen(false);
    setPairContractFile(null);
    setPairHandoverFile(null);
    setPairUploadOpen(true);
  };
  const openPairUpload = () => {
    setUploadOpen(false);
    setPairContractFile(null);
    setPairHandoverFile(null);
    setPairUploadOpen(true);
  };
  const onPairContractChange = (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) setPairContractFile(f);
    e.target.value = '';
  };
  const onPairHandoverChange = (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) setPairHandoverFile(f);
    e.target.value = '';
  };
  // Real pair flow: POST both files to /api/reconcile, hand the finished
  // run to ContractAnalysis via analysisIncoming = { reconcileRun, pending }
  // — the screen branches to <ReconcileResult> on the `reconcileRun` key.
  // The pair-upload modal lives on the dashboard hub; navigation lands on
  // the unified /analyze route (no separate /reconcile screen).
  const submitPairUpload = async () => {
    if (!pairContractFile || !pairHandoverFile || pairUploading) return;
    // Close the modal first and show the analyzing animation while we wait
    // on the network. ReconcileResult reads `pending` and stays on the
    // overlay until the real run shows up.
    const fd = new FormData();
    fd.append('contract_file', pairContractFile);
    fd.append('handover_file', pairHandoverFile);
    setPairUploadOpen(false);
    setPairContractFile(null);
    setPairHandoverFile(null);
    setAnalysisIncoming({ reconcileRun: null, pending: true });
    setAnalyzeNonce(n => n + 1);
    setRoute('analyze');
    try {
      setPairUploading(true);
      const run = await api.reconcile(fd);
      setAnalysisIncoming({ reconcileRun: run });
      toast(L.uploadDone, 'sparkle');
    } catch (err) {
      // Mirror startUpload: 401 already surfaces via the session-expired toast.
      if (!(err instanceof ApiError && err.status === 401)) {
        toast((L.uploadError || 'Upload failed') + ': ' + (err?.message || ''), 'alert');
      }
      setAnalysisIncoming(null);
      setRoute('dashboard');
    } finally {
      setPairUploading(false);
    }
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
  else if (route === 'analyze') body = <ContractAnalysis t={L} key={'an' + analyzeNonce} incoming={analysisIncoming} />;
  else if (route === 'builder') body = <DocBuilder t={L} setRoute={setRoute} user={user} />;
  else if (route === 'copilot') body = <Copilot t={L} setRoute={setRoute} />;
  else if (route === 'lawyer') body = <LawyerChat t={L} setRoute={setRoute} lang={lang} />;
  else if (route === 'library') body = <Library t={L} setRoute={setRoute} query={query}
    clearAnalysisIncoming={() => { setAnalysisIncoming(null); setAnalyzeNonce(n => n + 1); }} />;
  else if (route === 'batch') body = <Batch t={L} setRoute={setRoute} />;
  else if (route === 'matters') body = <Matters t={L} setRoute={setRoute} />;
  else if (route === 'litigation') body = <Litigation t={L} setRoute={setRoute} />;
  else if (route === 'esign') body = <ESign t={L} />;
  else if (route === 'conflict') body = <ConflictCheck t={L} />;
  else if (route === 'portal') body = <ClientPortal t={L} />;
  else if (route === 'clauses') body = <ClauseLib t={L} />;
  else if (route === 'legal') body = <LegalSearch t={L} />;
  else if (route === 'counterparty') body = <Counterparty t={L} />;
  else if (route === 'team') body = <Team t={L} user={user} />;
  else if (route === 'clients') body = <Clients t={L} setRoute={setRoute} />;
  else if (route === 'templates') body = <Templates t={L} />;
  else if (route === 'calendar') body = <CalendarTasks t={L} />;

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
          <HelpTip text={(L.tips && L.tips.hubContract) || ''} placement="bottom">
            <button className="hub-block hub-accent hub-block-lg" onClick={openContractUpload}>
              <span className="hub-ic hub-ic-lg"><Icon name="doc" size={28} /></span>
              <span className="hub-block-t">{L.hubContract}</span>
              <span className="hub-block-s">{L.hubContractSub}</span>
              <span className="hub-open">{L.hubOpen} <Icon name="arrowR" size={14} /></span>
            </button>
          </HelpTip>
          <HelpTip text={(L.tips && L.tips.hubCompare) || ''} placement="bottom">
            <button className="hub-block hub-accent hub-block-lg" onClick={openPairUpload}>
              <span className="hub-new">{L.hubNew}</span>
              <span className="hub-ic hub-ic-lg"><Icon name="scan" size={28} /></span>
              <span className="hub-block-t">{L.hubCompare}</span>
              <span className="hub-block-s">{L.hubCompareSub}</span>
              <span className="hub-open">{L.hubOpen} <Icon name="arrowR" size={14} /></span>
            </button>
          </HelpTip>
        </div>
        <HelpTip text={(L.tips && L.tips.hubBatch) || ''} placement="top">
          <button className="hub-block hub-muted hub-block-row" onClick={startBatch}>
            <span className="hub-ic"><Icon name="sparkle" size={22} fill={true} /></span>
            <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2, textAlign: 'left' }}>
              <span className="hub-block-t" style={{ fontSize: 15 }}>{L.hubBatch}</span>
              <span className="hub-block-s" style={{ flex: '0 0 auto' }}>{L.hubBatchSub}</span>
            </span>
            <Icon name="arrowR" size={16} style={{ color: 'var(--text-3)' }} />
          </button>
        </HelpTip>
      </Modal>

      {/* Contract upload — real file dropzone */}
      <Modal open={contractUploadOpen} onClose={() => setContractUploadOpen(false)} title={L.uploadTitle} sub={L.uploadSub} icon="doc"
        footer={<>
          <button className="btn btn-subtle" onClick={() => setContractUploadOpen(false)} disabled={contractUploading}>{L.cancel}</button>
          <button className="btn btn-primary" onClick={() => startUpload()} disabled={!contractFile || contractUploading}>
            {contractUploading
              ? <><Icon name="refresh" size={15} /> {L.uploading || 'Uploading…'}</>
              : <><Icon name="sparkle" size={15} fill={true} /> {L.uploadAnalyze}</>}
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
          <button className="btn btn-ghost btn-sm" onClick={() => startUpload({ demo: true })} disabled={contractUploading}>{L.uploadDemoBtn}</button>
        </div>
      </Modal>

      {/* Pair upload — contract + handover (two square dropzones, one CTA) */}
      <Modal open={pairUploadOpen} onClose={() => setPairUploadOpen(false)} title={L.cmpUploadTitle} sub={L.cmpUploadSub} icon="scan" wide
        footer={<>
          <button className="btn btn-subtle" onClick={() => setPairUploadOpen(false)} disabled={pairUploading}>{L.cancel}</button>
          <button className="btn btn-primary" onClick={submitPairUpload}
            disabled={!pairContractFile || !pairHandoverFile || pairUploading}>
            {pairUploading
              ? <><Icon name="refresh" size={15} /> {L.uploading || 'Uploading…'}</>
              : <><Icon name="scan" size={15} /> {L.cmpRun}</>}
          </button>
        </>}>
        <input ref={pairContractRef} type="file" accept=".pdf,.docx" style={{ display: 'none' }} onChange={onPairContractChange} />
        <input ref={pairHandoverRef} type="file" accept=".pdf,.docx,.xlsx" style={{ display: 'none' }} onChange={onPairHandoverChange} />
        <div className="pair-slots">
          {[
            { file: pairContractFile, setFile: setPairContractFile, ref: pairContractRef,
              tag: L.cmpSlotContract, accept: 'PDF, DOCX', icon: 'doc', accentIcon: 'doc' },
            { file: pairHandoverFile, setFile: setPairHandoverFile, ref: pairHandoverRef,
              tag: L.cmpSlotHandover, accept: 'PDF, DOCX, XLSX', icon: 'folder', accentIcon: 'folder' },
          ].map((slot, i) => (
            <div key={i} className="pair-slot">
              <div className="pair-slot-tag"><Icon name={slot.accentIcon} size={13} /> {slot.tag}</div>
              {slot.file ? (
                <>
                  <button className="dropzone dropzone-filled pair-drop"
                    onClick={() => slot.ref.current && slot.ref.current.click()}
                    disabled={pairUploading}>
                    <div className="dropzone-ic" style={{ background: 'var(--risk-low-soft)', color: 'var(--risk-low)' }}>
                      <Icon name="check" size={26} stroke={2.5} />
                    </div>
                    <div style={{ fontWeight: 700, fontSize: 14, marginTop: 10, color: 'var(--risk-low)' }}>{L.uploadSelected}</div>
                  </button>
                  <div className="file-chip" style={{ marginTop: 10 }}>
                    <span className="file-chip-ic"><Icon name={slot.icon} size={15} /></span>
                    <span style={{ flex: 1, minWidth: 0, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{slot.file.name}</span>
                    <span style={{ color: 'var(--text-3)', fontSize: 12, fontFeatureSettings: '"tnum"' }}>{(slot.file.size / 1024 / 1024).toFixed(1)} МБ</span>
                    <button className="icon-btn" aria-label={L.uploadRemove} onClick={() => slot.setFile(null)} style={{ width: 26, height: 26 }} disabled={pairUploading}>
                      <Icon name="x" size={13} />
                    </button>
                  </div>
                </>
              ) : (
                <button className="dropzone pair-drop" onClick={() => slot.ref.current && slot.ref.current.click()} disabled={pairUploading}>
                  <div className="dropzone-ic"><Icon name="upload" size={24} /></div>
                  <div style={{ fontWeight: 700, fontSize: 14, marginTop: 10 }}>{L.uploadDrop}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 3 }}>{slot.accept}</div>
                </button>
              )}
            </div>
          ))}
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
        <div className={'training-card' + (t.training ? ' on' : '')}>
          <div className="training-card-glow" aria-hidden="true" />
          <div className="training-card-ic">
            <Icon name="sparkle" size={20} fill={true} />
          </div>
          <div className="training-card-body">
            <div className="training-card-head">
              <span className="training-card-t">{L.training}</span>
              {t.training ? <Badge variant="accent">{L.on}</Badge> : null}
            </div>
            <div className="training-card-s">{L.trainingSub}</div>
            <HelpTip text={L.trainingTipExample || L.trainingSub}>
              <button
                type="button"
                className={'training-card-demo' + (t.training ? '' : ' is-off')}
                disabled={!t.training}
              >
                <Icon name="wand" size={13} />
                {t.training
                  ? (L.trainingDemoOn || 'Наведіть курсор сюди — побачите підказку')
                  : (L.trainingDemoOff || 'Увімкніть, щоб спробувати')}
              </button>
            </HelpTip>
          </div>
          <label className="hl-toggle training-card-toggle">
            <input
              type="checkbox"
              checked={!!t.training}
              onChange={(e) => setTweak('training', e.target.checked)}
              aria-label={L.training}
            />
            <span className="hl-track"><span className="hl-knob" /></span>
          </label>
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
        <TweakToggle label={L.training} value={!!t.training}
          onChange={(v) => setTweak('training', v)} />
      </TweaksPanel>
    </div>
  );
}
