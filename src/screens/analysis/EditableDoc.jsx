/* ============================================================
   EditableDoc — editable counterpart to MarkdownDoc.

   Same {number, title, text} section shape; the heading row is
   read-only and the body is a per-section auto-resizing textarea.
   The component is dumb — it never mutates its own sections array.
   Parent owns the state and receives the full updated array via
   `onChange(nextSections)` on every keystroke.

   Used inside AnalysisView's editor-override slot when the user
   toggles to "Редагування" in the document toolbar.
   ============================================================ */
import { useEffect, useRef } from 'react';

function AutoTextarea({ value, onChange }) {
  const ref = useRef(null);

  // Drive height from scrollHeight so the textarea grows with content
  // and never shows its own scrollbar. Resets to 'auto' first so
  // shrinking on backspace also collapses the height.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
  }, [value]);

  return (
    <textarea
      ref={ref}
      className="md-edit-area"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      spellCheck={false}
      rows={1}
    />
  );
}

export function EditableDoc({ filename, sections, onChange }) {
  const list = Array.isArray(sections) ? sections : [];

  const updateAt = (i, newText) => {
    if (typeof onChange !== 'function') return;
    onChange(list.map((sec, j) => (j === i ? { ...sec, text: newText } : sec)));
  };

  return (
    <article className="md-doc md-doc-edit">
      {filename ? <h1 className="md-doc-title">{filename}</h1> : null}
      {list.map((s, i) => {
        const head = [s.number, s.title].filter(Boolean).join(' ');
        return (
          <section className="md-section md-section-edit" key={i}>
            {head ? (
              <h3 className="md-section-title md-section-title-edit">{head}</h3>
            ) : null}
            <AutoTextarea
              value={s.text || ''}
              onChange={(text) => updateAt(i, text)}
            />
          </section>
        );
      })}
    </article>
  );
}
