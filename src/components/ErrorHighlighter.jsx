/* ============================================================
   AG Lex — Render a document with backend-inlined <mark> spans.
   The backend's GET /api/documents/{id}/highlighted already
   wraps each outstanding error in a <mark> with data-* attrs;
   we just render it as HTML and bind hover/dblclick handlers.

   Why dangerouslySetInnerHTML (vs a Markdown renderer):
   the project has no markdown library installed. The document text
   itself is user-uploaded (converter output can carry raw HTML), so
   it goes through sanitizeHighlighted first: everything is escaped
   except the exact <mark> shape the backend emits.
   ============================================================ */
import { useEffect, useRef } from 'react';
import { sanitizeHighlighted } from './sanitizeHighlighted';

export function ErrorHighlighter({ html, onErrorActivate }) {
  const containerRef = useRef(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;

    const findMark = (target) => target?.closest('[data-error-id]') || null;

    // Single click = no-op (the hover tooltip already shows context).
    // Double click = open the right-side detail panel.
    const handleDouble = (e) => {
      const mark = findMark(e.target);
      if (!mark) return;
      e.preventDefault();
      onErrorActivate?.(mark.dataset.errorId);
    };

    // Keyboard: Enter / Space when a mark has keyboard focus (we add
    // tabindex via CSS) — accessibility parity for the dblclick gesture.
    const handleKey = (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const mark = findMark(document.activeElement);
      if (!mark) return;
      e.preventDefault();
      onErrorActivate?.(mark.dataset.errorId);
    };

    el.addEventListener('dblclick', handleDouble);
    el.addEventListener('keydown', handleKey);
    return () => {
      el.removeEventListener('dblclick', handleDouble);
      el.removeEventListener('keydown', handleKey);
    };
  }, [onErrorActivate]);

  return (
    <div
      ref={containerRef}
      className="error-highlighter"
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: htmlToParagraphs(html) }}
    />
  );
}

// Cheap markdown → minimal HTML: paragraphs from blank-line splits, plus
// preserving the <mark> spans the backend already inlined. Real Markdown
// rendering (lists, tables, headings) lives further out — this component
// is intentionally minimal so it stays predictable for highlighted spans.
function htmlToParagraphs(src) {
  if (!src) return '';
  const blocks = sanitizeHighlighted(src).split(/\n{2,}/);
  return blocks
    .map((block) => {
      const trimmed = block.trim();
      if (!trimmed) return '';
      // Heading (## ...) — convert without going through a full MD parser.
      const h = trimmed.match(/^(#{1,4})\s+(.*)$/);
      if (h) {
        const level = h[1].length;
        return `<h${level} class="doc-h${level}">${h[2]}</h${level}>`;
      }
      // Plain paragraph: text is already escaped; only <mark> spans remain.
      return `<p class="doc-p">${trimmed.replace(/\n/g, '<br />')}</p>`;
    })
    .filter(Boolean)
    .join('\n');
}
