/* ============================================================
   AG Lex — Modal shown when the user tries to leave a screen while
   a document operation (upload/convert/OCR/analyze/apply-fix) is
   running. Rendered via portal so it overlays everything else.
   ============================================================ */
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../ui/Icon';
import { PROCESSING_LABELS } from '../contexts/DocumentProcessingContext';

export function ExitGuardModal({ isOpen, operationNames, onStay, onLeave }) {
  const stayBtnRef = useRef(null);

  // Lock background scroll while the modal is up.
  useEffect(() => {
    if (!isOpen) return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [isOpen]);

  // Focus the "stay" button by default — that's the safe choice.
  useEffect(() => {
    if (isOpen && stayBtnRef.current) {
      stayBtnRef.current.focus();
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const ops = Array.isArray(operationNames) ? operationNames : [];

  return createPortal(
    <div
      className="exit-guard-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="exit-guard-title"
    >
      <div
        className="exit-guard-backdrop"
        onClick={onStay}
        aria-hidden="true"
      />
      <div className="exit-guard-dialog">
        <div className="exit-guard-icon" aria-hidden="true">
          <Icon name="alert" size={36} />
        </div>
        <h2 id="exit-guard-title" className="exit-guard-title">
          Вийти зі сторінки?
        </h2>
        <p className="exit-guard-description">
          Обробка документа ще триває. Якщо ви вийдете — всі незбережені зміни
          та результати поточної операції будуть втрачені.
        </p>
        {ops.length > 0 ? (
          <div className="exit-guard-operations" aria-label="Активні операції">
            {ops.map((op) => (
              <span key={op} className="exit-guard-op-badge">
                {PROCESSING_LABELS[op] || op}
              </span>
            ))}
          </div>
        ) : null}
        <div className="exit-guard-actions">
          <button
            ref={stayBtnRef}
            type="button"
            className="btn btn-subtle"
            onClick={onStay}
          >
            Залишитись
          </button>
          <button
            type="button"
            className="btn btn-danger"
            onClick={onLeave}
          >
            Вийти
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
