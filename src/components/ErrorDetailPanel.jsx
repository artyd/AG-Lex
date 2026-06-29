/* ============================================================
   AG Lex — Right-pane detail view for a single document_error.
   Loads the row on mount, then either shows the proposed
   replacement (with "Apply" button) or — after apply — the
   computed word-level diff returned by the backend.
   ============================================================ */
import { useEffect, useState } from 'react';
import { Icon } from '../ui/Icon';
import { api } from '../lib/api';
import { useDocumentProcessing } from '../contexts/DocumentProcessingContext';

const TYPE_LABELS = {
  grammar: 'Граматика',
  legal: 'Юридична помилка',
  formatting: 'Форматування',
  terminology: 'Термінологія',
  compliance: 'Відповідність',
};

const SEVERITY_LABELS = {
  critical: { label: 'Критично', tone: 'high' },
  warning: { label: 'Попередження', tone: 'med' },
  suggestion: { label: 'Рекомендація', tone: 'low' },
};

export function ErrorDetailPanel({ documentId, errorId, onFixApplied, onClose }) {
  const [error, setError] = useState(null);
  const [diff, setDiff] = useState(null);
  const [isApplying, setIsApplying] = useState(false);
  const [loadErr, setLoadErr] = useState(null);
  const { startOperation, endOperation } = useDocumentProcessing();

  useEffect(() => {
    if (!errorId || !documentId) {
      setError(null);
      setDiff(null);
      setLoadErr(null);
      return undefined;
    }
    let cancelled = false;
    setError(null);
    setDiff(null);
    setLoadErr(null);
    api.documents.error(documentId, errorId)
      .then((row) => { if (!cancelled) setError(row); })
      .catch((e) => { if (!cancelled) setLoadErr(e?.message || 'Не вдалося завантажити помилку.'); });
    return () => { cancelled = true; };
  }, [documentId, errorId]);

  if (!errorId) {
    return (
      <div className="error-panel error-panel-empty">
        <Icon name="info" size={28} />
        <p>Двічі клацніть на виділеному тексті, щоб переглянути деталі помилки.</p>
      </div>
    );
  }

  if (loadErr) {
    return (
      <div className="error-panel error-panel-empty">
        <p style={{ color: 'var(--risk-high)' }}>{loadErr}</p>
      </div>
    );
  }

  if (!error) {
    return (
      <div className="error-panel error-panel-empty">
        <Icon name="refresh" size={20} />
        <p>Завантаження…</p>
      </div>
    );
  }

  const sev = SEVERITY_LABELS[error.severity] || SEVERITY_LABELS.suggestion;
  const typeLabel = TYPE_LABELS[error.error_type] || error.error_type;

  const applyFix = async () => {
    setIsApplying(true);
    startOperation('fix');
    try {
      const res = await api.documents.applyFix(documentId, errorId);
      setDiff(res.diff || []);
      setError((prev) => prev ? { ...prev, is_applied: true } : prev);
      onFixApplied?.(errorId);
    } catch (e) {
      setLoadErr(e?.message || 'Не вдалося застосувати виправлення.');
    } finally {
      setIsApplying(false);
      endOperation('fix');
    }
  };

  return (
    <div className="error-panel">
      <div className="error-panel-head">
        <span className="error-panel-type">{typeLabel}</span>
        <span className={`error-panel-sev error-panel-sev-${sev.tone}`}>{sev.label}</span>
        {onClose ? (
          <button type="button" className="icon-btn error-panel-close" aria-label="Закрити" onClick={onClose}>
            <Icon name="x" size={14} />
          </button>
        ) : null}
      </div>

      <section className="error-panel-sect">
        <h4>Фрагмент</h4>
        <blockquote className="error-panel-excerpt">{error.text_excerpt}</blockquote>
      </section>

      <section className="error-panel-sect">
        <h4>Проблема</h4>
        <p>{error.explanation}</p>
      </section>

      <section className="error-panel-sect">
        <h4>Рекомендація</h4>
        <p>{error.suggestion}</p>
      </section>

      {diff ? (
        <section className="error-panel-sect">
          <h4>Застосовані зміни</h4>
          <div className="diff-view">
            {diff.map((chunk, i) => (
              <span key={i} className={`diff-chunk diff-chunk-${chunk.type}`}>
                {chunk.text}{' '}
              </span>
            ))}
          </div>
          <p className="error-panel-applied">
            <Icon name="check" size={14} stroke={3} /> Виправлення застосовано.
          </p>
        </section>
      ) : (
        <section className="error-panel-sect">
          <h4>Запропоноване виправлення</h4>
          <div className="error-panel-replacement">{error.replacement}</div>
          <button
            type="button"
            className="btn btn-primary"
            onClick={applyFix}
            disabled={isApplying || error.is_applied}
          >
            {isApplying
              ? (<><Icon name="refresh" size={14} /> Застосовую…</>)
              : (<><Icon name="check" size={14} stroke={2.6} /> Застосувати зміни</>)}
          </button>
        </section>
      )}
    </div>
  );
}
