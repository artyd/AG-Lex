/* ============================================================
   AG Lex — PDF viewer (Phase 4.x PR2).

   Renders a display PDF (the soffice-converted .docx/.xlsx or the
   original .pdf) page-by-page via PDF.js. The lawyer sees the document
   pixel-perfect; a transparent overlay layer paints red rectangles over
   the words that PR3's pdfHighlight mapper locates.

   Design choices documented in the plan:
   - `data` (pre-fetched ArrayBuffer/Uint8Array), NOT a `url`. PDF.js's
     URL fetcher can't add our Bearer token; pre-fetching via
     authHeaders() keeps one auth code path.
   - Lazy page render via IntersectionObserver (rootMargin: 300px) so
     long documents don't block the main thread on mount.
   - Hi-DPI canvas pattern: canvas pixels = viewport.width * dpr; CSS
     size = viewport.width. Re-render on dpr change (cross-display drag).
   - Scanned-PDF: when every visible page has zero text items, badge
     the viewer so the user knows highlights aren't available — no crash.

   PR3 layers in finding highlights and `onPagesReady`; PR4 mounts this
   inside the unified AnalysisView.
   ============================================================ */
import { useEffect, useRef, useState, useCallback } from 'react';
import * as pdfjs from 'pdfjs-dist';
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

const LAZY_MARGIN = '300px 0px';
const RESIZE_DEBOUNCE_MS = 120;

export function PdfViewer({
  data,
  highlights,
  onHighlightHover,
  onHighlightClick,
  onPagesReady,
  zoom = 1.0,
  className,
}) {
  const containerRef = useRef(null);
  // Per-page bookkeeping: slotEl, canvas, overlayEl, textItems, viewport.
  // Indexed by page number (1-based) so we mirror PDF.js's numbering.
  const pagesRef = useRef({});
  const docRef = useRef(null);
  const observerRef = useRef(null);
  const [numPages, setNumPages] = useState(0);
  const [loadState, setLoadState] = useState('loading'); // loading|ready|error
  const [errorMsg, setErrorMsg] = useState('');
  const [noTextLayer, setNoTextLayer] = useState(false);
  const [dpr, setDpr] = useState(() => Math.max(1, window.devicePixelRatio || 1));

  // ---- Load the document ----
  useEffect(() => {
    if (!data) return;
    let cancelled = false;
    setLoadState('loading');
    setErrorMsg('');
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    // Clone the bytes so PDF.js can transfer ownership without invalidating
    // the caller's reference (the prop might be reused across re-renders).
    const task = pdfjs.getDocument({ data: bytes.slice() });
    task.promise.then(
      (doc) => {
        if (cancelled) { doc.destroy(); return; }
        docRef.current = doc;
        setNumPages(doc.numPages);
        setLoadState('ready');
      },
      (err) => {
        if (cancelled) return;
        console.error('[PdfViewer] getDocument failed', err);
        setErrorMsg(err && err.message ? err.message : 'PDF load failed');
        setLoadState('error');
      }
    );
    return () => {
      cancelled = true;
      try { task.destroy(); } catch (_e) {}
      const doc = docRef.current;
      if (doc) { try { doc.destroy(); } catch (_e) {} docRef.current = null; }
      pagesRef.current = {};
    };
  }, [data]);

  // ---- Track devicePixelRatio (cross-display drag, browser zoom) ----
  useEffect(() => {
    const updateDpr = () => setDpr(Math.max(1, window.devicePixelRatio || 1));
    // matchMedia for the current dpr fires once the user crosses to a
    // different display or zooms past a px-density step.
    const mq = window.matchMedia(`(resolution: ${dpr}dppx)`);
    mq.addEventListener('change', updateDpr);
    return () => mq.removeEventListener('change', updateDpr);
  }, [dpr]);

  // ---- Render one page into its slot ----
  const renderPage = useCallback(async (pageNumber) => {
    const doc = docRef.current;
    if (!doc) return;
    const entry = pagesRef.current[pageNumber];
    if (!entry || entry.rendering || entry.renderedAtZoom === zoom * dpr) return;
    entry.rendering = true;
    try {
      const page = await doc.getPage(pageNumber);
      const viewport = page.getViewport({ scale: zoom * dpr });
      const slot = entry.slotEl;
      if (!slot) return;
      // Clear any previous canvas (zoom change → re-render).
      slot.querySelectorAll('canvas[data-pdf-canvas]').forEach(c => c.remove());
      const canvas = document.createElement('canvas');
      canvas.setAttribute('data-pdf-canvas', '1');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      // CSS size matches the pre-DPR viewport so layout stays predictable.
      const cssScale = zoom;
      const cssW = page.getViewport({ scale: cssScale }).width;
      const cssH = page.getViewport({ scale: cssScale }).height;
      canvas.style.width = cssW + 'px';
      canvas.style.height = cssH + 'px';
      slot.style.width = cssW + 'px';
      slot.style.height = cssH + 'px';
      slot.appendChild(canvas);
      // Make sure the highlight overlay sits on top of the canvas inside the slot.
      const overlay = entry.overlayEl;
      if (overlay) {
        overlay.style.width = cssW + 'px';
        overlay.style.height = cssH + 'px';
      }
      await page.render({
        canvasContext: canvas.getContext('2d', { alpha: false }),
        viewport,
      }).promise;
      // Fetch text items once per page; cached for PR3 highlight anchoring.
      if (!entry.textItems) {
        try {
          const tc = await page.getTextContent();
          entry.textItems = tc.items || [];
        } catch (_e) {
          entry.textItems = [];
        }
      }
      entry.viewport = viewport;
      entry.cssViewport = page.getViewport({ scale: cssScale });
      entry.renderedAtZoom = zoom * dpr;
      entry.rendered = true;
      // Notify the parent — AnalysisView feeds these into
      // findingsToHighlights() to compute overlay rects. The viewport here
      // is CSS-pixel-scaled (matches the highlight layer's coord space).
      if (onPagesReady) {
        onPagesReady([{
          pageNumber,
          viewport: entry.cssViewport,
          textContent: { items: entry.textItems },
        }]);
      }
    } catch (err) {
      console.error(`[PdfViewer] render page ${pageNumber} failed`, err);
    } finally {
      entry.rendering = false;
    }
  }, [zoom, dpr, onPagesReady]);

  // ---- After the doc is ready: place slots and observe them ----
  useEffect(() => {
    if (loadState !== 'ready' || !docRef.current || !containerRef.current) return;
    const doc = docRef.current;
    const container = containerRef.current;
    // Clear any prior slots (e.g. doc swap mid-session).
    container.innerHTML = '';
    pagesRef.current = {};

    let cancelled = false;
    let estimatedHeight = 800;

    // Estimate height from page 1 so the scroll bar is honest from the start.
    doc.getPage(1).then((page) => {
      if (cancelled) return;
      const vp = page.getViewport({ scale: zoom });
      estimatedHeight = vp.height;
      // Resize existing slots to match.
      Object.values(pagesRef.current).forEach((entry) => {
        if (!entry.rendered && entry.slotEl) {
          entry.slotEl.style.height = estimatedHeight + 'px';
          entry.slotEl.style.width = vp.width + 'px';
        }
      });
    });

    for (let n = 1; n <= doc.numPages; n += 1) {
      const slot = document.createElement('div');
      slot.className = 'pdf-page-slot';
      slot.setAttribute('data-page', String(n));
      slot.style.height = estimatedHeight + 'px';
      const overlay = document.createElement('div');
      overlay.className = 'pdf-highlight-layer';
      slot.appendChild(overlay);
      container.appendChild(slot);
      pagesRef.current[n] = {
        slotEl: slot, overlayEl: overlay,
        rendered: false, rendering: false, renderedAtZoom: 0,
      };
    }

    const obs = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const pageNumber = Number(e.target.getAttribute('data-page'));
        renderPage(pageNumber);
      }
    }, { root: null, rootMargin: LAZY_MARGIN, threshold: 0 });
    observerRef.current = obs;
    Object.values(pagesRef.current).forEach((entry) => obs.observe(entry.slotEl));

    return () => {
      cancelled = true;
      obs.disconnect();
      observerRef.current = null;
    };
  }, [loadState, renderPage, zoom]);

  // ---- Re-render visible pages when zoom or DPR changes ----
  useEffect(() => {
    if (loadState !== 'ready') return;
    Object.entries(pagesRef.current).forEach(([n, entry]) => {
      if (!entry.rendered) return;
      // Force a re-render at the new scale.
      entry.renderedAtZoom = 0;
      renderPage(Number(n));
    });
    // Debounce window resize → re-trigger DPR-driven re-render in case the
    // user moved the window across displays without crossing a resolution
    // threshold (some compositors don't fire the matchMedia change).
    let t = null;
    const onResize = () => {
      clearTimeout(t);
      t = setTimeout(() => setDpr(Math.max(1, window.devicePixelRatio || 1)), RESIZE_DEBOUNCE_MS);
    };
    window.addEventListener('resize', onResize);
    return () => { window.removeEventListener('resize', onResize); clearTimeout(t); };
  }, [zoom, dpr, loadState, renderPage]);

  // ---- Scanned-PDF detection: once a few pages have rendered, if all
  //      came back with zero text items, badge the viewer. ----
  useEffect(() => {
    if (loadState !== 'ready') return;
    const interval = setInterval(() => {
      const entries = Object.values(pagesRef.current);
      const rendered = entries.filter(e => e.rendered && Array.isArray(e.textItems));
      if (rendered.length === 0) return;
      const anyText = rendered.some(e => e.textItems.length > 0);
      if (!anyText && rendered.length >= Math.min(3, numPages)) {
        setNoTextLayer(true);
        clearInterval(interval);
      } else if (anyText) {
        setNoTextLayer(false);
        clearInterval(interval);
      }
    }, 400);
    return () => clearInterval(interval);
  }, [loadState, numPages]);

  // ---- Sync `highlights` prop → overlay DOM (PR3 wires real data here) ----
  useEffect(() => {
    if (loadState !== 'ready') return;
    const byPage = new Map();
    for (const hl of highlights || []) {
      if (!hl || !hl.page || !hl.matched) continue;
      if (!byPage.has(hl.page)) byPage.set(hl.page, []);
      byPage.get(hl.page).push(hl);
    }
    Object.entries(pagesRef.current).forEach(([n, entry]) => {
      const overlay = entry.overlayEl;
      if (!overlay) return;
      overlay.innerHTML = '';
      const list = byPage.get(Number(n)) || [];
      for (const hl of list) {
        for (const r of hl.rects || []) {
          const div = document.createElement('div');
          div.className = 'hl-rect hl-level-' + (hl.level || 'info')
            + (hl.active ? ' hl-active' : '')
            + (hl.hovered ? ' hl-hover' : '');
          div.setAttribute('data-finding-id', String(hl.findingId));
          div.style.left = r.x + 'px';
          div.style.top = r.y + 'px';
          div.style.width = r.w + 'px';
          div.style.height = r.h + 'px';
          overlay.appendChild(div);
        }
      }
    });
  }, [highlights, loadState]);

  // ---- Click / hover delegation on overlay rects ----
  useEffect(() => {
    if (loadState !== 'ready') return;
    const root = containerRef.current;
    if (!root) return;
    const findFid = (e) => {
      const t = e.target && e.target.closest && e.target.closest('.hl-rect[data-finding-id]');
      return t ? t.getAttribute('data-finding-id') : null;
    };
    const onClick = (e) => {
      const fid = findFid(e);
      if (fid && onHighlightClick) {
        e.stopPropagation();
        onHighlightClick(fid);
      }
    };
    const onOver = (e) => {
      const fid = findFid(e);
      if (fid && onHighlightHover) onHighlightHover(fid);
    };
    const onOut = (e) => {
      const fid = findFid(e);
      if (fid && onHighlightHover) onHighlightHover(null);
    };
    root.addEventListener('click', onClick);
    root.addEventListener('mouseover', onOver);
    root.addEventListener('mouseout', onOut);
    return () => {
      root.removeEventListener('click', onClick);
      root.removeEventListener('mouseover', onOver);
      root.removeEventListener('mouseout', onOut);
    };
  }, [loadState, onHighlightClick, onHighlightHover]);

  return (
    <div className={'pdf-viewer' + (className ? ' ' + className : '')}>
      {loadState === 'loading' ? (
        <div className="pdf-viewer-state pdf-viewer-loading">Завантажуємо документ…</div>
      ) : null}
      {loadState === 'error' ? (
        <div className="pdf-viewer-state pdf-viewer-error">
          PDF не вдалося відкрити: {errorMsg}
        </div>
      ) : null}
      {noTextLayer ? (
        <div className="pdf-no-text-badge" role="status">
          Підсвітка недоступна — для сканованого документа потрібен OCR.
        </div>
      ) : null}
      <div ref={containerRef} className="pdf-viewer-pages" />
    </div>
  );
}
