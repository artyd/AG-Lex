/* ============================================================
   AG Lex — Litigation portfolio (Спори).

   List view: every matter whose status is `court` (or whose type is
   `litigation`) surfaces here as a dispute card. The source of truth is
   `useMatters()` — the same hook that drives Practice → Справи — so a
   status change on either side is reflected immediately without reload.

   Detail view: keeps the pre-existing chronology + procedural-deadline
   calculator + pleadings layout for one selected dispute. Closing a
   dispute writes back through `api.matters.update({status:'closed',
   outcome, closedAt})`, which moves the matter to the archive in
   Practice and tags it `Завершено` here.
   ============================================================ */
import { useEffect, useMemo, useState } from 'react';
import { Icon, Modal, SectionTitle, toast } from '../ui/components';
import { UserAvatar } from '../lib/labels';
import { api } from '../lib/api';
import { useMatters, useMatterDetail, selectDisputes } from './matters/useMatters';
import { DEMO } from '../data/demo';
import { LX } from '../data/lx';

// ----- Static config ---------------------------------------------------------

const STAGES = ['lit_stage_open', 'lit_stage_prep', 'lit_stage_trial', 'lit_stage_decision'];

const INSTANCES = ['first', 'appeal', 'cassation'];

// Mirror Practice.STATUS_COLOR.court so a dispute card and its source matter
// read identically across screens. Kept inline so this file stays self-
// contained — duplicating five lines beats a cross-module color export.
const COURT_COLOR = {
  bg: 'color-mix(in oklab, oklch(0.58 0.18 310) 16%, transparent)',
  fg: 'oklch(0.46 0.18 310)',
  dot: 'oklch(0.58 0.18 310)',
};
const WON_COLOR = { bg: 'var(--risk-low-soft)', fg: 'oklch(0.4 0.12 158)', dot: 'var(--risk-low)' };
const SETTLED_COLOR = { bg: 'var(--info-soft)', fg: 'var(--info)', dot: 'var(--info)' };
const LOST_COLOR = { bg: 'var(--risk-high-soft)', fg: 'var(--risk-high)', dot: 'var(--risk-high)' };

const LIT_EV_ICON = { claim: 'alert', doc: 'doc', filed: 'scales', hearing: 'calendar' };

// ----- Helpers ---------------------------------------------------------------

function parseISO(s) {
  if (!s) return null;
  if (s instanceof Date) return s;
  const [y, m, d] = String(s).split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}
function fmtDateShort(iso, locale) {
  const d = parseISO(iso);
  if (!d) return '—';
  return d.toLocaleDateString(locale || 'uk-UA', { day: '2-digit', month: 'short' });
}
function fmtDateLong(iso, locale) {
  const d = parseISO(iso);
  if (!d) return '—';
  return d.toLocaleDateString(locale || 'uk-UA', { day: '2-digit', month: 'long', year: 'numeric' });
}
function daysUntil(iso) {
  const d = parseISO(iso);
  if (!d) return null;
  // Frozen "today" matches Practice.jsx so the same hearing yields the same
  // tone across screens.
  const today = new Date(2026, 5, 9);
  return Math.round((d - today) / 86400000);
}
function deadlineTone(iso) {
  const n = daysUntil(iso);
  if (n === null) return null;
  if (n < 0) return 'overdue';
  if (n <= 7) return 'soon';
  return 'ok';
}
function fmtClaim(amount) {
  if (amount == null || amount === '') return '—';
  if (typeof amount === 'string') return amount;
  const n = Number(amount);
  if (!Number.isFinite(n)) return String(amount);
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + ' млн ₴';
  if (n >= 1_000) return (n / 1_000).toFixed(0) + ' тис. ₴';
  return n.toLocaleString('uk-UA') + ' ₴';
}
function instLabel(t, key) {
  return t['lit_inst_' + key] || t.lit_inst_first;
}
function roleLabelLit(t, role) {
  if (!role) return t.lit_role_def;
  // Accept the raw Cyrillic strings sitting in older seeds as-is so the
  // card stays readable without a migration step.
  if (role === 'Відповідач' || role === 'def') return t.lit_role_def;
  if (role === 'Позивач'    || role === 'plf') return t.lit_role_plf;
  return role;
}

function disputeStatusKind(d) {
  if (d.outcome === 'won') return 'won';
  if (d.outcome === 'settled') return 'settled';
  if (d.outcome === 'lost') return 'lost';
  return 'open';
}
function disputeStatusColor(kind) {
  if (kind === 'won') return WON_COLOR;
  if (kind === 'settled') return SETTLED_COLOR;
  if (kind === 'lost') return LOST_COLOR;
  return COURT_COLOR;
}

function hasRequisites(d) {
  return !!(d.caseNumber || d.court || d.judge);
}

// ----- KPI tiles -------------------------------------------------------------

function Kpi({ icon, tone, value, label }) {
  return (
    <div className="card kpi-tile" style={{ '--tone': tone }}>
      <span className="kpi-tile-ic"><Icon name={icon} size={18} /></span>
      <div className="kpi-tile-v">{value}</div>
      <div className="kpi-tile-l">{label}</div>
    </div>
  );
}

function KpiRow({ disputes, t }) {
  const inWork = disputes.filter(d => !d.outcome).length;
  const won = disputes.filter(d => d.outcome === 'won').length;
  const claimsTotal = disputes.reduce((s, d) => {
    const n = Number(d.claimAmount);
    return s + (Number.isFinite(n) ? n : 0);
  }, 0);
  const hearingsSoon = disputes.filter(d => {
    if (d.outcome) return false;
    const n = daysUntil(d.nextHearing);
    return n !== null && n >= 0 && n <= 14;
  }).length;
  return (
    <div className="lit-kpi-row">
      <Kpi icon="flag"        tone="oklch(0.58 0.18 310)" value={inWork}             label={t.lit_kpi_inwork} />
      <Kpi icon="checkCircle" tone="var(--risk-low)"      value={won}                label={t.lit_kpi_won} />
      <Kpi icon="coins"       tone="var(--risk-med)"      value={fmtClaim(claimsTotal)} label={t.lit_kpi_claims} />
      <Kpi icon="gavel"       tone="var(--info)"          value={hearingsSoon}       label={t.lit_kpi_hearings} />
    </div>
  );
}

// ----- Filters bar -----------------------------------------------------------

function FiltersBar({ instFilter, setInstFilter, statusFilter, setStatusFilter, search, setSearch, t }) {
  return (
    <div className="lit-toolbar">
      <div className="seg seg-sm">
        {[['all', t.lit_inst_all], ['first', t.lit_inst_first], ['appeal', t.lit_inst_appeal], ['cassation', t.lit_inst_cassation]].map(([id, l]) => (
          <button key={id} className={instFilter === id ? 'on' : ''} onClick={() => setInstFilter(id)}>{l}</button>
        ))}
      </div>
      <div className="seg seg-sm">
        {[['open', t.lit_status_open], ['won', t.lit_status_won], ['settled', t.lit_status_settled], ['all', t.lit_status_all]].map(([id, l]) => (
          <button key={id} className={statusFilter === id ? 'on' : ''} onClick={() => setStatusFilter(id)}>{l}</button>
        ))}
      </div>
      <div className="search lit-search">
        <Icon name="search" size={16} />
        <input placeholder={t.lit_search_ph} value={search} onChange={e => setSearch(e.target.value)} />
        {search ? <button className="search-clear" onClick={() => setSearch('')}><Icon name="x" size={13} /></button> : null}
      </div>
    </div>
  );
}

// ----- Stage progress strip --------------------------------------------------

function StageStrip({ stageIndex, t }) {
  return (
    <div className="lit-stage">
      {STAGES.map((key, i) => {
        const cls = i < stageIndex ? 'done' : i === stageIndex ? 'now' : '';
        return (
          <span key={key} className={'st ' + cls}>
            <span className="c">{i < stageIndex ? <Icon name="check" size={9} /> : null}</span>
            <span className="lb">{t[key]}</span>
            {i < STAGES.length - 1 ? <span className={'ln' + (i < stageIndex ? ' done' : '')} /> : null}
          </span>
        );
      })}
    </div>
  );
}

// ----- Dispute card ----------------------------------------------------------

function DisputeCard({ d, t, onOpen, onAddCourt }) {
  const kind = disputeStatusKind(d);
  const color = disputeStatusColor(kind);
  const statusLabel = t['lit_status_' + kind];
  const hr = hasRequisites(d);

  return (
    <button className="card mt-card lit-card" onClick={onOpen}>
      <div className="mt-card-head">
        <span className="mt-type-ic" style={{ background: color.bg, color: color.fg }}>
          <Icon name="gavel" size={18} />
        </span>
        <div className="mt-card-meta">
          <span className="mt-code">№ {d.caseNumber || t.lit_no_number}</span>
          <span className="chip" style={{ fontSize: 11 }}>{instLabel(t, d.instance)}</span>
        </div>
        <span className="mt-status mt-status-sm" style={{ background: color.bg, color: color.fg }}>
          <span className="mt-status-dot" style={{ background: color.dot }} />
          {statusLabel}
        </span>
      </div>

      <div className="mt-card-title">{d.title}</div>

      {hr ? (
        <div className="lit-card-grid">
          <div>
            <div className="ms-l">{t.mt_party_client} ({roleLabelLit(t, d.role).toLowerCase()})</div>
            <div className="lit-v">{d.client || '—'}</div>
          </div>
          <div>
            <div className="ms-l">{t.lit_opponent}</div>
            <div className="lit-v">{d.opponent || '—'}</div>
          </div>
          <div>
            <div className="ms-l">{t.litCourt}</div>
            <div className="lit-v">{d.court || '—'}</div>
          </div>
          <div>
            <div className="ms-l">{t.lit_claim}</div>
            <div className="lit-v">{fmtClaim(d.claimAmount)}</div>
          </div>
        </div>
      ) : (
        <div
          className="lit-add-court-cta"
          onClick={(e) => { e.stopPropagation(); onAddCourt(d); }}
        >
          <Icon name="plus" size={14} /> {t.lit_add_court}
        </div>
      )}

      <StageStrip stageIndex={d.stageIndex} t={t} />

      <div className="mt-card-foot lit-card-foot">
        <UserAvatar id={d.lead} size={26} />
        <span className="lit-judge">{d.judge || '—'}</span>
        {d.outcome ? (
          <span className="lit-done-pill"><Icon name="checkCircle" size={12} /> {t.lit_done}</span>
        ) : (
          <span className={'mt-dd-inline mt-dd-' + (deadlineTone(d.nextHearing) || 'ok')}>
            {d.nextHearing ? `${t.lit_next_hearing} ${fmtDateShort(d.nextHearing, t.locale)}` : '—'}
          </span>
        )}
      </div>
    </button>
  );
}

// ----- Court-requisites modal ------------------------------------------------

function CourtRequisitesModal({ open, dispute, onClose, onSave, t }) {
  const [form, setForm] = useState({
    caseNumber: '', court: '', judge: '', opponent: '',
    role: 'def', instance: 'first', claimAmount: '', nextHearing: '',
  });
  useEffect(() => {
    if (!open || !dispute) return;
    setForm({
      caseNumber: dispute.caseNumber || '',
      court:      dispute.court || '',
      judge:      dispute.judge || '',
      opponent:   dispute.opponent || '',
      role:       dispute.role === 'Позивач' ? 'plf' : 'def',
      instance:   dispute.instance || 'first',
      claimAmount: dispute.claimAmount || '',
      nextHearing: dispute.nextHearing || '',
    });
  }, [open, dispute]);
  if (!dispute) return null;
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  return (
    <Modal open={open} onClose={onClose} title={t.lit_court_modal_title} sub={t.lit_court_modal_sub} icon="gavel" wide
      footer={<>
        <button className="btn btn-subtle" onClick={onClose}>{t.cancel}</button>
        <button className="btn btn-primary" onClick={() => onSave(dispute.id, form)}>
          <Icon name="check" size={14} /> {t.lit_save}
        </button>
      </>}>
      <div className="form-grid">
        <div className="field-row">
          <label className="field-label">{t.lit_case_no_label}</label>
          <input className="field" placeholder="910/1234/26" value={form.caseNumber} onChange={e => set('caseNumber', e.target.value)} />
        </div>
        <div className="field-row">
          <label className="field-label">{t.lit_inst_label}</label>
          <select className="field" value={form.instance} onChange={e => set('instance', e.target.value)}>
            {INSTANCES.map(k => <option key={k} value={k}>{instLabel(t, k)}</option>)}
          </select>
        </div>
        <div className="field-row" style={{ gridColumn: '1 / -1' }}>
          <label className="field-label">{t.litCourt}</label>
          <input className="field" placeholder="Господарський суд міста Києва" value={form.court} onChange={e => set('court', e.target.value)} />
        </div>
        <div className="field-row">
          <label className="field-label">{t.litJudge}</label>
          <input className="field" placeholder="суддя Левченко О. П." value={form.judge} onChange={e => set('judge', e.target.value)} />
        </div>
        <div className="field-row">
          <label className="field-label">{t.lit_role_label}</label>
          <select className="field" value={form.role} onChange={e => set('role', e.target.value)}>
            <option value="def">{t.lit_role_def}</option>
            <option value="plf">{t.lit_role_plf}</option>
          </select>
        </div>
        <div className="field-row" style={{ gridColumn: '1 / -1' }}>
          <label className="field-label">{t.lit_opponent}</label>
          <input className="field" value={form.opponent} onChange={e => set('opponent', e.target.value)} />
        </div>
        <div className="field-row">
          <label className="field-label">{t.lit_claim_amount_label}</label>
          <input className="field" placeholder="482 350 грн" value={form.claimAmount} onChange={e => set('claimAmount', e.target.value)} />
        </div>
        <div className="field-row">
          <label className="field-label">{t.lit_next_hearing_label}</label>
          <input type="date" className="field" value={form.nextHearing} onChange={e => set('nextHearing', e.target.value)} />
        </div>
      </div>
    </Modal>
  );
}

// ----- Close-dispute modal ---------------------------------------------------

function CloseDisputeModal({ open, onClose, onConfirm, t }) {
  const [outcome, setOutcome] = useState('won');
  const [date, setDate] = useState('2026-06-09');
  useEffect(() => { if (open) { setOutcome('won'); setDate('2026-06-09'); } }, [open]);
  return (
    <Modal open={open} onClose={onClose} title={t.lit_close} sub={t.lit_close_sub} icon="checkCircle"
      footer={<>
        <button className="btn btn-subtle" onClick={onClose}>{t.cancel}</button>
        <button className="btn btn-primary" onClick={() => onConfirm({ outcome, date })}>
          <Icon name="check" size={14} /> {t.lit_close}
        </button>
      </>}>
      <div className="field-row">
        <div className="field-label">{t.mt_result}</div>
        <div className="mt-result-grid">
          {['won', 'settled', 'lost'].map(r => {
            const tone = r === 'won' ? 'var(--risk-low)' : r === 'lost' ? 'var(--risk-high)' : 'var(--info)';
            return (
              <button key={r} className={'mt-result-opt' + (outcome === r ? ' on' : '')}
                style={{ '--tone': tone }} onClick={() => setOutcome(r)}>
                <span className="mt-result-ic"><Icon name={r === 'won' ? 'checkCircle' : r === 'lost' ? 'alert' : 'scales'} size={18} /></span>
                <span>{t['mt_result_' + r]}</span>
              </button>
            );
          })}
        </div>
      </div>
      <div className="field-row" style={{ marginTop: 'var(--s4)' }}>
        <label className="field-label" htmlFor="lit-close-date">{t.mt_close_date}</label>
        <input id="lit-close-date" type="date" className="field" value={date} onChange={e => setDate(e.target.value)} />
      </div>
    </Modal>
  );
}

// ----- Add-hearing modal -----------------------------------------------------

function AddHearingModal({ open, onClose, onSave, t }) {
  const [date, setDate] = useState('');
  const [title, setTitle] = useState('');
  useEffect(() => { if (open) { setDate(''); setTitle(''); } }, [open]);
  return (
    <Modal open={open} onClose={onClose} title={t.lit_hearing_modal_title} sub={t.lit_hearing_modal_sub} icon="calendar"
      footer={<>
        <button className="btn btn-subtle" onClick={onClose}>{t.cancel}</button>
        <button className="btn btn-primary" disabled={!date || !title.trim()} onClick={() => onSave({ date, title: title.trim() })}>
          <Icon name="check" size={14} /> {t.lit_save}
        </button>
      </>}>
      <div className="form-grid">
        <div className="field-row">
          <label className="field-label">{t.lit_hearing_date}</label>
          <input type="date" className="field" value={date} onChange={e => setDate(e.target.value)} />
        </div>
        <div className="field-row" style={{ gridColumn: '1 / -1' }}>
          <label className="field-label">{t.lit_hearing_title}</label>
          <input className="field" value={title} onChange={e => setTitle(e.target.value)} placeholder="Засідання по суті справи" />
        </div>
      </div>
    </Modal>
  );
}

// ----- Detail view (keeps calculator + chronology + pleadings) ---------------

function DisputeDetail({ d, detail, t, setRoute, onBack, onAddCourt, onAddHearing, onClose }) {
  // Calculator state. Default to the dispute's nextHearing (or today's date
  // as a fallback) so the first render shows a sensible result.
  const rules = LX.litigation.rules;
  const [ruleId, setRuleId] = useState(rules[0].id);
  const [from, setFrom] = useState(d.nextHearing || '2026-06-09');
  const [added, setAdded] = useState(false);
  const rule = rules.find(r => r.id === ruleId);

  const baseDate = from ? new Date(from) : null;
  const result = baseDate && !isNaN(baseDate) ? new Date(baseDate.getTime() + rule.days * 86400000) : null;
  const fmtCalc = (dt) => dt ? dt.toLocaleDateString('uk-UA', { day: '2-digit', month: 'long', year: 'numeric' }) : '—';
  const iso = (dt) => dt.toISOString().slice(0, 10);

  const addCal = () => {
    if (!result) return;
    const id = 'lit-' + ruleId + '-' + iso(result) + '-' + d.id;
    if (!DEMO.tasks.find(x => x.id === id))
      DEMO.tasks.push({ id, date: iso(result), title: rule.label + ' — справа ' + (d.caseNumber || d.code), client: d.client, type: 'deadline', risk: 'high' });
    setAdded(true);
    toast(t.litAddedCal, 'calendar');
    setTimeout(() => setAdded(false), 1600);
  };

  // Chronology: prefer hydrated hearings list (server), fall back to the
  // demo `LX.litigation.timeline` so we don't render empty space when the
  // backend isn't seeded.
  const hearings = (detail && Array.isArray(detail.hearings) && detail.hearings.length > 0)
    ? detail.hearings.map(h => ({ date: h.date, type: 'hearing', title: h.title || h.label, upcoming: !!h.upcoming }))
    : LX.litigation.timeline;

  // Pleadings — reuse demo data; full version pulls from server `case_documents`.
  const stChip = { done: ['stDone', 'var(--risk-low)'], draft: ['stDraft', 'var(--risk-med)'], planned: ['stPlanned', 'var(--text-3)'] };
  const pleadings = LX.litigation.pleadings;

  const kind = disputeStatusKind(d);
  const color = disputeStatusColor(kind);

  return (
    <div className="page view-enter">
      <div className="page-narrow">
        <button className="btn btn-subtle btn-sm mt-back" onClick={onBack}>
          <Icon name="chevR" size={14} style={{ transform: 'rotate(180deg)' }} /> {t.mt_back}
        </button>

        <div className="card lit-head">
          <span className="mt-type-ic mt-type-ic-lg" style={{ background: color.bg, color: color.fg }}>
            <Icon name="gavel" size={26} />
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span className="mt-code">№ {d.caseNumber || t.lit_no_number}</span>
              <span className="chip" style={{ fontSize: 11 }}>{instLabel(t, d.instance)}</span>
              <span className="chip" style={{ fontSize: 11 }}>{roleLabelLit(t, d.role)}</span>
              <span className="mt-status mt-status-sm" style={{ background: color.bg, color: color.fg }}>
                <span className="mt-status-dot" style={{ background: color.dot }} />
                {t['lit_status_' + kind]}
              </span>
            </div>
            <h1 className="mt-detail-title" style={{ marginTop: 8 }}>{d.title}</h1>
            <div className="lit-meta">
              <span><b>{t.litCourt}:</b> {d.court || '—'}</span>
              <span><b>{t.litJudge}:</b> {d.judge || '—'}</span>
              <span><b>{t.lit_claim}:</b> {fmtClaim(d.claimAmount)}</span>
              {d.nextHearing
                ? <span><b>{t.lit_next_hearing}:</b> {fmtDateLong(d.nextHearing, t.locale)}</span>
                : null}
            </div>
          </div>
          <div className="lit-detail-side">
            <StageStrip stageIndex={d.stageIndex} t={t} />
            <div className="lit-detail-actions">
              <button className="btn btn-ghost btn-sm" onClick={() => onAddCourt(d)}>
                <Icon name="pen" size={13} /> {t.lit_add_court}
              </button>
              <button className="btn btn-ghost btn-sm" onClick={onAddHearing}>
                <Icon name="calendar" size={13} /> {t.lit_add_hearing}
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => {
                try { localStorage.setItem('aglex_matter_open', d.id); } catch (_e) { /* noop */ }
                setRoute('matters');
              }}>
                <Icon name="folder" size={13} /> {t.lit_open_matter}
              </button>
              {d.outcome
                ? null
                : <button className="btn btn-primary btn-sm" onClick={onClose}>
                    <Icon name="checkCircle" size={13} /> {t.lit_close}
                  </button>}
            </div>
          </div>
        </div>

        {d.outcome ? (
          <div className={'mt-closed-banner mt-result-' + d.outcome}>
            <Icon name={d.outcome === 'won' ? 'checkCircle' : d.outcome === 'lost' ? 'alert' : 'scales'} size={18} />
            <div style={{ flex: 1 }}>
              <b>{t['mt_result_' + d.outcome]}</b>
              {d.closedAt ? <span style={{ color: 'var(--text-3)', marginLeft: 8 }}>· {t.mt_closed_on}: {fmtDateLong(d.closedAt, t.locale)}</span> : null}
            </div>
          </div>
        ) : null}

        <div className="lit-grid" style={{ marginTop: 'var(--s4)' }}>
          <div className="card" style={{ padding: 'var(--s5)' }}>
            <SectionTitle>{t.litTimeline}</SectionTitle>
            <div className="lit-tl">
              {hearings.map((e, i) => (
                <div key={i} className={'lit-tl-row' + (e.upcoming ? ' upcoming' : '')}>
                  <span className="lit-tl-dot"><Icon name={LIT_EV_ICON[e.type] || 'doc'} size={13} /></span>
                  <div className="lit-tl-body">
                    <div className="lit-tl-date">{fmtDateLong(e.date, t.locale)}{e.upcoming ? ' · ' + t.litNextHearing : ''}</div>
                    <div className="lit-tl-title">{e.title}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s4)' }}>
            <div className="card lit-calc">
              <SectionTitle>{t.litCalc}</SectionTitle>
              <div style={{ fontSize: 12.5, color: 'var(--text-3)', marginTop: -8, marginBottom: 12 }}>{t.litCalcSub}</div>
              <label className="field-row"><span className="field-label">{t.litRule}</span>
                <select className="field" value={ruleId} onChange={e => setRuleId(e.target.value)}>
                  {rules.map(r => <option key={r.id} value={r.id}>{r.label} ({r.days} {t.litDays})</option>)}
                </select>
              </label>
              <label className="field-row" style={{ marginTop: 12 }}><span className="field-label">{t.litFrom}</span>
                <input type="date" className="field" value={from} onChange={e => setFrom(e.target.value)} />
              </label>
              <div className="lit-result">
                <div>
                  <div className="lit-result-l">{t.litResult} · +{rule.days} {t.litDays}</div>
                  <div className="lit-result-v">{fmtCalc(result)}</div>
                </div>
                <button className={'btn btn-sm ' + (added ? 'btn-ghost' : 'btn-primary')} onClick={addCal} disabled={!result}>
                  <Icon name={added ? 'check' : 'calendar'} size={15} /> {t.addToCal}
                </button>
              </div>
            </div>

            <div className="card" style={{ padding: 'var(--s5)' }}>
              <SectionTitle>{t.litDocs}</SectionTitle>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {pleadings.map(p => {
                  const [lblKey, col] = stChip[p.status];
                  return (
                    <div key={p.id} className="lit-doc">
                      <span className="lit-doc-ic"><Icon name="doc" size={15} /></span>
                      <span style={{ flex: 1, fontSize: 13.5, fontWeight: 600 }}>{p.name}</span>
                      <span className="chip" style={{ color: col, fontSize: 11 }}>{t[lblKey]}</span>
                      <button className="btn btn-subtle btn-sm" onClick={() => setRoute('builder')}><Icon name="wand" size={14} /> {t.litGenerate}</button>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ----- Root component --------------------------------------------------------

function Litigation({ t, setRoute }) {
  const { matters, setMatters, reload: reloadMatters } = useMatters();
  const [selId, setSelId] = useState(null);
  const [instFilter, setInstFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('open');
  const [search, setSearch] = useState('');
  const [courtOpen, setCourtOpen] = useState(false);
  const [courtTarget, setCourtTarget] = useState(null);
  const [closeOpen, setCloseOpen] = useState(false);
  const [hearingOpen, setHearingOpen] = useState(false);

  // Derive disputes from matters every render. Cheap (filter + map) and
  // means a change to a source matter — same status drop, same broadcast —
  // refreshes both screens without any extra plumbing.
  const disputes = useMemo(() => selectDisputes(matters), [matters]);

  // Detail uses the hydrated case payload (hearings, members, parties…)
  // — the same hook Practice uses for its detail tab.
  const { detail: detailRaw } = useMatterDetail(selId);
  const selDispute = useMemo(() => {
    if (!selId) return null;
    // Prefer hydrated detail when available; otherwise fall back to the
    // card-shape from the list so the page renders during the in-flight GET.
    const matter = disputes.find(x => x.id === selId);
    if (detailRaw) {
      // Re-adapt with the richer payload so opponent/court/judge land.
      return { ...matter, ...selectDisputes([detailRaw])[0] };
    }
    return matter;
  }, [selId, disputes, detailRaw]);

  // Apply filters/search.
  const list = useMemo(() => {
    return disputes.filter(d => {
      if (instFilter !== 'all' && d.instance !== instFilter) return false;
      if (statusFilter === 'open' && d.outcome) return false;
      if (statusFilter === 'won' && d.outcome !== 'won') return false;
      if (statusFilter === 'settled' && d.outcome !== 'settled') return false;
      if (search.trim()) {
        const q = search.toLowerCase();
        const hay = [d.caseNumber, d.client, d.opponent, d.title, d.court, d.judge]
          .filter(Boolean).join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [disputes, instFilter, statusFilter, search]);

  // ----- Mutations (optimistic + rollback, mirror Practice.jsx) --------------

  const patchMatter = (id, patch) =>
    setMatters(ms => ms.map(m => m.id === id ? { ...m, ...patch } : m));

  const saveCourt = (id, form) => {
    const patch = {
      caseNumber: form.caseNumber || null,
      court: form.court || null,
      judge: form.judge || null,
      opponent: form.opponent || null,
      role: form.role === 'plf' ? 'Позивач' : 'Відповідач',
      instance: form.instance || 'first',
      claimAmount: form.claimAmount || null,
      nextHearing: form.nextHearing || null,
    };
    patchMatter(id, patch);
    setCourtOpen(false);
    setCourtTarget(null);
    api.matters.update(id, patch)
      .then(() => toast(t.lit_court_saved, 'check'))
      .catch(() => { toast(t.lit_court_saved, 'alert'); reloadMatters(); });
  };

  const confirmClose = ({ outcome, date }) => {
    if (!selId) return;
    const id = selId;
    patchMatter(id, { status: 'closed', outcome, closedAt: date });
    setCloseOpen(false);
    api.matters.update(id, { status: 'closed', outcome, closedAt: date })
      .then(() => toast(t.lit_dispute_closed, 'checkCircle'))
      .catch(() => { toast(t.lit_dispute_closed, 'alert'); reloadMatters(); });
  };

  const saveHearing = ({ date, title }) => {
    if (!selId) return;
    const id = selId;
    // Optimistic local update so the chronology grows immediately. The
    // server response will be folded back via the hearing.added realtime
    // event picked up by useMatterDetail.
    patchMatter(id, {
      nextHearing: date,
      hearings: [...(disputes.find(d => d.id === id)?.hearings || []), { date, title, upcoming: true }],
    });
    setHearingOpen(false);
    api.matters.addHearing(id, { date, title, label: title })
      .then(() => toast(t.lit_hearing_added, 'calendar'))
      .catch(() => { toast(t.lit_hearing_added, 'alert'); reloadMatters(); });
  };

  // ----- Detail view --------------------------------------------------------

  if (selId && selDispute) {
    return (
      <>
        <DisputeDetail
          d={selDispute}
          detail={detailRaw}
          t={t}
          setRoute={setRoute}
          onBack={() => setSelId(null)}
          onAddCourt={(disp) => { setCourtTarget(disp); setCourtOpen(true); }}
          onAddHearing={() => setHearingOpen(true)}
          onClose={() => setCloseOpen(true)}
        />
        <CourtRequisitesModal open={courtOpen} dispute={courtTarget} onClose={() => setCourtOpen(false)} onSave={saveCourt} t={t} />
        <CloseDisputeModal open={closeOpen} onClose={() => setCloseOpen(false)} onConfirm={confirmClose} t={t} />
        <AddHearingModal open={hearingOpen} onClose={() => setHearingOpen(false)} onSave={saveHearing} t={t} />
      </>
    );
  }

  // ----- List view ----------------------------------------------------------

  return (
    <div className="page view-enter">
      <div className="page-narrow">
        <div style={{ color: 'var(--text-2)', fontSize: 14, marginBottom: 'var(--s4)' }}>{t.lit_sub}</div>

        <KpiRow disputes={disputes} t={t} />

        <FiltersBar
          instFilter={instFilter} setInstFilter={setInstFilter}
          statusFilter={statusFilter} setStatusFilter={setStatusFilter}
          search={search} setSearch={setSearch}
          t={t}
        />

        {list.length === 0 ? (
          <div className="card mt-empty mt-empty-lg">
            <Icon name="gavel" size={32} />
            <div>{t.lit_empty}</div>
          </div>
        ) : (
          <div className="lit-grid lit-grid-list">
            {list.map(d => (
              <DisputeCard
                key={d.id}
                d={d}
                t={t}
                onOpen={() => setSelId(d.id)}
                onAddCourt={(disp) => { setCourtTarget(disp); setCourtOpen(true); }}
              />
            ))}
          </div>
        )}
      </div>

      <CourtRequisitesModal open={courtOpen} dispute={courtTarget} onClose={() => setCourtOpen(false)} onSave={saveCourt} t={t} />
    </div>
  );
}

export { Litigation };
