/* ============================================================
   AG Lex — Document review / e-discovery (Перегляд)
   AI-tagged document set: relevance, privilege, responsiveness.
   ============================================================ */
import { useState } from 'react';
import { Icon, toast } from '../ui/components';
import { LX } from '../data/lx';

function DocReview({ t }) {
  const [docs, setDocs] = useState(() => LX.review.map(d => ({ ...d })));
  const [filter, setFilter] = useState('all');

  const relMap = { relevant: [t.revRelevant, 'var(--risk-low)', 'var(--risk-low-soft)'], maybe: [t.revMaybe, 'var(--risk-med)', 'var(--risk-med-soft)'], no: [t.revNo, 'var(--text-3)', 'var(--bg-2)'] };
  const relevant = docs.filter(d => d.relevance === 'relevant').length;
  const privileged = docs.filter(d => d.privilege).length;
  const toReview = docs.filter(d => !d.reviewed).length;

  const filters = [['all', t.revAll, docs.length], ['relevant', t.revRelevant, relevant], ['priv', t.revPrivileged, privileged], ['unrev', t.revToReview, toReview]];
  const shown = docs.filter(d => filter === 'all' ? true : filter === 'relevant' ? d.relevance === 'relevant' : filter === 'priv' ? d.privilege : !d.reviewed);

  const toggle = (id) => setDocs(ds => ds.map(d => {
    if (d.id !== id) return d;
    if (!d.reviewed) toast(t.revMarked, 'check');
    return { ...d, reviewed: !d.reviewed };
  }));

  const stats = [[t.revRelevant, relevant, 'var(--risk-low)'], [t.revPrivileged, privileged, 'var(--risk-high)'], [t.revToReview, toReview, 'var(--risk-med)'], [t.revAll, docs.length, 'var(--text-2)']];

  return (
    <div className="page view-enter"><div className="page-narrow">
      <div style={{ color: 'var(--text-2)', fontSize: 14, marginBottom: 'var(--s4)' }}>{t.reviewSub}</div>

      <div className="rev-stats">
        {stats.map(([l, n, col], i) => (
          <div key={i} className="rev-stat">
            <span className="rev-stat-n" style={{ color: col }}>{n}</span>
            <span className="rev-stat-l">{l}</span>
          </div>
        ))}
      </div>

      <div className="seg" style={{ width: 'fit-content', margin: 'var(--s5) 0 var(--s4)' }}>
        {filters.map(([id, l, n]) => (
          <button key={id} className={filter === id ? 'on' : ''} onClick={() => setFilter(id)}>{l} <span className="aitab-n">{n}</span></button>
        ))}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
        {shown.map(d => {
          const [rl, rc, rbg] = relMap[d.relevance];
          return (
            <div key={d.id} className={'card rev-row' + (d.reviewed ? ' reviewed' : '')}>
              <button className={'rev-check' + (d.reviewed ? ' on' : '')} onClick={() => toggle(d.id)} title={t.revMark}><Icon name="check" size={14} stroke={3} /></button>
              <span className="rev-ic"><Icon name="doc" size={17} /></span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontWeight: 650, fontSize: 14 }}>{d.name}</span>
                  <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{d.kind} · {d.date}</span>
                </div>
                <div className="rev-snippet">{d.snippet}</div>
                <div className="rev-tags">
                  <span className="rev-tag" style={{ color: rc, background: rbg }}>{rl}</span>
                  {d.responsive ? <span className="rev-tag rev-tag-line">{t.revResponsive}</span> : null}
                  {d.privilege ? <span className="rev-tag rev-tag-priv"><Icon name="alert" size={11} /> {t.revPrivilege}</span> : null}
                  {d.reviewed ? <span className="rev-tag rev-tag-done"><Icon name="checkCircle" size={11} /> {t.revReviewed}</span> : null}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div></div>
  );
}

export { DocReview };
