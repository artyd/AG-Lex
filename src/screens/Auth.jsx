/* ============================================================
   AG Lex — Auth screen (sign up / sign in / one-click test).
   Phase 2.1: backed by /api/auth/* via src/lib/auth.js.
   ============================================================ */
import { useState } from 'react';
import { Icon } from '../ui/Icon';
import { apiLogin, apiLoginTest, apiRegister, LX_TEST } from '../lib/auth';

export function Auth({ t, lang, setLang, theme, setTheme, onAuth }) {
  const [mode, setMode] = useState('signup');
  const [f, setF] = useState({ name: '', email: '', pass: '', pass2: '', role: 'lawyer' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k, v) => { setF(p => ({ ...p, [k]: v })); setErr(''); };
  const roles = [['partner', t.rolePartner], ['senior', t.roleSenior], ['lawyer', t.roleLawyer], ['paralegal', t.roleParalegal], ['admin', t.roleAdmin]];

  const submit = async () => {
    if (busy) return;
    const email = f.email.trim().toLowerCase();
    if (mode === 'signup') {
      if (!f.name.trim() || !email || !f.pass) return setErr(t.errRequired);
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return setErr(t.errEmail);
      // Backend min length is 8 (bcrypt sanity floor).
      if (f.pass.length < 8) return setErr(t.errPassLen);
      if (f.pass !== f.pass2) return setErr(t.errMismatch);
      setBusy(true);
      try {
        const user = await apiRegister({ name: f.name.trim(), email, password: f.pass, role: f.role });
        onAuth(user);
      } catch (e) {
        // Backend uses 409 with detail "Email already registered."
        if (e.status === 409) setErr(t.errExists);
        else setErr(e.message || t.errCreds);
      } finally {
        setBusy(false);
      }
    } else {
      if (!email || !f.pass) return setErr(t.errRequired);
      setBusy(true);
      try {
        const user = await apiLogin({ email, password: f.pass });
        onAuth(user);
      } catch (e) {
        if (e.status === 401) setErr(t.errCreds);
        else setErr(e.message || t.errCreds);
      } finally {
        setBusy(false);
      }
    }
  };

  const onKey = (e) => { if (e.key === 'Enter') submit(); };

  const useTestAccount = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const user = await apiLoginTest();
      onAuth(user);
    } catch (e) {
      setErr(e.message || t.errCreds);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <aside className="auth-brand">
        <div className="auth-brand-top">
          <div className="brand-mark" style={{ fontSize: 16, letterSpacing: '-0.03em', width: 40, height: 40 }}>AG</div>
          <div>
            <div style={{ fontWeight: 700, fontSize: 20, color: '#fff' }}>AG Lex</div>
            <div style={{ fontSize: 12.5, color: 'rgba(255,255,255,0.6)' }}>Альянс Груп 95</div>
          </div>
        </div>
        <div className="auth-brand-mid">
          <h1>{t.authTagline}</h1>
          <ul className="auth-feats">
            <li><Icon name="sparkle" size={16} fill={true} /> {t.analyze}</li>
            <li><Icon name="scales" size={16} /> {t.legalSearch} · {t.clauseLib}</li>
            <li><Icon name="folder" size={16} /> {t.matters} · {t.mTasks} · {t.billing}</li>
            <li><Icon name="checkCircle" size={16} /> {t.approvalTitle}</li>
          </ul>
        </div>
        <div className="auth-brand-foot">© 2026 Альянс Груп 95</div>
      </aside>

      <main className="auth-main">
        <div className="auth-topbar">
          <div className="seg">
            <button className={lang === 'uk' ? 'on' : ''} onClick={() => setLang('uk')}>UA</button>
            <button className={lang === 'en' ? 'on' : ''} onClick={() => setLang('en')}>EN</button>
          </div>
          <button className="icon-btn" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label="theme">
            <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={18} />
          </button>
        </div>

        <div className="auth-card">
          <div className="auth-tabs">
            <button className={mode === 'signup' ? 'on' : ''} onClick={() => { setMode('signup'); setErr(''); }}>{t.authSignUp}</button>
            <button className={mode === 'signin' ? 'on' : ''} onClick={() => { setMode('signin'); setErr(''); }}>{t.authSignIn}</button>
          </div>

          <div className="auth-form">
            {mode === 'signup' && (
              <label className="field-row">
                <span className="field-label">{t.authName}</span>
                <input className="field" value={f.name} onChange={e => set('name', e.target.value)} onKeyDown={onKey} placeholder="Іван Петренко" autoFocus />
              </label>
            )}
            <label className="field-row">
              <span className="field-label">{t.authEmail}</span>
              <input className="field" type="email" value={f.email} onChange={e => set('email', e.target.value)} onKeyDown={onKey} placeholder="name@aglex.ua" />
            </label>
            <label className="field-row">
              <span className="field-label">{t.authPass}</span>
              <input className="field" type="password" value={f.pass} onChange={e => set('pass', e.target.value)} onKeyDown={onKey} placeholder="••••••" />
            </label>
            {mode === 'signup' && (
              <>
                <label className="field-row">
                  <span className="field-label">{t.authPass2}</span>
                  <input className="field" type="password" value={f.pass2} onChange={e => set('pass2', e.target.value)} onKeyDown={onKey} placeholder="••••••" />
                </label>
                <div className="field-row">
                  <span className="field-label">{t.authRole}</span>
                  <select className="field" value={f.role} onChange={e => set('role', e.target.value)}>
                    {roles.map(([id, l]) => <option key={id} value={id}>{l}</option>)}
                  </select>
                </div>
              </>
            )}

            {err ? <div className="auth-err"><Icon name="alert" size={14} /> {err}</div> : null}

            <button className="btn btn-primary" style={{ justifyContent: 'center', marginTop: 4 }} onClick={submit}>
              {mode === 'signup' ? t.authCreate : t.authLogin} <Icon name="arrowR" size={16} />
            </button>

            <div className="auth-switch">
              {mode === 'signup' ? t.authHave : t.authNo}
              <button onClick={() => { setMode(mode === 'signup' ? 'signin' : 'signup'); setErr(''); }}>
                {mode === 'signup' ? t.authSignIn : t.authSignUp}
              </button>
            </div>
            <button type="button" className="auth-test" onClick={useTestAccount}>
              <span className="auth-test-badge">{t.authTestTitle}</span>
              <span className="auth-test-creds">test@aglex.ua · test1234</span>
              <span className="auth-test-go">{t.authTestUse} <Icon name="arrowR" size={14} /></span>
            </button>
            <div className="auth-demo">{t.authDemo}</div>
          </div>
        </div>
      </main>
    </div>
  );
}
