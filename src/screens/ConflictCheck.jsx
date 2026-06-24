// DEPRECATED — removed from navigation per refactor 2026-06
/* ============================================================
   AG Lex — Conflict of interest check (Конфлікт інтересів)
   ============================================================ */
import { useState } from 'react';
import { Icon } from '../ui/Icon';
import { LX } from '../data/lx';

function ConflictCheck({ t }) {
  const [q, setQ] = useState('');
  const [res, setRes] = useState(null);
  const [loading, setLoading] = useState(false);

  const run = (name) => {
    const term = (name == null ? q : name);
    if (!term.trim()) return;
    setQ(term); setRes(null); setLoading(true);
    setTimeout(() => {
      const lc = term.toLowerCase();
      const hits = LX.conflictsDB.filter(c => lc.includes(c.match));
      let level = 'clear', items = [];
      hits.forEach(h => { items = items.concat(h.items); if (h.level === 'block') level = 'block'; else if (level !== 'block') level = 'potential'; });
      setLoading(false); setRes({ level, items });
    }, 650);
  };

  const meta = {
    clear: { lbl: t.conflictClear, rec: t.conflictRecClear, col: 'var(--risk-low)', bg: 'var(--risk-low-soft)', ic: 'checkCircle' },
    potential: { lbl: t.conflictPotential, rec: t.conflictRecPotential, col: 'var(--risk-med)', bg: 'var(--risk-med-soft)', ic: 'alert' },
    block: { lbl: t.conflictBlock, rec: t.conflictRecBlock, col: 'var(--risk-high)', bg: 'var(--risk-high-soft)', ic: 'alert' },
  };

  return (
    <div className="page view-enter"><div className="page-narrow" style={{ maxWidth: 720 }}>
      <div style={{ color: 'var(--text-2)', fontSize: 14, marginBottom: 14 }}>{t.conflictSub}</div>
      <div style={{ display: 'flex', gap: 10 }}>
        <div className="search" style={{ flex: 1, maxWidth: 'none' }}>
          <Icon name="shield" size={17} />
          <input placeholder={t.conflictPlaceholder} value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') run(); }} />
        </div>
        <button className="btn btn-primary" onClick={() => run()} disabled={!q.trim() || loading}><Icon name="shield" size={16} /> {t.conflictCheck}</button>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12.5, color: 'var(--text-3)', alignSelf: 'center' }}>{t.conflictExamples}:</span>
        {LX.conflictSuggest.map(s => <button key={s} className="chip" style={{ cursor: 'pointer' }} onClick={() => run(s)}>{s}</button>)}
      </div>

      {loading ? <div className="card" style={{ padding: 'var(--s8)', marginTop: 'var(--s5)', textAlign: 'center', color: 'var(--text-3)' }}><span className="pulse" style={{ display: 'inline-block', marginRight: 8 }} /> {t.conflictCheck}…</div> : null}

      {res && (() => { const m = meta[res.level]; return (
        <div className="card view-enter" style={{ padding: 'var(--s5)', marginTop: 'var(--s5)' }}>
          <div className="conf-result" style={{ background: m.bg }}>
            <span className="conf-ic" style={{ color: m.col }}><Icon name={m.ic} size={22} /></span>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 700, fontSize: 17, color: m.col }}>{m.lbl}</div>
              <div style={{ fontSize: 13.5, color: 'var(--text-2)', marginTop: 2 }}>{m.rec}</div>
            </div>
          </div>
          {res.items.length > 0 ? (
            <div style={{ marginTop: 'var(--s4)' }}>
              <div className="dd-sec-h" style={{ marginBottom: 10 }}>{t.conflictMatches}</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {res.items.map((it, i) => (
                  <div key={i} className="conf-match">
                    <span className="conf-match-ic"><Icon name="building" size={15} /></span>
                    <div><div style={{ fontWeight: 650, fontSize: 14 }}>{it.name}</div><div style={{ fontSize: 12.5, color: 'var(--text-3)' }}>{it.relation}</div></div>
                  </div>
                ))}
              </div>
            </div>
          ) : <div style={{ marginTop: 'var(--s4)', fontSize: 13.5, color: 'var(--text-3)' }}>{t.conflictNone}</div>}
        </div>
      ); })()}
    </div></div>
  );
}

// DEPRECATED — removed from navigation per refactor 2026-06
// export { ConflictCheck };
