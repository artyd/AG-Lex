/* ============================================================
   MilkdownEditor — WYSIWYG контракта в стиле Google Docs.

   Drop-in замена EditableDoc.jsx с идентичной сигнатурой prop'ов,
   плюс `onReady(api)` — раскрывает наружу format-команды (undo,
   redo, bold, italic, h1..h3, normal, bullet, ordered), чтобы
   ContractAnalysis мог отрисовать ЕДИНЫЙ toolbar вместе с zoom и
   download-меню.

   Props:
     markdown       — string, source of truth (parent-owned).
     onChange(md)   — вызывается на любое изменение.
     flashRange     — v1 не используем (см. plan Follow-ups).
     scrollToPos    — number | null, markdown-char offset.
                      Ищем окружающий текст в DOM редактора и
                      скроллим в центр (без ProseMirror-mapping).
     filename       — string, заголовок над редактором.
     onReady(api)   — колбэк с format-командами; null при unmount.
                      api: { undo, redo, bold, italic, h1..h5,
                             normal, bullet, ordered }
   ============================================================ */
import { useEffect, useRef, useState, useCallback } from 'react';
import { Crepe } from '@milkdown/crepe';
import { editorViewCtx, commandsCtx } from '@milkdown/kit/core';
import { replaceAll, $mark, $prose } from '@milkdown/kit/utils';
import { Plugin, PluginKey } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view';
import { undo, redo } from '@milkdown/kit/prose/history';
import { buildFromRegex, clauseNumOf } from '../../lib/findingHighlight';
import {
  toggleStrongCommand,
  toggleEmphasisCommand,
  wrapInHeadingCommand,
  wrapInBulletListCommand,
  wrapInOrderedListCommand,
  turnIntoTextCommand,
} from '@milkdown/kit/preset/commonmark';
import '@milkdown/crepe/theme/common/style.css';
import '@milkdown/crepe/theme/frame.css';
import '../../styles/milkdown-theme.css';


/* Custom mark: точечный font-size на выделенный фрагмент.
   Хранится как inline `<span data-fs="N" style="font-size: Npt">…</span>`.
   Для MVP не сериализуется в markdown (match: () => false с обеих сторон):
   размер живёт в текущей сессии, при перезагрузке договора из библиотеки
   сбрасывается. Полноценный round-trip — follow-up. */
/* Findings-flags plugin — рисует маленький круглый маркер слева от блока
   договора, в котором сработал pattern finding'а. Маркер позиционируется
   абсолютно снаружи A4-листа (в серую desk-зону), клик — открывает
   соответствующий finding в AI-панели.

   Хранит DecorationSet в plugin state; parent через `setMeta(pluginKey, …)`
   пушит новый набор при изменении findings/markdown. */
const findingsPluginKey = new PluginKey('aglex-findings');
const findingsClickRef = { current: null };  // ref, чтобы widget-onClick видел актуальный callback

const findingsPlugin = $prose(() => new Plugin({
  key: findingsPluginKey,
  state: {
    init: () => DecorationSet.empty,
    apply: (tr, old) => {
      const meta = tr.getMeta(findingsPluginKey);
      if (meta instanceof DecorationSet) return meta;
      return old.map(tr.mapping, tr.doc);
    },
  },
  props: {
    decorations: (state) => findingsPluginKey.getState(state),
    // Клик по inline подсветке `.md-hl` эмитит тот же callback, что и клик
    // по левому флажку — открывает finding в правой AI-панели.
    handleClick: (view, _pos, event) => {
      const hit = event.target && event.target.closest && event.target.closest('.md-hl');
      if (!hit) return false;
      const id = hit.getAttribute('data-finding-id');
      if (!id) return false;
      const cb = findingsClickRef.current;
      if (typeof cb === 'function') cb(id);
      return true;  // proseMirror не двинет каретку
    },
  },
}));

function _makeFlagEl(finding, stackIdx = 0) {
  const btn = document.createElement('button');
  btn.type = 'button';
  const level = finding.level || 'info';
  btn.className = `md-finding-flag md-finding-flag-${level}`;
  const preview = (finding.suggest?.from || finding.title || '').slice(0, 80);
  btn.title = `${(finding.title || 'Знахідка')}\n${preview}`;
  btn.setAttribute('data-finding-id', finding.id || '');
  btn.setAttribute('contenteditable', 'false');  // ProseMirror не тронет
  btn.onmousedown = (e) => e.preventDefault();  // не сбрасывать выделение
  btn.onclick = (e) => {
    e.stopPropagation();
    const cb = findingsClickRef.current;
    if (typeof cb === 'function') cb(finding.id);
  };
  // Stack: несколько флажков в одном блоке (fallback без match) — раздвигаем
  // их по вертикали, чтобы кружочки не наезжали друг на друга.
  if (stackIdx > 0) btn.style.top = `${4 + stackIdx * 26}px`;
  return btn;
}

/** Собрать плоский список inline-текст-нод в блоке с их PM-позициями. */
function textNodesWithPositions(blockNode, blockPmStart) {
  const nodes = [];
  blockNode.descendants((node, offset) => {
    if (node.isText && node.text) {
      // +1 внутри блока — обходим open-token самого блока.
      nodes.push({ text: node.text, pmStart: blockPmStart + 1 + offset });
    }
    return true;
  });
  return nodes;
}

/** Конвертировать offsets в textContent (start,end) → PM range (from,to). */
function pmRangeForTextRange(textNodes, textStart, textEnd) {
  let cursor = 0;
  let from = null;
  let to = null;
  for (const n of textNodes) {
    const nodeEnd = cursor + n.text.length;
    if (from === null && textStart >= cursor && textStart <= nodeEnd) {
      from = n.pmStart + (textStart - cursor);
    }
    if (to === null && textEnd >= cursor && textEnd <= nodeEnd) {
      to = n.pmStart + (textEnd - cursor);
    }
    cursor = nodeEnd;
    if (from !== null && to !== null) break;
  }
  return (from !== null && to !== null) ? { from, to } : null;
}

function computeFindingDecorations(doc, findings) {
  if (!Array.isArray(findings) || findings.length === 0) return DecorationSet.empty;
  // Компилируем regex один раз на весь проход — быстрее чем в inner loop.
  const compiled = findings
    .map((f) => ({
      f,
      re: buildFromRegex(f?.suggest?.from),
      clauseNum: clauseNumOf(f?.clause),
    }))
    .filter((x) => x.f);
  if (compiled.length === 0) return DecorationSet.empty;

  const decos = [];
  const flaggedIds = new Set();      // finding id → уже поставлен флажок
  const highlightedIds = new Set();  // finding id → уже подсвечен inline
  // Кандидат для fallback: первый блок, чей textContent содержит clause-номер.
  // Заполняется на первом же проходе.
  const clauseBlockOffsets = new Map();  // clauseNum → blockPmStart
  const firstBlockOffsetRef = { pmStart: null };

  // Основной проход: подсветка + флажок для каждого finding с match'ем.
  doc.forEach((node, offset) => {
    if (!node.isBlock || !node.textContent) return;
    if (firstBlockOffsetRef.pmStart === null) firstBlockOffsetRef.pmStart = offset;
    // Регистрируем блоки, содержащие «п. N.N» — понадобится fallback'у.
    for (const { clauseNum } of compiled) {
      if (!clauseNum || clauseBlockOffsets.has(clauseNum)) continue;
      if (node.textContent.includes(clauseNum)) {
        clauseBlockOffsets.set(clauseNum, offset);
      }
    }

    const textNodes = textNodesWithPositions(node, offset);
    for (const { f, re } of compiled) {
      if (!re) continue;
      if (highlightedIds.has(f.id)) continue;
      re.lastIndex = 0;
      const m = re.exec(node.textContent);
      if (!m) continue;
      // Inline подсветка проблемной фразы.
      const range = pmRangeForTextRange(textNodes, m.index, m.index + m[0].length);
      if (range) {
        const level = f.level || 'info';
        decos.push(Decoration.inline(range.from, range.to, {
          class: `md-hl md-hl-${level}`,
          'data-finding-id': f.id || '',
        }));
        highlightedIds.add(f.id);
      }
      // Левый флажок — один на finding, у блока где случился первый match.
      if (!flaggedIds.has(f.id)) {
        flaggedIds.add(f.id);
        decos.push(Decoration.widget(offset + 1, () => _makeFlagEl(f), {
          side: -1,
          key: `flag-${f.id}`,
        }));
      }
    }
  });

  // Fallback: findings, для которых regex не нашёл ни одного match'а —
  // всё равно ставим флажок. Приоритет: блок, чей текст содержит clause-номер;
  // иначе — стек флажков на первом блоке документа.
  let stackIdx = 0;
  for (const { f, clauseNum } of compiled) {
    if (flaggedIds.has(f.id)) continue;
    const clauseOffset = clauseNum ? clauseBlockOffsets.get(clauseNum) : undefined;
    const anchor = (clauseOffset !== undefined)
      ? clauseOffset
      : firstBlockOffsetRef.pmStart;
    if (anchor === null || anchor === undefined) continue;
    // Стек только для первого блока — если ссылка идёт на clause-блок,
    // ставим одиночный флажок (обычно там место есть).
    const idx = (clauseOffset !== undefined) ? 0 : stackIdx++;
    flaggedIds.add(f.id);
    decos.push(Decoration.widget(anchor + 1, () => _makeFlagEl(f, idx), {
      side: -1,
      key: `flag-fallback-${f.id}`,
    }));
  }

  return DecorationSet.create(doc, decos);
}


const fontSizeMark = $mark('fontsize', () => ({
  attrs: { size: { default: 12 } },
  parseDOM: [{
    tag: 'span[data-fs]',
    getAttrs: (dom) => ({ size: Number(dom.getAttribute('data-fs')) || 12 }),
  }],
  toDOM: (mark) => [
    'span',
    { 'data-fs': String(mark.attrs.size), style: `font-size: ${mark.attrs.size}pt` },
    0,
  ],
  parseMarkdown: { match: () => false, runner: () => {} },
  // Match ВСЕГДА возвращаем true для нашего fontsize-mark'а, иначе
  // Milkdown serializer'у некому «отдать» этот mark → кидает
  // serializerMatchError на КАЖДЫЙ keystroke (Schema-стрингификация +
  // circular JSON). Runner пустой — text-content всё равно эмитится
  // родительским text-node serializer'ом, а сам mark пропадает из MD.
  // Это делает fontsize «сессионным»: живёт в редакторе, не пишется в
  // markdown-строку. Это осознанное ограничение MVP.
  toMarkdown: {
    match: (mark) => mark.type.name === 'fontsize',
    runner: () => {},
  },
}));


export function MilkdownEditor({
  markdown, onChange, flashRange, scrollToPos, filename, onReady,
  findings, onFlagClick,
}) {
  const hostRef = useRef(null);
  const crepeRef = useRef(null);
  const readyRef = useRef(false);
  // Последний markdown, который эмитировал сам редактор. Нужно чтобы отличать
  // «пришёл новый MD извне» от «пользователь печатает».
  const lastEmittedRef = useRef('');
  // Живой prop для чтения внутри init-Promise, минуя stale closure.
  const currentMdRef = useRef(markdown);
  currentMdRef.current = markdown;
  // Стабильная ссылка на onReady, чтобы init-effect не пересоздавал
  // редактор при каждом ре-рендере родителя.
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const [initError, setInitError] = useState(null);

  // Диспетчеры Milkdown-команд + ProseMirror-операций.
  const runCommand = useCallback((cmdKey, payload) => {
    const crepe = crepeRef.current;
    if (!crepe || !readyRef.current) return;
    try {
      crepe.editor.action((ctx) => {
        ctx.get(commandsCtx).call(cmdKey, payload);
      });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[MilkdownEditor] command failed', cmdKey, e);
    }
  }, []);

  const runProse = useCallback((fn) => {
    const crepe = crepeRef.current;
    if (!crepe || !readyRef.current) return;
    try {
      crepe.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        fn(view);
        view.focus();
      });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[MilkdownEditor] prose op failed', e);
    }
  }, []);

  // Mount единожды. Крепа сама управляет своим lifecycle.
  useEffect(() => {
    if (!hostRef.current) return undefined;

    let cancelled = false;
    let crepe = null;
    const initial = markdown || '';
    lastEmittedRef.current = initial;

    (async () => {
      try {
        crepe = new Crepe({
          root: hostRef.current,
          defaultValue: initial,
          features: {
            [Crepe.Feature.Toolbar]: true,
            [Crepe.Feature.Table]: true,
            [Crepe.Feature.Placeholder]: true,
            [Crepe.Feature.LinkTooltip]: true,
            [Crepe.Feature.Cursor]: true,
            [Crepe.Feature.BlockEdit]: true,
            [Crepe.Feature.ListItem]: true,
            [Crepe.Feature.CodeMirror]: false,
            [Crepe.Feature.Latex]: false,
            [Crepe.Feature.ImageBlock]: false,
          },
          featureConfigs: {
            [Crepe.Feature.Placeholder]: {
              text: 'Договір порожній',
              mode: 'block',
            },
          },
        });
        // Custom fontSize-mark — регистрируем до create(), иначе схема
        // будет заморожена без нашего mark'а.
        crepe.editor.use(fontSizeMark);
        // Findings-flags плагин — рисует маркеры проблемных пунктов
        // слева от блока (в desk-зоне за пределом A4).
        crepe.editor.use(findingsPlugin);
        await crepe.create();
        if (cancelled) {
          crepe.destroy();
          crepe = null;
          return;
        }
        crepe.on((listener) => {
          listener.markdownUpdated((_ctx, md) => {
            lastEmittedRef.current = md;
            if (typeof onChange === 'function') onChange(md);
          });
        });
        crepeRef.current = crepe;
        readyRef.current = true;

        // Catch-up: если markdown-prop успел смениться, пока Crepe
        // асинхронно поднимался, replaceAll-effect был пропущен из-за
        // !readyRef. Догоняем прямо здесь.
        const latest = currentMdRef.current || '';
        if (latest && latest !== initial) {
          try {
            crepe.editor.action(replaceAll(latest));
            lastEmittedRef.current = latest;
          } catch (e) {
            // eslint-disable-next-line no-console
            console.error('[MilkdownEditor] catch-up replaceAll failed', e);
          }
        }

        // Отдаём наружу format-API — parent рендерит toolbar.
        if (typeof onReadyRef.current === 'function') {
          onReadyRef.current({
            undo:    () => runProse((v) => undo(v.state, v.dispatch)),
            redo:    () => runProse((v) => redo(v.state, v.dispatch)),
            bold:    () => runCommand(toggleStrongCommand.key),
            italic:  () => runCommand(toggleEmphasisCommand.key),
            h1:      () => runCommand(wrapInHeadingCommand.key, 1),
            h2:      () => runCommand(wrapInHeadingCommand.key, 2),
            h3:      () => runCommand(wrapInHeadingCommand.key, 3),
            h4:      () => runCommand(wrapInHeadingCommand.key, 4),
            h5:      () => runCommand(wrapInHeadingCommand.key, 5),
            normal:  () => runCommand(turnIntoTextCommand.key),
            bullet:  () => runCommand(wrapInBulletListCommand.key),
            ordered: () => runCommand(wrapInOrderedListCommand.key),
            setFontSize: (size) => runProse((view) => {
              const { from, to, empty } = view.state.selection;
              if (empty) return;
              const clamped = Math.max(1, Math.min(25, Number(size) || 12));
              const markType = view.state.schema.marks.fontsize;
              if (!markType) return;
              view.dispatch(view.state.tr.addMark(from, to, markType.create({ size: clamped })));
            }),
            clearFontSize: () => runProse((view) => {
              const { from, to, empty } = view.state.selection;
              if (empty) return;
              const markType = view.state.schema.marks.fontsize;
              if (!markType) return;
              view.dispatch(view.state.tr.removeMark(from, to, markType));
            }),
          });
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[MilkdownEditor] init failed', e);
        if (!cancelled) setInitError(String(e?.message || e));
      }
    })();

    return () => {
      cancelled = true;
      readyRef.current = false;
      try { crepe?.destroy(); } catch (_e) { /* noop */ }
      crepeRef.current = null;
      // Уведомить parent, что API больше не валиден.
      if (typeof onReadyRef.current === 'function') {
        onReadyRef.current(null);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Внешний markdown-prop → replaceAll (кроме случая, когда мы сами его
  // только что эмитили — тогда каретка сохраняется).
  useEffect(() => {
    if (!readyRef.current) return;
    const crepe = crepeRef.current;
    if (!crepe) return;
    const next = markdown || '';
    if (next === lastEmittedRef.current) return;
    try {
      crepe.editor.action(replaceAll(next));
      lastEmittedRef.current = next;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[MilkdownEditor] replaceAll failed', e);
    }
  }, [markdown]);

  // scrollToPos через DOM-поиск текста — простой MVP-путь без
  // ProseMirror-position mapping.
  useEffect(() => {
    if (!hostRef.current || scrollToPos == null) return;
    const md = markdown || '';
    const from = Math.max(0, Math.min(scrollToPos, md.length));
    const window = md.slice(from, Math.min(md.length, from + 60));
    const needleFull = window.replace(/[#*_`~]+/g, '').trim();
    if (!needleFull) return;
    const needle = needleFull.slice(0, Math.min(30, needleFull.length));
    const walker = document.createTreeWalker(hostRef.current, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (node.textContent && node.textContent.includes(needle)) {
        const el = node.parentElement;
        if (el && typeof el.scrollIntoView === 'function') {
          el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
        break;
      }
    }
  }, [scrollToPos, markdown]);

  useEffect(() => { /* flashRange — заглушка v1 */ }, [flashRange]);

  // Актуальный onFlagClick — widget'ы читают через shared ref, чтобы
  // не пересоздавать decoration-set только ради нового замыкания.
  findingsClickRef.current = onFlagClick;

  // Пересчёт findings-decoration'ов при смене findings или markdown.
  useEffect(() => {
    if (!readyRef.current) return;
    const crepe = crepeRef.current;
    if (!crepe) return;
    try {
      crepe.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const decorations = computeFindingDecorations(view.state.doc, findings);
        view.dispatch(view.state.tr.setMeta(findingsPluginKey, decorations));
      });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[MilkdownEditor] findings decoration update failed', e);
    }
  }, [findings, markdown]);

  return (
    <article className="md-doc md-doc-edit md-doc-milkdown">
      {filename ? <h1 className="md-doc-title">{filename}</h1> : null}
      {initError ? (
        <div className="md-editor-error">
          Не вдалося ініціалізувати редактор: {initError}
          <br />
          <span className="md-editor-error-hint">Відкрийте DevTools (F12) → Console для деталей.</span>
        </div>
      ) : null}
      <div ref={hostRef} className="milkdown-host" />
    </article>
  );
}
