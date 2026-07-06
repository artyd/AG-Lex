/* ============================================================
   EditableDoc — full-document markdown editor.

   Один непрерывный CodeMirror 6 редактор поверх всего договора.
   Секции больше не рендерятся отдельными textarea — вся правка
   идёт по markdown-строке. Синтаксис (заголовки, жирный, курсив,
   списки) подсвечивается через lezer-теги, но контент остаётся
   raw-markdown — экспорт .md совпадает с тем, что видит юрист.

   Props:
     markdown       — string, живой source of truth
     onChange(md)   — вызывается при каждом изменении дока
     flashRange     — { from, to } | null, зелёная вспышка на диапазоне
                      (используется после AI-виправлення / apply-fix)
     scrollToPos    — number | null, скроллит редактор к позиции и
                      фокусирует его (используется после Додати розділ)
     filename       — string, заголовок над редактором
   ============================================================ */
import { useEffect, useRef } from 'react';
import { EditorState, StateEffect, StateField } from '@codemirror/state';
import { EditorView, keymap, Decoration } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

/* --- Flash decoration ---
   AI-виправлення / Apply вставляет suggest.to в документ; после этого
   мы кидаем StateEffect с диапазоном, StateField превращает его в
   MarkDecoration с классом .aglex-flash. Через 1.2s юрист-CSS-анимация
   растворяет заливку — юрист видит, ЧТО именно изменилось, но фон
   уходит и не мешает читать дальше. Отдельный clearFlash — на случай
   когда родитель сбросил flashRange в null раньше времени. */
const addFlash = StateEffect.define();
const clearFlash = StateEffect.define();

const flashField = StateField.define({
  create() { return Decoration.none; },
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(addFlash)) {
        const { from, to } = e.value;
        if (to > from) {
          deco = Decoration.set([
            Decoration.mark({ class: 'aglex-flash' }).range(from, to),
          ]);
        }
      } else if (e.is(clearFlash)) {
        deco = Decoration.none;
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/* --- Theme ---
   Все цвета/размеры — через существующие CSS custom properties, так что
   [data-theme=light|dark] переключение на root'е перекрашивает редактор
   без отдельной dark-темы. */
const aglexTheme = EditorView.theme({
  '&': {
    fontFamily: 'var(--font-doc)',
    fontSize: '15px',
    backgroundColor: 'var(--surface)',
    color: 'var(--text)',
    height: 'auto',
  },
  '&.cm-editor.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'inherit',
    lineHeight: '1.65',
    overflow: 'visible',
  },
  '.cm-content': {
    caretColor: 'var(--accent)',
    padding: 'var(--s5) var(--s6)',
  },
  '.cm-line': { padding: '0' },
  '&.cm-focused .cm-selectionBackground, ::selection, .cm-selectionBackground': {
    backgroundColor: 'color-mix(in oklab, var(--accent) 22%, transparent)',
  },
});

/* --- Syntax highlighting ---
   Минимальный набор — это редактор договора, не IDE. Заголовки
   визуально крупнее, но остаются частью inline-текста (не превращаются
   в отдельные блоки), чтобы редактирование через границу «## заголовок
   ↔ параграф» не глючило с каретом. */
const aglexHighlight = HighlightStyle.define([
  { tag: t.heading1, fontSize: '19px', fontWeight: '700', color: 'var(--accent)' },
  { tag: t.heading2, fontSize: '17px', fontWeight: '700', color: 'var(--accent)' },
  { tag: t.heading3, fontSize: '15.5px', fontWeight: '650', color: 'var(--text)' },
  { tag: t.heading4, fontSize: '14.5px', fontWeight: '650', color: 'var(--text-2)' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through', color: 'var(--text-3)' },
  { tag: t.link, color: 'var(--accent)', textDecoration: 'underline' },
  { tag: t.monospace, fontFamily: 'ui-monospace, SFMono-Regular, monospace', backgroundColor: 'var(--surface-2)', padding: '0 4px', borderRadius: '3px' },
  { tag: t.quote, color: 'var(--text-2)', fontStyle: 'italic' },
  { tag: t.list, color: 'var(--text-2)' },
  { tag: t.processingInstruction, color: 'var(--text-3)' }, // "##" маркеры заголовков
  { tag: t.contentSeparator, color: 'var(--text-3)' },      // "---" горизонт. линия
]);

export function EditableDoc({ markdown: md, onChange, flashRange, scrollToPos, filename }) {
  const hostRef = useRef(null);
  const viewRef = useRef(null);
  // Держим последнее содержимое, которое сам редактор породил через
  // updateListener. Нужно, чтобы отличать «пришёл новый markdown извне»
  // (после upload / apply-fix / library-reopen) от «пользователь просто
  // печатает». В первом случае — перезаливаем doc в CM, во втором —
  // ничего не делаем, каретка остаётся где была.
  const lastEmittedRef = useRef('');

  useEffect(() => {
    if (!hostRef.current) return;
    const initial = md || '';
    lastEmittedRef.current = initial;
    const state = EditorState.create({
      doc: initial,
      extensions: [
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        markdown(),
        syntaxHighlighting(aglexHighlight),
        EditorView.lineWrapping,
        aglexTheme,
        flashField,
        EditorView.updateListener.of((v) => {
          if (!v.docChanged) return;
          const next = v.state.doc.toString();
          lastEmittedRef.current = next;
          if (typeof onChange === 'function') onChange(next);
        }),
      ],
    });
    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // маунтим один раз — CodeMirror сам управляет своим lifecycle

  // Внешний prop.markdown → replace doc, если это не то, что мы только
  // что эмитили сами.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const next = md || '';
    if (next === lastEmittedRef.current) return;
    const current = view.state.doc.toString();
    if (next === current) return;
    view.dispatch({
      changes: { from: 0, to: current.length, insert: next },
    });
    lastEmittedRef.current = next;
  }, [md]);

  // Вспышка на диапазоне.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (!flashRange) {
      view.dispatch({ effects: clearFlash.of() });
      return;
    }
    const docLen = view.state.doc.length;
    const from = Math.max(0, Math.min(flashRange.from ?? 0, docLen));
    const to = Math.max(from, Math.min(flashRange.to ?? from, docLen));
    if (to === from) return;
    view.dispatch({ effects: addFlash.of({ from, to }) });
  }, [flashRange]);

  // Скролл + фокус к позиции (после Додати розділ).
  useEffect(() => {
    const view = viewRef.current;
    if (!view || scrollToPos == null) return;
    const docLen = view.state.doc.length;
    const pos = Math.max(0, Math.min(scrollToPos, docLen));
    view.dispatch({
      selection: { anchor: pos, head: pos },
      effects: EditorView.scrollIntoView(pos, { y: 'center' }),
    });
    view.focus();
  }, [scrollToPos]);

  return (
    <article className="md-doc md-doc-edit">
      {filename ? <h1 className="md-doc-title">{filename}</h1> : null}
      <div ref={hostRef} className="cm-host" />
    </article>
  );
}
