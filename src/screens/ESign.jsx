/* ============================================================
   AG Lex — Electronic signature (Е-підпис) КЕП / Дія.Підпис
   ============================================================ */
import { useState, useEffect } from 'react';
import { Icon, Modal, SectionTitle, toast } from '../ui/components';
import { LX } from '../data/lx';

function SignModal({ doc, t, onClose, onSigned }) {
  const [method, setMethod] = useState('file');
  const [phase, setPhase] = useState('pick'); // pick | signing
  const methods = [['file', t.esignFile, 'doc'], ['dia', t.esignDia, 'pen'], ['token', t.esignToken, 'shield']];
  useEffect(() => {
    if (phase !== 'signing') return;
    const id = setTimeout(() => onSigned(doc), 1600);
    return () => clearTimeout(id);
  }, [phase]);

  return (
    <Modal open={!!doc} onClose={onClose} icon="pen" title={t.esignSignBtn} sub={doc ? doc.name : ''}
      footer={phase === 'pick' ? <>
        <button className="btn btn-subtle" onClick={onClose}>{t.esignCancel}</button>
        <button className="btn btn-primary" onClick={() => setPhase('signing')}><Icon name="pen" size={15} /> {t.esignSignBtn}</button>
      </> : null}>
      {phase === 'pick' ? (
        <div>
          <div className="dd-sec-h" style={{ marginBottom: 12 }}>{t.esignMethod}</div>
          <div className="esign-methods">
            {methods.map(([id, lbl, ic]) => (
              <button key={id} className={'esign-method' + (method === id ? ' on' : '')} onClick={() => setMethod(id)}>
                <span className="esign-method-ic"><Icon name={ic} size={18} /></span>
                <span style={{ fontWeight: 600, fontSize: 13.5 }}>{lbl}</span>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="esign-signing">
          <div className="dbuild-spark"><Icon name="pen" size={26} /></div>
          <div style={{ fontWeight: 700, fontSize: 17, marginTop: 14 }}>{t.esignSigning}</div>
          <div className="dbuild-prog" style={{ width: 'min(320px,90%)' }}><span style={{ width: '70%' }} /></div>
        </div>
      )}
    </Modal>
  );
}

function ESign({ t }) {
  const [docs, setDocs] = useState(() => LX.esignQueue.map(d => ({ ...d })));
  const [signing, setSigning] = useState(null);

  const pending = docs.filter(d => d.status === 'pending');
  const signed = docs.filter(d => d.status === 'signed');

  const onSigned = (doc) => {
    const now = new Date(), p = x => String(x).padStart(2, '0');
    const ts = `${p(now.getDate())}.${p(now.getMonth() + 1)}.${now.getFullYear()} ${p(now.getHours())}:${p(now.getMinutes())}`;
    const hash = Array.from({ length: 4 }, () => Math.random().toString(16).slice(2, 6).toUpperCase()).join('·');
    setDocs(ds => ds.map(d => d.id === doc.id ? { ...d, status: 'signed', signedAt: ts, hash, signer: 'Тестовий Користувач' } : d));
    setSigning(null);
    toast(t.esignDone, 'checkCircle');
  };

  const Row = (d) => (
    <div key={d.id} className="card esign-row">
      <span className="esign-ic"><Icon name="doc" size={17} /></span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 650, fontSize: 14 }}>{d.name}</div>
        <div style={{ fontSize: 12.5, color: 'var(--text-3)' }}>{d.client} · {d.date}</div>
        {d.status === 'signed' ? (
          <div className="esign-cert">
            <span><Icon name="checkCircle" size={13} /> {t.esignAt}: {d.signedAt}</span>
            <span>{t.esignWho}: {d.signer}</span>
            <span className="esign-hash">{t.esignHash}: {d.hash}</span>
          </div>
        ) : null}
      </div>
      {d.status === 'pending'
        ? <button className="btn btn-primary btn-sm" onClick={() => setSigning(d)}><Icon name="pen" size={14} /> {t.esignSignBtn}</button>
        : <span className="esign-badge"><Icon name="checkCircle" size={14} /> {t.esignSigned}</span>}
    </div>
  );

  return (
    <div className="page view-enter"><div className="page-narrow">
      <div style={{ color: 'var(--text-2)', fontSize: 14, marginBottom: 'var(--s5)' }}>{t.esignSub}</div>

      <SectionTitle>{t.esignPending} <span className="aitab-n">{pending.length}</span></SectionTitle>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>{pending.map(Row)}</div>

      {signed.length > 0 && (
        <>
          <SectionTitle action={null}><span style={{ marginTop: 'var(--s6)', display: 'block' }}>{t.esignSigned} <span className="aitab-n">{signed.length}</span></span></SectionTitle>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>{signed.map(Row)}</div>
        </>
      )}

      <SignModal doc={signing} t={t} onClose={() => setSigning(null)} onSigned={onSigned} />
    </div></div>
  );
}

export { ESign };
