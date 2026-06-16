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
import { authHeaders, lxLogout } from '../../lib/auth';
import { findingsToHighlights } from '../../lib/pdfHighlight';
import { PdfViewer } from './PdfViewer';

const LOAD = { idle: 'idle', loading: 'loading', ready: 'ready', missing: 'missing', error: 'error' };

// Track every fetch attempt per doc so the fallback banner can tell the
// user *why* the PDF didn't show up — was it config (URL missing), backend
// (404 / 500), or the network? Keyed by `${docIdx}@${attempt}` so manual
// retries actually re-trigger the useEffect.
function _diagKey(docIdx, attempt) { return `${docIdx}@${attempt}`; }

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
  const [diagByIdx, setDiagByIdx] = useState({});   // idx → { status, url, reason }
  const [retryByIdx, setRetryByIdx] = useState({}); // idx → attempt counter
  const [pagesByIdx, setPagesByIdx] = useState({}); // idx → { [pageNumber]: pageInfo }
  const attempt = retryByIdx[docIdx] || 0;

  // Fetch the current document's bytes. URL change OR a manual retry
  // re-fires the effect. Bytes already on the descriptor short-circuit
  // the network step.
  useEffect(() => {
    if (!cur) return;
    if (cur.displayPdfBytes && !bytesByIdx[docIdx]) {
      setBytesByIdx((m) => ({ ...m, [docIdx]: cur.displayPdfBytes }));
      setStateByIdx((m) => ({ ...m, [docIdx]: LOAD.ready }));
      setDiagByIdx((m) => ({ ...m, [docIdx]: { kind: 'bytes' } }));
      return;
    }
    if (!cur.displayPdfUrl) {
      console.warn('[AnalysisView] doc', docIdx, 'has no displayPdfUrl — banner will show.');
      setStateByIdx((m) => ({ ...m, [docIdx]: LOAD.missing }));
      setDiagByIdx((m) => ({ ...m, [docIdx]: { kind: 'no-url' } }));
      return;
    }
    if (bytesByIdx[docIdx]) return;
    setStateByIdx((m) => ({ ...m, [docIdx]: LOAD.loading }));
    let cancelled = false;
    const url = cur.displayPdfUrl;
    fetch(url, { headers: authHeaders() })
      .then(async (r) => {
        if (cancelled) return;
        if (r.status === 401) {
          // Auth, not a file problem — token expired or session cleared.
          // Mirror api.js: clear the cached session so other screens stop
          // showing stale auth state. The user lands on the same banner
          // with a clear "session expired" message and a hint to re-login;
          // they don't lose context (route + reconcile row stay).
          console.warn('[AnalysisView] 401 from', url, '— session expired, clearing.');
          try { lxLogout(); } catch (_) { /* best-effort */ }
          setStateByIdx((m) => ({ ...m, [docIdx]: LOAD.error }));
          setDiagByIdx((m) => ({ ...m, [docIdx]: { kind: 'http', status: 401, url } }));
          return;
        }
        if (r.status === 404) {
          console.warn('[AnalysisView] 404 from', url, '— BLOB likely NULL on the server.');
          setStateByIdx((m) => ({ ...m, [docIdx]: LOAD.missing }));
          setDiagByIdx((m) => ({ ...m, [docIdx]: { kind: 'http', status: 404, url } }));
          return;
        }
        if (!r.ok) {
          console.error('[AnalysisView] HTTP', r.status, 'from', url);
          setStateByIdx((m) => ({ ...m, [docIdx]: LOAD.error }));
          setDiagByIdx((m) => ({ ...m, [docIdx]: { kind: 'http', status: r.status, url } }));
          return;
        }
        const buf = await r.arrayBuffer();
        if (cancelled) return;
        setBytesByIdx((m) => ({ ...m, [docIdx]: new Uint8Array(buf) }));
        setStateByIdx((m) => ({ ...m, [docIdx]: LOAD.ready }));
        setDiagByIdx((m) => ({ ...m, [docIdx]: { kind: 'ok', status: 200, url, bytes: buf.byteLength } }));
      })
      .catch((e) => {
        if (cancelled) return;
        console.error('[AnalysisView] fetch failed for', url, e);
        setStateByIdx((m) => ({ ...m, [docIdx]: LOAD.error }));
        setDiagByIdx((m) => ({ ...m, [docIdx]: { kind: 'net', url, message: String(e && e.message || e) } }));
      });
    return () => { cancelled = true; };
  }, [docIdx, attempt, cur && cur.displayPdfUrl]); // eslint-disable-line react-hooks/exhaustive-deps

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
              {(() => {
                const d = diagByIdx[docIdx];
                if (!d) return t?.previewUnavailableSub
                  || 'Записи до цього оновлення не зберігали оригінал. Завантажте контракт ще раз — і документ зʼявиться тут.';
                if (d.kind === 'no-url') {
                  return 'Бекенд не повернув посилання на оригінал. Імовірно це запис, створений до цього оновлення — завантажте файли ще раз.';
                }
                if (d.kind === 'http' && d.status === 404) {
                  return 'Файл недоступний на сервері (HTTP 404). Запис є, але оригінал не зберігся — швидше за все LibreOffice (soffice) не зміг сконвертувати один із файлів. Перевірте логи деплою: `journalctl -u aglex | grep to_display_pdf`.';
                }
                if (d.kind === 'http' && d.status === 401) {
                  return 'Сесія прострочена або недійсна — увійдіть знову, щоб переглянути документ. Це не помилка файлу: запит до бекенда був відхилений ще на перевірці автентифікації.';
                }
                if (d.kind === 'http') {
                  return `Сервер повернув HTTP ${d.status}. URL: ${d.url}`;
                }
                if (d.kind === 'net') {
                  return `Помилка мережі при завантаженні ${d.url || ''}: ${d.message}`;
                }
                return t?.previewUnavailableSub || 'Невідома помилка.';
              })()}
            </div>
            {cur && cur.displayPdfUrl ? (
              <details className="analysis-fallback-diag">
                <summary>Діагностика</summary>
                <pre>{JSON.stringify({
                  url: cur.displayPdfUrl,
                  diag: diagByIdx[docIdx] || null,
                  state: docState,
                }, null, 2)}</pre>
              </details>
            ) : null}
            {cur && cur.displayPdfUrl ? (
              <button
                type="button"
                className="btn btn-ghost btn-sm analysis-fallback-retry"
                onClick={() => {
                  setBytesByIdx((m) => { const n = { ...m }; delete n[docIdx]; return n; });
                  setRetryByIdx((m) => ({ ...m, [docIdx]: (m[docIdx] || 0) + 1 }));
                }}
              >
                <Icon name="refresh" size={14} /> Спробувати ще раз
              </button>
            ) : null}
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
