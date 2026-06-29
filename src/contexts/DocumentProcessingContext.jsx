/* ============================================================
   AG Lex — Document processing state, shared via React context.
   Any component running an upload/convert/OCR/analyze/apply-fix
   call wraps it with start/end so the exit guard can prompt
   before navigation drops mid-flight work.
   ============================================================ */
import { createContext, useCallback, useContext, useMemo, useState } from 'react';

const DocumentProcessingContext = createContext(null);

export const PROCESSING_LABELS = {
  upload: 'Завантаження файлу',
  conversion: 'Конвертація документа',
  ocr: 'Розпізнавання тексту (OCR)',
  analysis: 'Аналіз документа',
  fix: 'Застосування виправлення',
};

export function DocumentProcessingProvider({ children }) {
  // Active operations are stored as a Set in state — adding/removing creates
  // a new Set so React notices the change (mutating in place wouldn't trigger
  // a re-render).
  const [activeOperations, setActiveOperations] = useState(() => new Set());

  const startOperation = useCallback((name) => {
    setActiveOperations((prev) => {
      if (prev.has(name)) return prev;
      const next = new Set(prev);
      next.add(name);
      return next;
    });
  }, []);

  const endOperation = useCallback((name) => {
    setActiveOperations((prev) => {
      if (!prev.has(name)) return prev;
      const next = new Set(prev);
      next.delete(name);
      return next;
    });
  }, []);

  const isProcessing = activeOperations.size > 0;

  const value = useMemo(
    () => ({ isProcessing, activeOperations, startOperation, endOperation }),
    [isProcessing, activeOperations, startOperation, endOperation],
  );

  return (
    <DocumentProcessingContext.Provider value={value}>
      {children}
    </DocumentProcessingContext.Provider>
  );
}

export function useDocumentProcessing() {
  const ctx = useContext(DocumentProcessingContext);
  if (!ctx) {
    throw new Error(
      'useDocumentProcessing: <DocumentProcessingProvider> not mounted above caller.',
    );
  }
  return ctx;
}
