/* ============================================================
   EditableDoc — editable counterpart to MarkdownDoc.

   Same {number, title, text} section shape; the heading row is
   read-only and the body is a per-section auto-resizing textarea.
   The component is dumb — it never mutates its own sections array.
   Parent owns the state and receives the full updated array via
   `onChange(nextSections)` on every keystroke.

   Two optional hooks for the surrounding analysis screen:
     • flashIdx     — index of the section that should run the
                      green flash animation (Apply fix in edit mode)
     • scrollToIdx  — index of the section to scroll into view +
                      focus the textarea of (Add gap section)

   Used inside AnalysisView's editor-override slot when the user
   toggles to "Редагування" in the document toolbar.
   ============================================================ */
import { useEffect, useRef } from 'react';

function AutoTextarea({ value, onChange, onMount }) {
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
      ref={(el) => {
        ref.current = el;
        if (typeof onMount === 'function') onMount(el);
      }}
      className="md-edit-area"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      spellCheck={false}
      rows={1}
    />
  );
}

export function EditableDoc({ filename, sections, onChange, flashIdx, scrollToIdx }) {
  const list = Array.isArray(sections) ? sections : [];
  const sectionRefs = useRef([]);
  const textareaRefs = useRef([]);

  // Scroll the requested section into view + focus its textarea after
  // the new layout has settled. Caret lands at the start so the user
  // can start typing without first nuking the suggested clause text.
  useEffect(() => {
    if (scrollToIdx == null) return;
    const sec = sectionRefs.current[scrollToIdx];
    const ta = textareaRefs.current[scrollToIdx];
    if (sec && typeof sec.scrollIntoView === 'function') {
      sec.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    if (ta) {
      ta.focus();
      try { ta.setSelectionRange(0, 0); } catch (_e) { /* IE-style guard */ }
    }
  }, [scrollToIdx]);

  const updateAt = (i, newText) => {
    if (typeof onChange !== 'function') return;
    onChange(list.map((sec, j) => (j === i ? { ...sec, text: newText } : sec)));
  };

  return (
    <article className="md-doc md-doc-edit">
      {filename ? <h1 className="md-doc-title">{filename}</h1> : null}
      {list.map((s, i) => {
        const head = [s.number, s.title].filter(Boolean).join(' ');
        const cls = 'md-section md-section-edit' + (flashIdx === i ? ' flash' : '');
        return (
          <section
            ref={(el) => { sectionRefs.current[i] = el; }}
            className={cls}
            key={i}
          >
            {head ? (
              <h3 className="md-section-title md-section-title-edit">{head}</h3>
            ) : null}
            <AutoTextarea
              value={s.text || ''}
              onChange={(text) => updateAt(i, text)}
              onMount={(el) => { textareaRefs.current[i] = el; }}
            />
          </section>
        );
      })}
    </article>
  );
}
