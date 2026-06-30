/* ============================================================
   AG Lex — unified analysis layout.

   Left pane: MarkdownDoc + tab strip for multi-document flows
   (reconcile = contract + handover). Right pane: caller-supplied
   panel (AiPanel today).

   Phase 5: PDF viewer retired. The display PDF pipeline turned
   out to be fragile (PDF.js worker fetches, soffice conversions,
   nginx asset routing) and the AI's quoted snippets line up with
   the analyzer's per-section text just as well. Same AnalysisView
   API as before — callers pass `documents[].sections` instead of
   `displayPdfBytes`/`displayPdfUrl`. The reconcile adapter has been
   updated to derive sections from `run.docs.contract.sections`.
   ============================================================ */
import { useState } from 'react';
import { Icon } from '../../ui/Icon';
import { MarkdownDoc } from './MarkdownDoc';
import './markdownDoc.css';

export function AnalysisView({
  documents,            // [{ label, filename?, sections: [{number, title, text}] }]
  findings,             // unified analyze shape
  panel,                // ReactNode for the right side (AiPanel etc.)
  active, setActive,    // selected finding id ↔ panel
  hovered, setHovered,  // hover state (mark ↔ card)
  applied,              // { [findingId]: true } — finding has been "Apply fix"ed
  docToolbar,           // ReactNode rendered above the doc body (view/edit/zoom/download)
  docOverride,          // ReactNode rendered instead of MarkdownDoc (edit mode)
  docZoom,              // 0.7 – 1.5 — scales font-size of the doc body only
  t,
}) {
  const docs = Array.isArray(documents) && documents.length > 0
    ? documents
    : [{ label: t?.docTab || 'Документ', sections: [] }];
  const [docIdx, setDocIdx] = useState(0);
  const cur = docs[Math.min(docIdx, docs.length - 1)] || docs[0];
  // CSS custom property drives `.doc-zoom-wrap { font-size: calc(var(--doc-zoom) * 1rem) }`.
  // Wrapped in style only when a zoom is provided so unstyled callers stay unchanged.
  const zoomStyle = (typeof docZoom === 'number')
    ? { '--doc-zoom': docZoom }
    : undefined;

  return (
    <div className="analysis-body">
      <div className="doc-scroll analysis-doc-pane">
        {docToolbar}
        {docs.length > 1 ? (
          <div className="analysis-tabs">
            {docs.map((d, i) => (
              <button
                key={i}
                className={'analysis-tab' + (i === docIdx ? ' on' : '')}
                onClick={() => setDocIdx(i)}
                type="button"
              >
                {d.label}
              </button>
            ))}
          </div>
        ) : null}

        <div className="doc-zoom-wrap" style={zoomStyle}>
          {docOverride
            ? docOverride
            : (!cur.sections || cur.sections.length === 0) ? (
              <div className="analysis-fallback">
                <Icon name="alert" size={20} />
                <div className="analysis-fallback-title">
                  {t?.previewUnavailable || 'Перегляд недоступний для цього запису.'}
                </div>
                <div className="analysis-fallback-sub">
                  {t?.previewUnavailableSub
                    || 'Записи до цього оновлення не зберігали розбитий текст. Завантажте контракт ще раз — і документ зʼявиться тут.'}
                </div>
              </div>
            ) : (
              <MarkdownDoc
                filename={cur.filename || cur.label}
                sections={cur.sections}
                findings={findings}
                applied={applied}
                active={active}
                hovered={hovered}
                setActive={setActive}
                setHovered={setHovered}
                t={t}
              />
            )}
        </div>
      </div>

      <div className="panel-wrap">
        {panel}
      </div>
    </div>
  );
}
