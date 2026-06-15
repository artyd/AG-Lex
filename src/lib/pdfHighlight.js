/* ============================================================
   Map findings → viewport-space rectangles over a PDF.js page.

   Phase 4.x PR3. Pure module — no DOM, no React, no PDF.js imports.
   Accepts plain `textContent.items` and a viewport object exposing
   `transform: [a,b,c,d,e,f]` and `scale: number`. Tested under jsdom-
   free vitest with hand-crafted fixtures.

   Pipeline:
     buildPageIndex(textContent)         → { normText, charMap }
     findSpan(normText, normFrom, opts)  → { start, end } | null
     spanToRects(items, charMap, span, viewport) → [{x,y,w,h}]
     findingsToHighlights(pages, findings) → convenience wrapper

   The matcher reuses the loose-match approach from
   `findingHighlight.js`: collapse whitespace, unify quote/dash
   variants, strip soft hyphens, rejoin line-break hyphenations.
   First-occurrence only — same trade-off as the markdown highlighter.
   ============================================================ */

// ---- text normalization ----------------------------------------------------

/** Collapse the punctuation variations that always differ between a model
 *  quote and the rendered text. Returns the normalized string. */
export function normalizeForMatch(s) {
  return String(s || '')
    .replace(/[­​-‍﻿]/g, '') // soft hyphen + zero-width
    .replace(/[«»“”„‟]/g, '"')                     // double-quote variants
    .replace(/[‘’‚‛]/g, "'")                       // single-quote variants
    .replace(/[‐-―−]/g, '-')        // dashes / hyphens
    .replace(/[   ]/g, ' ')         // NBSPs
    .replace(/\s+/g, ' ')
    .trim();
}

/** Build a normalized string for the whole page plus a same-length index
 *  map back to (itemIndex, intra-item offset in the original item.str).
 *  Implements the line-break hyphen rejoin: when a normalized item ends
 *  with "-" and the previous item had `hasEOL: true` and the next item's
 *  first character is a lowercase letter, the hyphen is dropped. */
export function buildPageIndex(textContent) {
  const items = (textContent && textContent.items) || [];
  const out = [];
  const map = [];
  let prevEOL = false;

  for (let i = 0; i < items.length; i += 1) {
    const it = items[i];
    const raw = String(it.str || '');
    const norm = normalizeForMatch(raw);
    if (!norm) {
      // Item still contributes a hard space when it carried an EOL — that
      // way line breaks separate words in the search corpus.
      if (it.hasEOL || prevEOL) {
        out.push(' ');
        map.push({ itemIndex: i, offset: 0 });
      }
      prevEOL = !!it.hasEOL;
      continue;
    }

    // Rejoin line-break hyphenation BEFORE we insert any seam-space: if the
    // previous item carried an EOL flag and ended with "-", and the current
    // item starts with a lowercase letter, drop the trailing hyphen and
    // skip the separator entirely so "contract-\nual" → "contractual".
    let rejoined = false;
    if (
      prevEOL &&
      out.length > 0 &&
      out[out.length - 1] === '-' &&
      /^[a-zа-яёїієґ]/i.test(norm)
    ) {
      out.pop();
      map.pop();
      rejoined = true;
    }

    // Otherwise insert a separator space between items so adjacent words
    // don't collapse ("Total"+"amount" stays searchable as "Total amount").
    if (!rejoined && out.length > 0) {
      const tail = out[out.length - 1];
      if (tail !== ' ' && !/^\s/.test(norm)) {
        out.push(' ');
        map.push({ itemIndex: i, offset: 0 });
      }
    }

    // Build a parallel raw-norm index so the charMap points at the right
    // source offset. We walk raw and norm together: characters that disappear
    // (e.g. soft hyphen) consume raw without emitting norm.
    let rawIdx = 0;
    // Reproduce the same character-class collapses we did up top, but tied
    // to per-character bookkeeping.
    for (let j = 0; j < norm.length; j += 1) {
      const ch = norm[j];
      // Find the next non-stripped raw char that yields this normalized one.
      while (rawIdx < raw.length) {
        const rc = raw[rawIdx];
        // Stripped categories: soft hyphen, zero-width.
        if (/[­​-‍﻿]/.test(rc)) { rawIdx += 1; continue; }
        break;
      }
      out.push(ch);
      map.push({ itemIndex: i, offset: Math.min(rawIdx, raw.length - 1) });
      rawIdx += 1;
    }

    prevEOL = !!it.hasEOL;
  }

  return { normText: out.join(''), charMap: map };
}

// ---- span search -----------------------------------------------------------

/** Find a normalized substring inside a normalized page string. First
 *  occurrence wins. Falls back to a clause-number anchor (e.g. "п. 4.1" →
 *  search for "4.1") when the literal quote isn't found. */
export function findSpan(normText, normFrom, { clause } = {}) {
  if (!normText) return null;
  if (normFrom && normFrom.length > 0) {
    const idx = normText.indexOf(normFrom);
    if (idx >= 0) return { start: idx, end: idx + normFrom.length };
  }
  if (clause) {
    const m = String(clause).match(/\d+(?:\.\d+)+|\d+/);
    if (m) {
      const tok = m[0];
      const idx = normText.indexOf(tok);
      if (idx >= 0) return { start: idx, end: idx + tok.length };
    }
  }
  return null;
}

// ---- coordinate math -------------------------------------------------------

/** Multiply two 6-element affine matrices (PDF.js Util.transform shape). */
function _mul(a, b) {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

function _apply([a, b, c, d, e, f], x, y) {
  return [a * x + c * y + e, b * x + d * y + f];
}

/** Build viewport-space rectangles for a span. Groups consecutive chars
 *  in the same text item, then projects each per-item intra-range into
 *  viewport coords via the proportional-width approximation Mozilla's
 *  text-layer renderer uses (PDF.js does not expose per-char widths). For
 *  rotated/sheared text we return a conservative axis-aligned bounding
 *  box of the rotated quad — TODO marker for a future RTL/rotated pass. */
export function spanToRects(items, charMap, span, viewport) {
  if (!items || !charMap || !span || !viewport) return [];
  if (span.start >= span.end) return [];
  if (span.end > charMap.length) return [];

  // 1. Group consecutive chars in the same item into per-item ranges.
  const groups = [];
  let cur = null;
  for (let i = span.start; i < span.end; i += 1) {
    const m = charMap[i];
    if (!m) continue;
    if (cur && cur.itemIndex === m.itemIndex) {
      cur.charEnd = i + 1; // exclusive
    } else {
      cur = { itemIndex: m.itemIndex, charStart: i, charEnd: i + 1, firstOffset: m.offset };
      groups.push(cur);
    }
  }

  // 2. Project each group to a viewport rect.
  const out = [];
  const vt = viewport.transform || [1, 0, 0, 1, 0, 0];
  const scale = typeof viewport.scale === 'number' ? viewport.scale : 1;
  for (const g of groups) {
    const item = items[g.itemIndex];
    if (!item) continue;
    const strLen = (item.str || '').length;
    if (strLen === 0) continue;
    // Map norm-string chars back to a fraction of item.str length. We use
    // the firstOffset of the group as the anchor and count emitted chars.
    const fracL = clamp01((g.firstOffset || 0) / strLen);
    const fracR = clamp01((g.firstOffset + (g.charEnd - g.charStart)) / strLen);
    const itemW = item.width || 0;
    const itemH = item.height || 0;

    const it = item.transform || [1, 0, 0, 1, 0, 0];
    const m = _mul(vt, it);
    const rotated = Math.abs(m[1]) > 1e-3 || Math.abs(m[2]) > 1e-3;

    if (!rotated) {
      // Upright text: y of the baseline = m[5]; top-y = m[5] - itemH * scale.
      // We tack on a small padding so the highlight visually "wraps" the
      // whole word rather than leaving a hairline edge — proportional-width
      // approximations can underestimate the right edge of glyphs with
      // wide bearings (italic f, …). 2 px of horizontal slack + 1 px
      // vertical reads as "covers the word" to the eye.
      const baselineY = m[5];
      const baselineX = m[4];
      const PAD_X = 2;
      const PAD_Y = 1;
      const x = baselineX + itemW * fracL * scale - PAD_X;
      const w = itemW * (fracR - fracL) * scale + PAD_X * 2;
      const h = itemH * scale + PAD_Y * 2;
      out.push({ x, y: baselineY - h + PAD_Y, w, h });
    } else {
      // Rotated/sheared: return the AABB of the four projected corners.
      const xLocalL = itemW * fracL;
      const xLocalR = itemW * fracR;
      const corners = [
        _apply(m, xLocalL, 0),
        _apply(m, xLocalR, 0),
        _apply(m, xLocalR, itemH),
        _apply(m, xLocalL, itemH),
      ];
      const xs = corners.map(p => p[0]);
      const ys = corners.map(p => p[1]);
      const minX = Math.min(...xs), maxX = Math.max(...xs);
      const minY = Math.min(...ys), maxY = Math.max(...ys);
      out.push({ x: minX, y: minY, w: maxX - minX, h: maxY - minY });
    }
  }

  // 3. Merge adjacent rects on the same baseline so soft seams between text
  //    items don't paint as visible gaps.
  return mergeAdjacentRects(out);
}

function clamp01(n) { return n < 0 ? 0 : n > 1 ? 1 : n; }

/** Merge rects with the same baseline (within 2 px) whose horizontal extents
 *  are within roughly a wide space-character of each other. The gap
 *  tolerance is `last.h * 1.1` — wide enough to absorb the inter-item
 *  space gap PDF.js carves between text runs on the same line, plus the
 *  occasional double-space, but tight enough to keep clearly separate
 *  phrases apart. Eliminates visible seams inside the same highlighted
 *  word/phrase. */
export function mergeAdjacentRects(rects) {
  if (!rects || rects.length < 2) return rects || [];
  const Y_TOL = 3;
  const out = [];
  for (const r of rects) {
    const last = out[out.length - 1];
    const xTol = last ? Math.max(4, last.h * 1.1) : 4;
    if (
      last &&
      Math.abs(last.y - r.y) < Y_TOL &&
      Math.abs(last.h - r.h) < Y_TOL &&
      last.x + last.w + xTol >= r.x
    ) {
      const right = Math.max(last.x + last.w, r.x + r.w);
      last.w = right - last.x;
    } else {
      out.push({ ...r });
    }
  }
  return out;
}

// ---- top-level convenience -------------------------------------------------

/** Map every finding to its rectangle list across the supplied pages. The
 *  caller (AnalysisView) keeps `pages` updated as PdfViewer renders them,
 *  and re-runs this on zoom/resize/finding-change.
 *
 *  `pages` shape: `[{ pageNumber, textContent, viewport }]` — textContent
 *  is what `page.getTextContent()` returns; viewport is the same one used
 *  to render the canvas. */
export function findingsToHighlights(pages, findings) {
  if (!pages || !findings) return [];
  const indices = pages.map(p => ({
    pageNumber: p.pageNumber,
    items: (p.textContent && p.textContent.items) || [],
    viewport: p.viewport,
    ...buildPageIndex(p.textContent || { items: [] }),
  }));
  const out = [];
  for (const f of findings) {
    const fromRaw = f && f.suggest && f.suggest.from;
    const normFrom = normalizeForMatch(fromRaw || '');
    let placed = null;
    for (const p of indices) {
      const span = findSpan(p.normText, normFrom, { clause: f.clause });
      if (!span) continue;
      const rects = spanToRects(p.items, p.charMap, span, p.viewport);
      placed = {
        findingId: f.id,
        page: p.pageNumber,
        rects,
        matched: true,
        level: f.level || 'info',
      };
      break;
    }
    if (placed) out.push(placed);
    else out.push({
      findingId: f.id,
      page: null,
      rects: [],
      matched: false,
      level: f.level || 'info',
    });
  }
  return out;
}
