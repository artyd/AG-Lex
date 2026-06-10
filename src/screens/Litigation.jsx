/* ============================================================
   AG Lex — Litigation workspace (Спори)
   Case chronology, procedural-deadline calculator, pleadings.
   ============================================================ */
import { useState } from 'react';
import { Icon, SectionTitle, toast } from '../ui/components';
import { DEMO } from '../data/demo';
import { LX } from '../data/lx';

const LIT_EV_ICON = { claim: 'alert', doc: 'doc', filed: 'scales', hearing: 'calendar' };

function Litigation({ t, setRoute }) {
  const L = LX.litigation;
  const c = L.case;
  const [ruleId, setRuleId] = useState(L.rules[0].id);
  const [from, setFrom] = useState(c.nextHearing);
  const [added, setAdded] = useState(false);
  const rule = L.rules.find(r => r.id === ruleId);

  const baseDate = from ? new Date(from) : null;
  const result = baseDate && !isNaN(baseDate) ? new Date(baseDate.getTime() + rule.days * 86400000) : null;
  const fmt = (d) => d ? d.toLocaleDateString('uk-UA', { day: '2-digit', month: 'long', year: 'numeric' }) : '—';
  const iso = (d) => d.toISOString().slice(0, 10);

  const addCal = () => {
    if (!result) return;
    const id = 'lit-' + ruleId + '-' + iso(result);
    if (!DEMO.tasks.find(x => x.id === id))
      DEMO.tasks.push({ id, date: iso(result), title: rule.label + ' — справа ' + c.number, client: 'ОСББ «Зарічне»', type: 'deadline', risk: 'high' });
    setAdded(true); toast(t.litAddedCal, 'calendar');
    setTimeout(() => setAdded(false), 1600);
  };

  const stChip = { done: ['stDone', 'var(--risk-low)'], draft: ['stDraft', 'var(--risk-med)'], planned: ['stPlanned', 'var(--text-3)'] };

  return (
    <div className="page view-enter"><div className="page-narrow">
      <div style={{ color: 'var(--text-2)', fontSize: 14, marginBottom: 'var(--s4)' }}>{t.litSub}</div>

      <div className="card lit-head">
        <span className="matter-av" style={{ background: 'var(--accent)' }}><Icon name="scales" size={22} /></span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span className="chip">{c.code}</span><span className="chip">{t.litCaseNo} {c.number}</span>
            <span className="chip" style={{ color: 'var(--risk-high)' }}>{c.role}</span>
          </div>
          <h1 style={{ margin: '8px 0 2px', fontSize: 21, fontWeight: 700, letterSpacing: '-0.02em' }}>{c.title}</h1>
          <div className="lit-meta">
            <span><b>{t.litCourt}:</b> {c.court}</span>
            <span><b>{t.litJudge}:</b> {c.judge}</span>
            <span><b>{t.litStage}:</b> {c.stage}</span>
            <span><b>{t.litAmount}:</b> {c.amount}</span>
          </div>
        </div>
      </div>

      <div className="lit-grid">
        <div className="card" style={{ padding: 'var(--s5)' }}>
          <SectionTitle>{t.litTimeline}</SectionTitle>
          <div className="lit-tl">
            {L.timeline.map((e, i) => (
              <div key={i} className={'lit-tl-row' + (e.upcoming ? ' upcoming' : '')}>
                <span className="lit-tl-dot"><Icon name={LIT_EV_ICON[e.type] || 'doc'} size={13} /></span>
                <div className="lit-tl-body">
                  <div className="lit-tl-date">{new Date(e.date).toLocaleDateString('uk-UA', { day: '2-digit', month: 'long', year: 'numeric' })}{e.upcoming ? ' · ' + t.litNextHearing : ''}</div>
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
                {L.rules.map(r => <option key={r.id} value={r.id}>{r.label} ({r.days} {t.litDays})</option>)}
              </select>
            </label>
            <label className="field-row" style={{ marginTop: 12 }}><span className="field-label">{t.litFrom}</span>
              <input type="date" className="field" value={from} onChange={e => setFrom(e.target.value)} />
            </label>
            <div className="lit-result">
              <div>
                <div className="lit-result-l">{t.litResult} · +{rule.days} {t.litDays}</div>
                <div className="lit-result-v">{fmt(result)}</div>
              </div>
              <button className={'btn btn-sm ' + (added ? 'btn-ghost' : 'btn-primary')} onClick={addCal} disabled={!result}>
                <Icon name={added ? 'check' : 'calendar'} size={15} /> {t.addToCal}
              </button>
            </div>
          </div>

          <div className="card" style={{ padding: 'var(--s5)' }}>
            <SectionTitle>{t.litDocs}</SectionTitle>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {L.pleadings.map(p => {
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
    </div></div>
  );
}

export { Litigation };
