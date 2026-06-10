/* ============================================================
   AG Lex — Client portal (Клієнтський портал) — client-side view
   ============================================================ */
import { useState } from 'react';
import { Icon, toast } from '../ui/components';
import { LX } from '../data/lx';

function ClientPortal({ t }) {
  const P = LX.portal;
  const invMeta = { paid: ['var(--risk-low)', t.portalPaid], sent: ['var(--risk-med)', t.portalSent] };

  return (
    <div className="page view-enter"><div className="page-narrow">
      <div style={{ color: 'var(--text-2)', fontSize: 14, marginBottom: 'var(--s4)' }}>{t.portalSub}</div>

      <div className="portal-frame">
        <div className="portal-bar">
          <span className="portal-dot" /><span className="portal-dot" /><span className="portal-dot" />
          <span className="portal-url">portal.aglex.ua · {P.client}</span>
          <span className="portal-tag">{t.portalAsClient}</span>
        </div>
        <div className="portal-body">
          <div className="portal-hello">
            <div>
              <div style={{ fontSize: 12.5, color: 'var(--text-3)' }}>{t.welcomeBack || 'Вітаємо'},</div>
              <div style={{ fontSize: 20, fontWeight: 700, letterSpacing: '-0.02em' }}>{P.client}</div>
            </div>
            <div className="brand-mark" style={{ width: 38, height: 38, fontSize: 13 }}>AG</div>
          </div>

          <div className="portal-grid">
            <div className="portal-card">
              <div className="portal-card-h">{t.portalMatters}</div>
              {P.matters.map((m, i) => (
                <div key={i} className="portal-matter">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                    <span style={{ fontWeight: 650, fontSize: 14 }}>{m.title}</span>
                    <span className="chip" style={{ fontSize: 11 }}>{m.status}</span>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-3)', margin: '3px 0 9px' }}>{m.code}</div>
                  <div className="portal-prog"><span style={{ width: m.progress + '%' }} /></div>
                </div>
              ))}
            </div>

            <div className="portal-card">
              <div className="portal-card-h">{t.portalDocs}</div>
              {P.docs.map((d, i) => (
                <div key={i} className="portal-row">
                  <span className="portal-row-ic"><Icon name="doc" size={15} /></span>
                  <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontWeight: 600, fontSize: 13.5 }}>{d.name}</div><div style={{ fontSize: 12, color: d.status === 'toSign' ? 'var(--risk-med)' : 'var(--text-3)' }}>{d.sub}</div></div>
                  {d.status === 'toSign'
                    ? <button className="btn btn-primary btn-sm" onClick={() => toast(t.esignDone, 'checkCircle')}><Icon name="pen" size={13} /> {t.portalSign}</button>
                    : <button className="btn btn-ghost btn-sm" onClick={() => toast(d.name, 'doc')}>{t.portalView}</button>}
                </div>
              ))}
            </div>

            <div className="portal-card">
              <div className="portal-card-h">{t.portalInvoices}</div>
              {P.invoices.map((inv, i) => {
                const [col, lbl] = invMeta[inv.status];
                return (
                  <div key={i} className="portal-row">
                    <span style={{ fontWeight: 700, fontSize: 13.5, width: 56 }}>{inv.num}</span>
                    <div style={{ flex: 1 }}><div style={{ fontSize: 12.5 }}>{inv.period}</div><div style={{ fontSize: 12, color: 'var(--text-3)' }}>{inv.amount}</div></div>
                    <span style={{ fontSize: 12.5, fontWeight: 600, color: col }}>{lbl}</span>
                  </div>
                );
              })}
            </div>

            <div className="portal-card">
              <div className="portal-card-h">{t.portalMessages}</div>
              <div className="portal-msgs">
                {P.messages.map((m, i) => (
                  <div key={i} className={'portal-msg' + (m.me ? ' me' : '')}>
                    <div className="portal-msg-from">{m.from} · {m.time}</div>
                    <div className="portal-msg-tx">{m.text}</div>
                  </div>
                ))}
              </div>
              <div className="portal-compose">
                <input placeholder={t.addComment || 'Повідомлення…'} readOnly />
                <button className="btn btn-primary btn-sm" onClick={() => toast(t.portalSend, 'send')}><Icon name="send" size={14} /></button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div></div>
  );
}

export { ClientPortal };
