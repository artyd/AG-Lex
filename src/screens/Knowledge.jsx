/* ============================================================
   Lexena — knowledge screens: Clause library, Legal search,
   Counterparty check, Team & access, Batch analysis
   ============================================================ */
import { useState, useEffect } from 'react';
import { Icon } from '../ui/Icon';
import { Modal, ScoreRing, SectionTitle, toast } from '../ui/components';
import { roleLabel } from '../lib/labels';
import { initialsOf, hueOf } from '../lib/auth';
import { api, ApiError } from '../lib/api';
import { DEMO } from '../data/demo';
import { LX } from '../data/lx';

// localStorage-backed state for the team workspace (persists edits)
function lxLS(key, fallback) {
  try { const v = JSON.parse(localStorage.getItem(key)); return (v == null ? fallback : v); }
  catch (e) { return fallback; }
}
function lxAuditStamp() {
  const n = new Date(), p = x => String(x).padStart(2, '0');
  return `${p(n.getDate())}.${p(n.getMonth() + 1)}.${n.getFullYear()} ${p(n.getHours())}:${p(n.getMinutes())}`;
}

// Backend returns canonical audit action codes; translate to display labels
// using the existing i18n keys so wording stays consistent with the rest of
// the UI. Falls back to the raw code if a translation is missing.
function auditActionLabel(t, action) {
  switch (action) {
    case 'role_change': return t.actRole || 'Role change';
    case 'invite':      return t.actInvite || 'Invite';
    case 'remove':      return t.actRemove || 'Remove';
    case 'perm_on':     return t.actPermOn || 'Permission on';
    case 'perm_off':    return t.actPermOff || 'Permission off';
    case 'perm_reset':  return t.actReset || 'Reset defaults';
    default:            return action;
  }
}

// Format an ISO 8601 server timestamp into the prototype's "DD.MM.YYYY HH:MM".
function formatAuditTs(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = x => String(x).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ---------- Clause library ---------- */
function ClauseLib({ t }) {
  const [q, setQ] = useState('');
  const lc = q.trim().toLowerCase();
  const copy = (text) => { try { navigator.clipboard.writeText(text); } catch (e) {} toast(t.copied, 'check'); };
  const cats = LX.clauseLib.map(c => ({ ...c, items: c.items.filter(it => !lc || (it.title + ' ' + it.text + ' ' + it.tags.join(' ')).toLowerCase().includes(lc)) })).filter(c => c.items.length);

  return (
    <div className="page view-enter"><div className="page-narrow">
      <div style={{ marginBottom: 'var(--s5)' }}>
        <div style={{ color: 'var(--text-2)', fontSize: 14 }}>{t.clauseLibSub}</div>
        <div className="search" style={{ maxWidth: 420, marginTop: 12 }}>
          <Icon name="search" size={17} />
          <input placeholder={t.clauseLibTitle + '…'} value={q} onChange={e => setQ(e.target.value)} />
        </div>
      </div>
      {cats.map(c => (
        <div key={c.cat} style={{ marginBottom: 'var(--s6)' }}>
          <SectionTitle>{c.cat}</SectionTitle>
          <div className="clause-grid">
            {c.items.map(it => (
              <div className="card clause-card" key={it.id}>
                <div style={{ fontWeight: 650, fontSize: 14.5, marginBottom: 6 }}>{it.title}</div>
                <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: 'var(--text-2)', fontFamily: 'var(--font-doc)' }}>{it.text}</p>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
                  {it.tags.map(tg => <span key={tg} className="law-chip" style={{ marginTop: 0 }}><Icon name="scales" size={11} /> {tg}</span>)}
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                  <button className="btn btn-ghost btn-sm" style={{ flex: 1, justifyContent: 'center' }} onClick={() => copy(it.text)}><Icon name="doc" size={14} /> {t.copyClause}</button>
                  <button className="btn btn-primary btn-sm" style={{ flex: 1, justifyContent: 'center' }} onClick={() => toast(t.clauseInserted, 'check')}><Icon name="plus" size={14} /> {t.insertClause}</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div></div>
  );
}

/* ---------- Legal search ---------- */
function LegalSearch({ t }) {
  const [q, setQ] = useState('');
  const [type, setType] = useState('all');
  const [open, setOpen] = useState(null);
  const lc = q.trim().toLowerCase();
  const typeBadge = { code: ['var(--accent)', 'ЦК/ГК'], law: ['var(--info)', 'ЗУ'], case: ['var(--risk-med)', 'ВС'], eu: ['var(--risk-low)', 'ЄС'] };
  const filters = [['all', t.legalAll], ['code', t.typeCode], ['law', t.typeLaw], ['case', t.typeCase], ['eu', t.typeEu]];
  const rows = LX.laws.filter(l => (type === 'all' || l.type === type) && (!lc || (l.title + ' ' + l.ref + ' ' + l.snippet).toLowerCase().includes(lc)));

  return (
    <div className="page view-enter"><div className="page-narrow">
      <div style={{ color: 'var(--text-2)', fontSize: 14, marginBottom: 12 }}>{t.legalSub}</div>
      <div className="search" style={{ maxWidth: 560 }}>
        <Icon name="search" size={17} />
        <input placeholder={t.legalPlaceholder} value={q} onChange={e => setQ(e.target.value)} />
      </div>
      <div className="seg" style={{ marginTop: 14, width: 'fit-content' }}>
        {filters.map(([id, l]) => <button key={id} className={type === id ? 'on' : ''} onClick={() => setType(id)}>{l}</button>)}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 'var(--s5)' }}>
        {rows.map(l => {
          const [col, badge] = typeBadge[l.type];
          const isOpen = open === l.id;
          return (
            <div className="card law-row" key={l.id}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                <span className="law-type" style={{ background: `color-mix(in oklab, ${col} 16%, transparent)`, color: col }}>{badge}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 650, fontSize: 14.5 }}>{l.ref}</div>
                  <div style={{ fontSize: 12.5, color: 'var(--text-3)', marginBottom: 6 }}>{l.title} · {l.date}</div>
                  <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.55, color: 'var(--text-2)', maxHeight: isOpen ? 'none' : 42, overflow: 'hidden' }}>{l.snippet}</p>
                  <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                    <button className="btn btn-subtle btn-sm" onClick={() => setOpen(isOpen ? null : l.id)}>{isOpen ? '−' : '+'} {isOpen ? t.close : t.openMatter}</button>
                    <button className="btn btn-subtle btn-sm" onClick={() => toast(t.askAiLegal + ': ' + l.ref, 'sparkle')}><Icon name="sparkle" size={13} fill={true} /> {t.askAiLegal}</button>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
        {rows.length === 0 ? <div style={{ textAlign: 'center', padding: 'var(--s8)', color: 'var(--text-3)' }}>{t.searchEmpty}</div> : null}
      </div>
    </div></div>
  );
}

/* ---------- Counterparty check ---------- */
function DDReport({ result, t, onSave, onAttach }) {
  const dd = result.dd || { score: 50, factors: [], court: {}, benef: [] };
  const riskTone = { low: 'var(--risk-low)', med: 'var(--risk-med)', high: 'var(--risk-high)' };
  const riskLbl = { low: t.riskLow, med: t.riskMed, high: t.riskHigh };
  const factLbl = { reg: t.factReg, sanc: t.factSanc, lit: t.factLit, tax: t.factTax, fin: t.factFin };
  const fc = v => v >= 75 ? 'var(--risk-low)' : v >= 50 ? 'var(--risk-med)' : 'var(--risk-high)';
  const rec = result.risk === 'high' ? t.ddRecHigh : result.risk === 'med' ? t.ddRecMed : t.ddRecLow;
  const sig = (label, bad, text, icon) => (
    <div className="dd-sig-row">
      <span className="dd-sig-ic"><Icon name={icon} size={15} /></span>
      <span style={{ flex: 1, fontSize: 13 }}>{label}</span>
      <span className={'dd-sig-status ' + (bad ? 'bad' : 'good')}><Icon name={bad ? 'alert' : 'checkCircle'} size={13} /> {text}</span>
    </div>
  );

  return (
    <div className="card view-enter" style={{ padding: 'var(--s5)', marginTop: 'var(--s5)' }}>
      <div className="dd-head">
        <span className="matter-av" style={{ background: 'var(--accent)' }}><Icon name="building" size={22} /></span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 18, letterSpacing: '-0.01em' }}>{result.name}</div>
          <div style={{ fontSize: 13, color: 'var(--text-3)' }}>ЄДРПОУ {result.code} · {result.status === 'active' ? t.cpActive : t.cpTerminated}</div>
          <div style={{ fontSize: 12.5, color: 'var(--text-3)', marginTop: 4 }}>{t.ddSub}</div>
        </div>
        <div className="dd-score">
          <ScoreRing value={dd.score} size={76} stroke={8} />
          <span className="badge-risk" style={{ background: `color-mix(in oklab, ${riskTone[result.risk]} 14%, transparent)`, color: riskTone[result.risk], marginTop: 6 }}>{riskLbl[result.risk]}</span>
        </div>
      </div>

      <div className="dd-sec" style={{ marginTop: 'var(--s5)' }}>
        <div className="dd-sec-h">{t.ddFactors}</div>
        <div className="dd-factors">
          {dd.factors.map(([k, v]) => (
            <div key={k} className="dd-bar">
              <span className="dd-bar-l">{factLbl[k]}</span>
              <span className="dd-bar-track"><span className="dd-bar-fill" style={{ width: v + '%', background: fc(v) }} /></span>
              <span className="dd-bar-v" style={{ color: fc(v) }}>{v}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="dd-sections">
        <div className="dd-sec">
          <div className="dd-sec-h">{t.ddReg}</div>
          <div className="dd-kv">
            {[[t.cpDirector, result.director], [t.cpKved, result.kved], [t.cpRegistered, result.registered], [t.ddFounded, dd.founded], [t.ddEmployees, dd.employees], [t.cpAddress, result.address]].map(([k, v]) => (
              <div key={k} className="dd-kv-row"><span className="dd-kv-l">{k}</span><span className="dd-kv-v">{v}</span></div>
            ))}
          </div>
        </div>

        <div className="dd-sec">
          <div className="dd-sec-h">{t.ddSignals}</div>
          <div className="dd-sigs">
            {sig(t.sigSanctions, result.sanctions, result.sanctions ? t.sigFound : t.sigClean, 'alert')}
            {sig(t.sigPep, dd.pep, dd.pep ? t.sigFound : t.sigClean, 'clients')}
            {sig(t.sigBankrupt, dd.bankruptcy, dd.bankruptcy ? t.sigFound : t.sigClean, 'building')}
            {sig(t.sigEnforce, dd.enforcement > 0, String(dd.enforcement || 0), 'scales')}
            {sig(t.sigTaxDebt, result.taxDebt, result.taxDebt ? t.cpYes : t.cpNo, 'coins')}
          </div>
        </div>

        <div className="dd-sec">
          <div className="dd-sec-h">{t.ddCourtH}</div>
          <div className="dd-court">
            <div className="dd-court-cell"><span className="dd-court-n">{dd.court.plaintiff}</span><span className="dd-court-l">{t.courtPlaintiff}</span></div>
            <div className="dd-court-cell"><span className="dd-court-n">{dd.court.defendant}</span><span className="dd-court-l">{t.courtDefendant}</span></div>
            <div className="dd-court-cell"><span className="dd-court-n" style={{ color: dd.court.open ? 'var(--risk-med)' : 'var(--text)' }}>{dd.court.open}</span><span className="dd-court-l">{t.courtOpen}</span></div>
            <div className="dd-court-cell"><span className="dd-court-n" style={{ fontSize: 16 }}>{dd.court.claims}</span><span className="dd-court-l">{t.courtClaims}</span></div>
          </div>
        </div>

        <div className="dd-sec">
          <div className="dd-sec-h">{t.ddFinance}</div>
          <div className="dd-kv">
            <div className="dd-kv-row"><span className="dd-kv-l">{t.ddRevenue}</span><span className="dd-kv-v">{dd.revenue}</span></div>
            <div className="dd-kv-row"><span className="dd-kv-l">{t.cpCapital}</span><span className="dd-kv-v">{result.capital}</span></div>
            <div className="dd-kv-row"><span className="dd-kv-l">{t.ddVat}</span><span className="dd-kv-v">{dd.vat ? t.cpYes : t.cpNo}</span></div>
          </div>
        </div>
      </div>

      <div className="dd-sec" style={{ marginTop: 'var(--s4)' }}>
        <div className="dd-sec-h">{t.ddBenef}</div>
        <div className="dd-benef">
          {dd.benef.map((b, i) => (
            <div key={i} className="dd-benef-row">
              <span className="ua" style={{ width: 30, height: 30, fontSize: 12, background: `oklch(0.58 0.14 ${hueOf(b.name)})` }}>{initialsOf(b.name)}</span>
              <span style={{ flex: 1, fontSize: 13.5, fontWeight: 600 }}>{b.name}</span>
              <span className="dd-share">{b.share}</span>
            </div>
          ))}
        </div>
      </div>

      <div className={'dd-conclusion dd-' + result.risk}>
        <Icon name={result.risk === 'low' ? 'checkCircle' : 'alert'} size={18} />
        <div><div className="dd-conclusion-h">{t.ddConclusion}</div><div style={{ fontSize: 13.5, lineHeight: 1.5 }}>{rec}</div></div>
      </div>

      <div className="dd-actions">
        <button className="btn btn-ghost btn-sm" onClick={onSave}><Icon name="download" size={15} /> {t.ddSave}</button>
        <button className="btn btn-primary btn-sm" onClick={onAttach}><Icon name="folder" size={15} /> {t.ddAttach}</button>
      </div>
    </div>
  );
}

function Counterparty({ t }) {
  const [code, setCode] = useState('');
  const [result, setResult] = useState(null);
  const [notFound, setNotFound] = useState(false);
  const [loading, setLoading] = useState(false);

  const check = (c) => {
    const key = (c || code).replace(/\D/g, '');
    setCode(key); setResult(null); setNotFound(false); setLoading(true);
    setTimeout(() => {
      const r = LX.counterparties[key];
      setLoading(false);
      if (r) setResult({ ...r, code: key }); else setNotFound(true);
    }, 700);
  };
  const riskTone = { low: 'var(--risk-low)', med: 'var(--risk-med)', high: 'var(--risk-high)' };
  const riskLbl = { low: t.riskLow, med: t.riskMed, high: t.riskHigh };

  return (
    <div className="page view-enter"><div className="page-narrow" style={{ maxWidth: 720 }}>
      <div style={{ color: 'var(--text-2)', fontSize: 14, marginBottom: 14 }}>{t.cpSub}</div>
      <div style={{ display: 'flex', gap: 10 }}>
        <div className="search" style={{ flex: 1, maxWidth: 'none' }}>
          <Icon name="building" size={17} />
          <input placeholder={t.cpPlaceholder} value={code} maxLength={8}
            onChange={e => setCode(e.target.value.replace(/\D/g, ''))}
            onKeyDown={e => { if (e.key === 'Enter') check(); }} />
        </div>
        <button className="btn btn-primary" onClick={() => check()} disabled={code.length < 8 || loading}><Icon name="search" size={16} /> {t.cpCheck}</button>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12.5, color: 'var(--text-3)', alignSelf: 'center' }}>{t.cpExamples}:</span>
        {LX.cpSuggest.map(s => <button key={s.code} className="chip" style={{ cursor: 'pointer' }} onClick={() => check(s.code)}>{s.code} · {s.name}</button>)}
      </div>

      {loading ? <div className="card" style={{ padding: 'var(--s8)', marginTop: 'var(--s5)', textAlign: 'center', color: 'var(--text-3)' }}><span className="pulse" style={{ display: 'inline-block', marginRight: 8 }} /> {t.batchRunning}</div> : null}
      {notFound ? <div className="card" style={{ padding: 'var(--s8)', marginTop: 'var(--s5)', textAlign: 'center', color: 'var(--text-3)' }}>{t.cpNotFound}</div> : null}

      {result && (
        <DDReport result={result} t={t}
          onSave={() => toast(t.ddSaved, 'checkCircle')}
          onAttach={() => toast(t.ddAttached, 'folder')} />
      )}
    </div></div>
  );
}

/* ---------- Team & access (RBAC, editable) ---------- */
function MiniAvatar({ name, initials, color, size = 36 }) {
  return <span className="ua" style={{ width: size, height: size, background: `oklch(0.58 0.14 ${color || 0})`, fontSize: size * 0.4 }} title={name}>{initials || initialsOf(name)}</span>;
}

function InviteModal({ open, onClose, onAdd, t }) {
  const [d, setD] = useState({ name: '', email: '', password: '', role: 'lawyer' });
  useEffect(() => { if (open) setD({ name: '', email: '', password: '', role: 'lawyer' }); }, [open]);
  const set = (k, v) => setD(p => ({ ...p, [k]: v }));
  const valid =
    d.name.trim() &&
    /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(d.email.trim()) &&
    d.password.length >= 8;
  const roles = ['partner', 'senior', 'lawyer', 'paralegal', 'admin'];
  return (
    <Modal open={open} onClose={onClose} icon="plus" title={t.teamInviteTitle}
      footer={<>
        <button className="btn btn-subtle" onClick={onClose}>{t.cancel}</button>
        <button className="btn btn-primary" disabled={!valid} onClick={() => onAdd(d)}><Icon name="plus" size={15} /> {t.teamAdd}</button>
      </>}>
      <div className="form-grid">
        <label className="field-row" style={{ gridColumn: '1 / -1' }}>
          <span className="field-label">{t.teamName}</span>
          <input className="field" value={d.name} onChange={e => set('name', e.target.value)} placeholder="Іван Петренко" autoFocus />
        </label>
        <label className="field-row" style={{ gridColumn: '1 / -1' }}>
          <span className="field-label">{t.teamEmail}</span>
          <input className="field" type="email" value={d.email} onChange={e => set('email', e.target.value)} placeholder="name@aglex.ua" />
        </label>
        <label className="field-row" style={{ gridColumn: '1 / -1' }}>
          <span className="field-label">{t.authPass || 'Пароль'}</span>
          <input
            className="field"
            type="text"
            value={d.password}
            onChange={e => set('password', e.target.value)}
            placeholder="мін. 8 символів — передайте новому учаснику"
          />
        </label>
        <label className="field-row" style={{ gridColumn: '1 / -1' }}>
          <span className="field-label">{t.teamRoleF}</span>
          <select className="field" value={d.role} onChange={e => set('role', e.target.value)}>
            {roles.map(r => <option key={r} value={r}>{roleLabel(t, r)}</option>)}
          </select>
        </label>
      </div>
    </Modal>
  );
}

function Team({ t, user }) {
  const [tab, setTab] = useState('members');
  // Initialise from the prototype data so the screen renders something before
  // the first fetch and during pure-UI dev when the FastAPI backend is down.
  const [members, setMembers] = useState(LX.team);
  const [perms, setPerms] = useState(LX.permissions);
  const [auditLog, setAuditLog] = useState(LX.audit);
  const [inviteOpen, setInviteOpen] = useState(false);
  const statusTone = { online: 'var(--risk-low)', away: 'var(--risk-med)', offline: 'var(--text-3)' };

  // Hydrate from the API on mount. 401/403 falls back to LX seeds quietly.
  useEffect(() => {
    let cancelled = false;
    Promise.allSettled([
      api.request('/api/team/members'),
      api.request('/api/team/permissions'),
      api.request('/api/team/audit').catch((e) => {
        // /audit needs manage; lawyer/paralegal etc. get 403. Keep going.
        if (e instanceof ApiError && e.status === 403) return [];
        throw e;
      }),
    ]).then(([m, p, a]) => {
      if (cancelled) return;
      if (m.status === 'fulfilled') setMembers(decorateMembers(m.value));
      if (p.status === 'fulfilled') setPerms(p.value);
      if (a.status === 'fulfilled') setAuditLog(decorateAudit(a.value));
    });
    return () => { cancelled = true; };
  }, []);

  const myRole = (user && user.role) || 'lawyer';
  const manageRow = perms.find(p => p.key === 'manage');
  const canManage = manageRow ? !!manageRow[myRole] : (myRole === 'partner' || myRole === 'admin');
  const roles = ['partner', 'senior', 'lawyer', 'paralegal', 'admin'];

  // Helpers that decorate API rows with avatar/colour fields the UI expects
  // but the backend doesn't store. Keeps presentation derived, not persisted.
  function decorateMembers(rows) {
    return rows.map(u => ({
      ...u,
      initials: initialsOf(u.name),
      color: hueOf(u.email || u.name) % 360,
      status: 'online',  // presence isn't tracked yet; show as online for now
    }));
  }
  function decorateAudit(rows) {
    return rows.map(a => ({
      id: a.id,
      ts: formatAuditTs(a.ts),
      action: auditActionLabel(t, a.action),
      target: a.target,
      whoName: a.actor_name,
      whoColor: hueOf(a.actor_name || '') % 360,
    }));
  }

  // Surface backend errors (403, 409 last-manage, network) as toasts.
  function reportError(e, fallbackMsg) {
    if (e instanceof ApiError) {
      if (e.status === 403) toast(t.teamNoManage || 'Forbidden', 'alert');
      else if (e.status === 409) toast(e.message || (t.teamPermLock || 'Last manager'), 'alert');
      else toast(e.message || fallbackMsg, 'alert');
    } else {
      toast(fallbackMsg, 'alert');
    }
  }

  async function refreshAudit() {
    try { setAuditLog(decorateAudit(await api.request('/api/team/audit'))); }
    catch (_e) { /* tolerated — non-manage users won't see audit */ }
  }

  const changeRole = async (id, role) => {
    const m = members.find(x => x.id === id);
    if (!m || m.role === role) return;
    const prev = members;
    setMembers(ms => ms.map(x => x.id === id ? { ...x, role } : x));
    try {
      await api.request(`/api/team/members/${id}`, { method: 'PATCH', body: { role } });
      toast(t.teamRoleSaved, 'check');
      refreshAudit();
    } catch (e) {
      setMembers(prev);
      reportError(e, t.teamRoleSaved);
    }
  };

  const removeMember = async (id) => {
    const m = members.find(x => x.id === id);
    if (!m) return;
    if (!window.confirm(t.teamConfirmRemove + '\n' + m.name)) return;
    const prev = members;
    setMembers(ms => ms.filter(x => x.id !== id));
    try {
      await api.request(`/api/team/members/${id}`, { method: 'DELETE' });
      toast(t.teamRemoved, 'x');
      refreshAudit();
    } catch (e) {
      setMembers(prev);
      reportError(e, t.teamRemoved);
    }
  };

  const addMember = async (d) => {
    try {
      const created = await api.request('/api/team/members', {
        method: 'POST',
        body: {
          name: d.name.trim(),
          email: d.email.trim().toLowerCase(),
          password: d.password,
          role: d.role,
        },
      });
      setMembers(ms => [...ms, ...decorateMembers([created])]);
      toast(t.teamInvited, 'plus');
      setInviteOpen(false);
      refreshAudit();
    } catch (e) {
      reportError(e, t.teamInvited);
    }
  };

  const togglePerm = async (i, role) => {
    const row = perms[i];
    const cur = !!row[role];
    // Optimistic update so the UI feels snappy; revert on server reject.
    const prev = perms;
    setPerms(ps => ps.map((p, idx) => idx === i ? { ...p, [role]: !cur } : p));
    try {
      const fresh = await api.request('/api/team/permissions', {
        method: 'PATCH',
        body: { capability: row.key, role, allowed: !cur },
      });
      setPerms(fresh);
      toast(t.teamPermSaved, 'check');
      refreshAudit();
    } catch (e) {
      setPerms(prev);
      reportError(e, t.teamPermSaved);
    }
  };

  const resetPerms = async () => {
    try {
      const fresh = await api.request('/api/team/permissions/reset', { method: 'POST' });
      setPerms(fresh);
      toast(t.teamPermSaved, 'check');
      refreshAudit();
    } catch (e) {
      reportError(e, t.teamPermSaved);
    }
  };

  return (
    <div className="page view-enter"><div className="page-narrow">
      <div style={{ color: 'var(--text-2)', fontSize: 14, marginBottom: 'var(--s4)' }}>{t.teamManageHint}</div>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 'var(--s5)' }}>
        <div className="seg">
          {[['members', t.tabMembers], ['perms', t.tabPerms], ['audit', t.tabAudit]].map(([id, l]) => (
            <button key={id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>{l}</button>
          ))}
        </div>
        {canManage && tab === 'members' ? <button className="btn btn-primary btn-sm" style={{ marginLeft: 'auto' }} onClick={() => setInviteOpen(true)}><Icon name="plus" size={15} /> {t.invite}</button> : null}
        {canManage && tab === 'perms' ? <button className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto' }} onClick={resetPerms}><Icon name="settings" size={15} /> {t.teamResetPerms}</button> : null}
      </div>

      {!canManage ? (
        <div className="team-banner"><Icon name="alert" size={16} /> {t.teamNoManage}</div>
      ) : null}

      {tab === 'members' && (
        <div className="card view-enter" style={{ overflow: 'hidden' }}>
          <table className="lib-table team-table">
            <tbody>
              {members.map(u => {
                const isMe = user && u.email && user.email && u.email.toLowerCase() === user.email.toLowerCase();
                return (
                  <tr key={u.id}>
                    <td style={{ width: 50 }}><MiniAvatar name={u.name} initials={u.initials} color={u.color} size={36} /></td>
                    <td>
                      <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>{u.name}{isMe ? <span className="you-tag">{t.teamYou}</span> : null}</div>
                      <div style={{ fontSize: 12, color: 'var(--text-3)' }}>{u.email}</div>
                    </td>
                    <td style={{ minWidth: 150 }}>
                      {canManage
                        ? <select className="mini-select" value={u.role} onChange={e => changeRole(u.id, e.target.value)}>
                            {roles.map(r => <option key={r} value={r}>{roleLabel(t, r)}</option>)}
                          </select>
                        : <span className="chip">{roleLabel(t, u.role)}</span>}
                    </td>
                    <td style={{ textAlign: 'right' }}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: statusTone[u.status] }}><span className="chip-dot" style={{ background: statusTone[u.status] }} />{u.status}</span></td>
                    <td style={{ width: 44, textAlign: 'right' }}>
                      {canManage && !isMe ? <button className="icon-btn icon-btn-sm" title={t.teamRemove} onClick={() => removeMember(u.id)}><Icon name="x" size={16} /></button> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'perms' && (
        <div className="card view-enter" style={{ overflow: 'auto' }}>
          <table className="perm-table">
            <thead>
              <tr><th style={{ textAlign: 'left' }}>{t.capability}</th>{roles.map(r => <th key={r}>{roleLabel(t, r)}</th>)}</tr>
            </thead>
            <tbody>
              {perms.map((p, i) => (
                <tr key={p.key || i}>
                  <td style={{ textAlign: 'left', fontWeight: 600 }}>{p.cap}</td>
                  {roles.map(r => (
                    <td key={r}>
                      {canManage
                        ? <button className={'perm-toggle' + (p[r] ? ' on' : '')} onClick={() => togglePerm(i, r)} aria-label={p.cap + ' · ' + roleLabel(t, r)}>
                            {p[r] ? <Icon name="check" size={13} stroke={3} /> : null}
                          </button>
                        : (p[r]
                            ? <span className="perm-yes"><Icon name="check" size={13} stroke={3} /></span>
                            : <span className="perm-no">—</span>)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'audit' && (
        <div className="card view-enter" style={{ overflow: 'hidden' }}>
          <table className="lib-table">
            <tbody>
              {auditLog.map(a => {
                const au = a.who ? LX.userById[a.who] : null;
                const nm = au ? au.name : (a.whoName || '—');
                return (
                  <tr key={a.id}>
                    <td style={{ width: 50 }}>{au
                      ? <MiniAvatar name={au.name} initials={au.initials} color={au.color} size={30} />
                      : <MiniAvatar name={nm} color={a.whoColor} size={30} />}</td>
                    <td><span style={{ fontWeight: 600 }}>{nm}</span> <span style={{ color: 'var(--text-2)' }}>— {a.action}</span>{a.target ? <div style={{ fontSize: 12, color: 'var(--text-3)' }}>{a.target}</div> : null}</td>
                    <td style={{ textAlign: 'right', color: 'var(--text-3)', fontSize: 12.5, whiteSpace: 'nowrap', fontFamily: 'var(--font-mono)' }}>{a.ts}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <InviteModal open={inviteOpen} onClose={() => setInviteOpen(false)} onAdd={addMember} t={t} />
    </div></div>
  );
}

/* ---------- Batch analysis ---------- */
function Batch({ t, setRoute }) {
  const D = DEMO;
  const items = D.library;
  const [sel, setSel] = useState(() => new Set(items.filter(c => c.status !== 'done').map(c => c.id)));
  const [phase, setPhase] = useState('idle'); // idle | running | done
  const [pct, setPct] = useState(0);

  const toggle = (id) => setSel(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const run = () => {
    setPhase('running'); setPct(0);
    const iv = setInterval(() => setPct(p => {
      if (p >= 100) { clearInterval(iv); setPhase('done'); return 100; }
      return Math.min(100, p + 14);
    }), 240);
  };
  const chosen = items.filter(c => sel.has(c.id));
  const avg = chosen.length ? Math.round(chosen.reduce((s, c) => s + c.score, 0) / chosen.length) : 0;
  const riskOf = (score) => score >= 75 ? 'low' : score >= 55 ? 'med' : 'high';
  const totalRisks = chosen.reduce((s, c) => s + (c.score >= 75 ? 1 : c.score >= 55 ? 4 : 8), 0);

  return (
    <div className="page view-enter"><div className="page-narrow">
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 'var(--s5)' }}>
        <div><div style={{ color: 'var(--text-2)', fontSize: 14 }}>{t.batchSub}</div></div>
        <button className="btn btn-primary" style={{ marginLeft: 'auto' }} disabled={!sel.size || phase === 'running'} onClick={run}>
          <Icon name="sparkle" size={16} fill={true} /> {phase === 'running' ? t.batchRunning : `${t.batchRun} (${sel.size})`}
        </button>
      </div>

      {phase === 'running' ? <div className="prog" style={{ marginBottom: 'var(--s5)' }}><div className="prog-bar" style={{ width: pct + '%' }} /></div> : null}

      {phase === 'done' && (
        <div className="batch-kpis view-enter">
          <div className="card kpi-card"><div className="ms-l">{t.selected}</div><div className="kpi-v">{chosen.length}</div></div>
          <div className="card kpi-card"><div className="ms-l">{t.avgScore}</div><div className="kpi-v" style={{ color: avg >= 75 ? 'var(--risk-low)' : avg >= 55 ? 'var(--risk-med)' : 'var(--risk-high)' }}>{avg}</div></div>
          <div className="card kpi-card"><div className="ms-l">{t.totalRisks}</div><div className="kpi-v" style={{ color: 'var(--risk-high)' }}>{totalRisks}</div></div>
        </div>
      )}

      <div className="card" style={{ overflow: 'hidden', marginTop: phase === 'done' ? 'var(--s4)' : 0 }}>
        <table className="lib-table">
          <thead><tr><th style={{ width: 44 }}></th><th>{t.colName}</th><th>{t.colClient}</th><th>{t.colType}</th>{phase === 'done' ? <th style={{ textAlign: 'right' }}>{t.colScore}</th> : null}<th></th></tr></thead>
          <tbody>
            {items.map(c => {
              const on = sel.has(c.id);
              return (
                <tr key={c.id} className={on ? 'row-current' : ''}>
                  <td><button className={'bcheck' + (on ? ' on' : '')} onClick={() => toggle(c.id)}>{on ? <Icon name="check" size={13} stroke={3} /> : null}</button></td>
                  <td style={{ fontWeight: 600 }}>{c.name}</td>
                  <td style={{ color: 'var(--text-2)' }}>{c.client}</td>
                  <td><span className="chip">{c.type}</span></td>
                  {phase === 'done' ? <td style={{ textAlign: 'right', fontWeight: 700, color: on ? (c.score >= 75 ? 'var(--risk-low)' : c.score >= 55 ? 'var(--risk-med)' : 'var(--risk-high)') : 'var(--text-3)' }}>{on ? c.score : '—'}</td> : null}
                  <td>{phase === 'done' && on ? <button className="btn btn-subtle btn-sm" onClick={() => setRoute('analyze')}>{t.openMatter}</button> : null}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div></div>
  );
}

export { ClauseLib, LegalSearch, Counterparty, Team, Batch };
