/* ============================================================
   AG Lex — unified analysis layout (Phase 4.x PR4).

   Left pane: PdfViewer + tab strip for multi-document flows
   (reconcile = contract + handover). Right pane: caller-supplied
   panel (AiPanel today; AiPanel will stay co-located in
   ContractAnalysis.jsx until a follow-up moves it here).

   Same component for /api/analyze/contract and /api/reconcile — the
   reconcile caller converts the run via `reconcileToAnalysisProps`.

   Authentication: the display PDFs sit behind /api/.../display.pdf
   gated by `current_user`. We pre-fetch the bytes via authHeaders()
   and hand the ArrayBuffer to PDF.js — that's the one auth code
   path used everywhere else in the app.
   ============================================================ */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../../ui/Icon';
import { authHeaders } from '../../lib/auth';
import { findingsToHighlights } from '../../lib/pdfHighlight';
import { PdfViewer } from './PdfViewer';

const LOAD = { idle: 'idle', loading: 'loading', ready: 'ready', missing: 'missing', error: 'error' };

const ZOOM_LEVELS = [0.75, 0.9, 1.0, 1.15, 1.3, 1.5, 1.75, 2.0, 2.5];
const ZOOM_DEFAULT = 1.3;

export function AnalysisView({
  documents,            // [{ label, displayPdfUrl, displayPdfBytes? }]
  findings,             // unified analyze shape
  panel,                // ReactNode for the right side (AiPanel etc.)
  active, setActive,    // selected finding id ↔ panel
  hovered, setHovered,  // hover state (mark ↔ card)
  t,
}) {
  const [zoom, setZoom] = useState(ZOOM_DEFAULT);
  const zoomStep = (delta) => {
    setZoom((z) => {
      const idx = ZOOM_LEVELS.findIndex((v) => Math.abs(v - z) < 1e-3);
      const next = idx < 0
        ? (delta > 0
            ? ZOOM_LEVELS.find((v) => v > z) ?? ZOOM_LEVELS[ZOOM_LEVELS.length - 1]
            : [...ZOOM_LEVELS].reverse().find((v) => v < z) ?? ZOOM_LEVELS[0])
        : ZOOM_LEVELS[Math.max(0, Math.min(ZOOM_LEVELS.length - 1, idx + delta))];
      return next;
    });
  };
  const docs = Array.isArray(documents) && documents.length > 0
    ? documents
    : [{ label: t?.docTab || 'Документ', displayPdfUrl: null }];

  const [docIdx, setDocIdx] = useState(0);
  const cur = docs[Math.min(docIdx, docs.length - 1)] || docs[0];

  // Pre-fetched PDF bytes per document URL/index. Two-tab reconcile flow
  // keeps both in memory so flipping tabs is instant.
  const [bytesByIdx, setBytesByIdx] = useState({});
  const [stateByIdx, setStateByIdx] = useState({}); // idx → LOAD.*
  const [pagesByIdx, setPagesByIdx] = useState({}); // idx → { [pageNumber]: pageInfo }

  // Fetch the current document's bytes once. URL change re-fetches; bytes
  // already provided on the doc descriptor short-circuit the network step.
  useEffect(() => {
    if (!cur) return;
    if (cur.displayPdfBytes && !bytesByIdx[docIdx]) {
      setBytesByIdx((m) => ({ ...m, [docIdx]: cur.displayPdfBytes }));
      setStateByIdx((m) => ({ ...m, [docIdx]: LOAD.ready }));
      return;
    }
    if (!cur.displayPdfUrl) {
      setStateByIdx((m) => ({ ...m, [docIdx]: LOAD.missing }));
      return;
    }
    if (bytesByIdx[docIdx]) return;
    setStateByIdx((m) => ({ ...m, [docIdx]: LOAD.loading }));
    let cancelled = false;
    fetch(cur.displayPdfUrl, { headers: authHeaders() })
      .then(async (r) => {
        if (cancelled) return;
        if (r.status === 404) {
          setStateByIdx((m) => ({ ...m, [docIdx]: LOAD.missing }));
          return;
        }
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const buf = await r.arrayBuffer();
        if (cancelled) return;
        setBytesByIdx((m) => ({ ...m, [docIdx]: new Uint8Array(buf) }));
        setStateByIdx((m) => ({ ...m, [docIdx]: LOAD.ready }));
      })
      .catch(() => {
        if (!cancelled) setStateByIdx((m) => ({ ...m, [docIdx]: LOAD.error }));
      });
    return () => { cancelled = true; };
  }, [docIdx, cur && cur.displayPdfUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  const docState = stateByIdx[docIdx] || LOAD.idle;
  const docBytes = bytesByIdx[docIdx] || null;

  const onPagesReady = useMemo(() => (added) => {
    if (!added || !added.length) return;
    setPagesByIdx((prev) => {
      const cur = prev[docIdx] || {};
      const next = { ...cur };
      for (const p of added) next[p.pageNumber] = p;
      return { ...prev, [docIdx]: next };
    });
  }, [docIdx]);

  // Recompute overlay rects for the current document. Active/hovered flags
  // sync back from the panel so the panel ↔ overlay link is bidirectional.
  const highlights = useMemo(() => {
    if (!docBytes || !findings) return [];
    const pages = Object.values(pagesByIdx[docIdx] || {})
      .sort((a, b) => a.pageNumber - b.pageNumber);
    if (pages.length === 0) return [];
    return findingsToHighlights(pages, findings).map((h) => ({
      ...h,
      active: h.findingId === active,
      hovered: h.findingId === hovered,
    }));
  }, [docBytes, pagesByIdx, docIdx, findings, active, hovered]);

  return (
    <div className="analysis-body">
      <div className="doc-scroll analysis-doc-pane">
        {docs.length > 1 ? (
          <div className="analysis-tabs">
            {docs.map((d, i) => (
              <button
                key={i}
                className={'analysis-tab' + (i === docIdx ? ' on' : '')}
                onClick={() => setDocIdx(i)}
              >
                {d.label}
              </button>
            ))}
          </div>
        ) : null}

        {docState === LOAD.loading ? (
          <div className="analysis-fallback">
            <div className="analysis-fallback-title">{t?.analyzing || 'Завантажуємо документ…'}</div>
          </div>
        ) : null}

        {docState === LOAD.missing || docState === LOAD.error ? (
          <div className="analysis-fallback">
            <Icon name="alert" size={20} />
            <div className="analysis-fallback-title">
              {t?.previewUnavailable || 'Перегляд недоступний для цього запису.'}
            </div>
            <div className="analysis-fallback-sub">
              {t?.previewUnavailableSub
                || 'Записи до цього оновлення не зберігали оригінал. Завантажте контракт ще раз — і документ зʼявиться тут.'}
            </div>
          </div>
        ) : null}

        {docState === LOAD.ready && docBytes ? (
          <PdfViewer
            data={docBytes}
            highlights={highlights}
            onPagesReady={onPagesReady}
            onHighlightClick={(fid) => { if (setActive) setActive(fid); }}
            onHighlightHover={(fid) => { if (setHovered) setHovered(fid); }}
            zoom={zoom}
          />
        ) : null}

        {docState === LOAD.ready && docBytes ? (
          <div className="pdf-zoom-bar" role="group" aria-label="zoom">
            <button
              type="button"
              className="pdf-zoom-btn"
              onClick={() => zoomStep(-1)}
              disabled={zoom <= ZOOM_LEVELS[0] + 1e-3}
              aria-label="zoom out"
            >
              <Icon name="x" size={14} />
            </button>
            <button
              type="button"
              className="pdf-zoom-btn pdf-zoom-reset"
              onClick={() => setZoom(ZOOM_DEFAULT)}
              aria-label="reset zoom"
            >
              {Math.round(zoom * 100)}%
            </button>
            <button
              type="button"
              className="pdf-zoom-btn"
              onClick={() => zoomStep(1)}
              disabled={zoom >= ZOOM_LEVELS[ZOOM_LEVELS.length - 1] - 1e-3}
              aria-label="zoom in"
            >
              <Icon name="plus" size={14} />
            </button>
          </div>
        ) : null}
      </div>

      <div className="panel-wrap">
        {panel}
      </div>
    </div>
  );
}
