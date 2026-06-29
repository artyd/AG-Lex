/* ============================================================
   AG Lex — DocumentViewer screen.
   Uploads, converts via the Node.js converter, lets the user run
   Claude error analysis, and renders the document with inline
   highlighted errors + a right-side detail panel.
   ============================================================ */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '../ui/Icon';
import { toast } from '../ui/components';
import { api, ApiError } from '../lib/api';
import { useDocumentProcessing } from '../contexts/DocumentProcessingContext';
import { ErrorHighlighter } from '../components/ErrorHighlighter';
import { ErrorDetailPanel } from '../components/ErrorDetailPanel';

const ACCEPT = '.pdf,.docx,.doc,.xlsx,.xls,.csv,.txt,.md';

export function DocumentViewer() {
  const fileRef = useRef(null);
  const [doc, setDoc] = useState(null);           // { id, filename, title, format, word_count, pages }
  const [html, setHtml] = useState('');           // highlighted markdown (with <mark> spans)
  const [errors, setErrors] = useState([]);       // outstanding errors
  const [activeErrorId, setActiveErrorId] = useState(null);
  const [phase, setPhase] = useState('idle');     // idle | uploading | uploaded | analyzing | done | error
  const [phaseMsg, setPhaseMsg] = useState('');
  const { startOperation, endOperation } = useDocumentProcessing();

  const refreshHighlighted = useCallback(async (docId) => {
    const res = await api.documents.highlighted(docId);
    setHtml(res.content || '');
    setErrors(Array.isArray(res.errors) ? res.errors : []);
    return res;
  }, []);

  const onPickFile = () => fileRef.current?.click();

  const onFileChange = async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;

    setPhase('uploading');
    setPhaseMsg('Завантаження та конвертація…');
    startOperation('upload');
    try {
      const res = await api.documents.upload(file);
      setDoc(res);
      // Highlighted endpoint returns plain content when no errors exist yet,
      // which is exactly what we want before analysis runs.
      await refreshHighlighted(res.id);
      setPhase('uploaded');
      setPhaseMsg('');
      toast('Документ готовий — натисніть «Аналізувати» для пошуку помилок.', 'sparkle');
    } catch (err) {
      setPhase('error');
      if (!(err instanceof ApiError && err.status === 401)) {
        const msg = err?.message || 'Не вдалося завантажити файл.';
        setPhaseMsg(msg);
        toast(msg, 'alert');
      }
    } finally {
      endOperation('upload');
    }
  };

  const runAnalysis = async () => {
    if (!doc) return;
    setPhase('analyzing');
    setPhaseMsg('Аналізую документ…');
    startOperation('analysis');
    try {
      const res = await api.documents.analyze(doc.id);
      await refreshHighlighted(doc.id);
      const count = Number(res?.errors_inserted || 0);
      setPhase('done');
      setPhaseMsg(count > 0
        ? `Знайдено ${count} ${pluralUk(count)}.`
        : 'Помилок не знайдено — документ чистий.');
      toast(count > 0
        ? `Знайдено ${count} ${pluralUk(count)} у документі.`
        : 'Помилок не знайдено.', 'sparkle');
    } catch (err) {
      setPhase('error');
      const msg = err?.message || 'Не вдалося проаналізувати документ.';
      setPhaseMsg(msg);
      toast(msg, 'alert');
    } finally {
      endOperation('analysis');
    }
  };

  const onErrorActivate = useCallback((errorId) => {
    setActiveErrorId(errorId);
  }, []);

  const onFixApplied = useCallback(async () => {
    if (!doc) return;
    await refreshHighlighted(doc.id);
    setActiveErrorId(null);
  }, [doc, refreshHighlighted]);

  // Severity counts for the toolbar tally.
  const counts = errors.reduce((acc, e) => {
    acc[e.severity] = (acc[e.severity] || 0) + 1;
    return acc;
  }, {});

  return (
    <div className="docview">
      <div className="docview-toolbar">
        <input
          ref={fileRef}
          type="file"
          accept={ACCEPT}
          style={{ display: 'none' }}
          onChange={onFileChange}
        />
        <button
          type="button"
          className="btn btn-subtle"
          onClick={onPickFile}
          disabled={phase === 'uploading' || phase === 'analyzing'}
        >
          <Icon name="upload" size={14} /> {doc ? 'Інший документ' : 'Завантажити документ'}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={runAnalysis}
          disabled={!doc || phase === 'analyzing' || phase === 'uploading'}
        >
          {phase === 'analyzing'
            ? (<><Icon name="refresh" size={14} /> Аналізую…</>)
            : (<><Icon name="sparkle" size={14} fill /> Аналізувати документ</>)}
        </button>
        {doc ? (
          <div className="docview-meta">
            <span><Icon name="doc" size={13} /> {doc.title}</span>
            <span>·</span>
            <span>{doc.format?.toUpperCase()}</span>
            {doc.word_count ? (<><span>·</span><span>{doc.word_count} сл.</span></>) : null}
            {doc.pages ? (<><span>·</span><span>{doc.pages} стор.</span></>) : null}
          </div>
        ) : null}
        {errors.length > 0 ? (
          <div className="docview-counts" aria-label="Знайдено помилок">
            {counts.critical ? (<span className="docview-count docview-count-critical">{counts.critical} критично</span>) : null}
            {counts.warning ? (<span className="docview-count docview-count-warning">{counts.warning} попереджень</span>) : null}
            {counts.suggestion ? (<span className="docview-count docview-count-suggestion">{counts.suggestion} рекомендацій</span>) : null}
          </div>
        ) : null}
      </div>

      {phaseMsg ? (
        <div className={`docview-banner docview-banner-${phase}`}>
          {(phase === 'uploading' || phase === 'analyzing') ? <Icon name="refresh" size={14} /> : null}
          <span>{phaseMsg}</span>
        </div>
      ) : null}

      <div className="docview-body">
        <div className="docview-main">
          {doc ? (
            <ErrorHighlighter html={html} onErrorActivate={onErrorActivate} />
          ) : (
            <div className="docview-empty">
              <Icon name="upload" size={28} />
              <h3>Завантажте документ</h3>
              <p>
                Підтримуються DOCX, DOC, PDF (з текстом або сканований), XLSX, XLS, CSV, TXT, MD.
                Після завантаження натисніть «Аналізувати документ», щоб AI знайшов помилки.
              </p>
            </div>
          )}
        </div>

        <aside className="docview-aside">
          <ErrorDetailPanel
            documentId={doc?.id}
            errorId={activeErrorId}
            onFixApplied={onFixApplied}
            onClose={() => setActiveErrorId(null)}
          />
        </aside>
      </div>
    </div>
  );
}

function pluralUk(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'помилка';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'помилки';
  return 'помилок';
}
