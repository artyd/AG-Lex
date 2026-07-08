/* ============================================================
   TocPanel — оглавление договора (заголовки H1-H3).

   Реактивно парсит `markdown` prop; клик по пункту вызывает
   onScrollTo(offset) — parent пробрасывает это в
   MilkdownEditor.scrollToPos, который скроллит соответствующий
   узел в центр.
   ============================================================ */
import { useMemo } from 'react';

const HEADING_RE = /^(#{1,3})\s+(.+)$/gm;

export function TocPanel({ markdown, onScrollTo, className }) {
  const headings = useMemo(() => {
    if (typeof markdown !== 'string' || !markdown) return [];
    const items = [];
    // matchAll с /g требует создания нового RegExp, чтобы не тащить
    // lastIndex между renders.
    const re = new RegExp(HEADING_RE.source, 'gm');
    let m;
    while ((m = re.exec(markdown)) !== null) {
      const title = m[2].replace(/[*_`]+/g, '').trim();
      if (!title) continue;
      items.push({
        level: m[1].length,
        title,
        offset: m.index,
        key: `toc-${m.index}`,
      });
      // Защита от нулевой длины (edge-case пустого совпадения).
      if (m.index === re.lastIndex) re.lastIndex++;
    }
    return items;
  }, [markdown]);

  if (headings.length === 0) return null;

  return (
    <aside className={`toc-panel ${className || ''}`}>
      <div className="toc-panel-head">Зміст</div>
      <ul className="toc-panel-list">
        {headings.map((h) => (
          <li key={h.key} className={`toc-panel-item toc-level-${h.level}`}>
            <button
              type="button"
              className="toc-panel-link"
              onClick={() => onScrollTo?.(h.offset)}
              title={h.title}>
              {h.title}
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}
