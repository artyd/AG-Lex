import { describe, it, expect } from 'vitest';
import {
  normalizeForMatch,
  buildPageIndex,
  findSpan,
  spanToRects,
  mergeAdjacentRects,
  findingsToHighlights,
} from './pdfHighlight';

// PDF.js typical viewport for a 600x800 PDF rendered at scale 1.5:
// - viewport.scale = 1.5
// - viewport.transform = [1.5, 0, 0, -1.5, 0, 1200] (y-flip + page-height shift)
const VIEWPORT = { scale: 1.5, transform: [1.5, 0, 0, -1.5, 0, 1200] };

// Helper: build a text item at PDF coords (x_pdf, y_pdf) with the given
// font height, text, and optional hasEOL flag. PDF.js's item.width is the
// rendered text width in PDF page units; we approximate as len * h * 0.5.
function item(str, x, y, h = 12, { hasEOL = false, width } = {}) {
  return {
    str,
    transform: [h, 0, 0, h, x, y],
    width: width != null ? width : str.length * h * 0.5,
    height: h,
    hasEOL,
  };
}

describe('normalizeForMatch', () => {
  it('collapses whitespace and unifies quotes', () => {
    expect(normalizeForMatch('  Hello   «world»  '))
      .toBe('Hello "world"');
    expect(normalizeForMatch('it’s a test'))
      .toBe("it's a test");
  });
  it('strips soft hyphens and zero-width chars', () => {
    expect(normalizeForMatch('con­tract')).toBe('contract');
    expect(normalizeForMatch('ab​cd')).toBe('abcd');
  });
  it('unifies dash variants', () => {
    expect(normalizeForMatch('non–returnable')).toBe('non-returnable');
    expect(normalizeForMatch('non—returnable')).toBe('non-returnable');
  });
});

describe('buildPageIndex + findSpan', () => {
  it('finds an exact ASCII span across a single item', () => {
    const tc = { items: [item('Total amount: 100', 50, 800)] };
    const { normText, charMap } = buildPageIndex(tc);
    expect(normText).toBe('Total amount: 100');
    const span = findSpan(normText, 'Total amount');
    expect(span).toEqual({ start: 0, end: 12 });
    // charMap maps each char back to (itemIndex, offset).
    expect(charMap[0]).toEqual({ itemIndex: 0, offset: 0 });
    expect(charMap[normText.length - 1].itemIndex).toBe(0);
  });

  it('matches quote-normalized text', () => {
    const tc = { items: [item('the “party” pays', 50, 800)] };
    const { normText } = buildPageIndex(tc);
    expect(normText).toBe('the "party" pays');
    const span = findSpan(normText, normalizeForMatch('the "party" pays'));
    expect(span).toEqual({ start: 0, end: 16 });
  });

  it('rejoins line-break hyphenation across two items', () => {
    const tc = {
      items: [
        item('contract-', 50, 800, 12, { hasEOL: true }),
        item('ual', 50, 770),
      ],
    };
    const { normText, charMap } = buildPageIndex(tc);
    expect(normText).toBe('contractual');
    expect(charMap[0]).toEqual({ itemIndex: 0, offset: 0 });
    // The "ual" portion should map back into item 1.
    expect(charMap[8].itemIndex).toBe(1);
  });

  it('falls back to a clause-number anchor when the quote is not found', () => {
    const tc = { items: [item('Section 4.1 — payment', 50, 800)] };
    const { normText } = buildPageIndex(tc);
    expect(findSpan(normText, 'non-existent quote')).toBe(null);
    const span = findSpan(normText, 'nope', { clause: 'п. 4.1' });
    expect(span).not.toBe(null);
    expect(normText.slice(span.start, span.end)).toBe('4.1');
  });

  it('returns null when neither quote nor clause hit', () => {
    const tc = { items: [item('plain text', 50, 800)] };
    const { normText } = buildPageIndex(tc);
    expect(findSpan(normText, 'qqq', { clause: 'preamble' })).toBe(null);
  });
});

describe('spanToRects', () => {
  it('emits one rect per item for a within-item span', () => {
    const it1 = item('Total amount', 50, 800, 12);
    const tc = { items: [it1] };
    const { charMap } = buildPageIndex(tc);
    const span = { start: 0, end: 5 }; // "Total"
    const rects = spanToRects(tc.items, charMap, span, VIEWPORT);
    expect(rects).toHaveLength(1);
    // Y-flipped viewport: baseline in viewport y = 1200 - 1.5 * 800 = 0.
    // text top-y = baseline - h*scale = 0 - 12*1.5 = -18 (off-screen but
    // geometrically consistent for this synthetic page).
    // PAD_X = 2 in spanToRects so the rect "wraps" the word visually —
    // verify within ±3 px (covers padding + sub-pixel rounding).
    expect(Math.abs(rects[0].x - 50 * 1.5)).toBeLessThanOrEqual(3);
    expect(rects[0].h).toBeGreaterThan(12 * 1.5);
    expect(rects[0].w).toBeGreaterThan(0);
  });

  it('merges multi-item single-line spans into one rect', () => {
    // Two items on the same baseline, touching: "Total " (50→50+36) and "amount" (86→128).
    const a = item('Total ', 50, 800, 12, { width: 36 });
    const b = item('amount', 86, 800, 12, { width: 42 });
    const tc = { items: [a, b] };
    const { normText, charMap } = buildPageIndex(tc);
    // Find the joined span "Total amount" in the normalized text.
    const idx = normText.indexOf('Total amount');
    expect(idx).toBeGreaterThanOrEqual(0);
    const span = { start: idx, end: idx + 'Total amount'.length };
    const rects = spanToRects(tc.items, charMap, span, VIEWPORT);
    // Adjacent items on the same baseline → mergeAdjacentRects collapses to 1.
    expect(rects).toHaveLength(1);
    expect(Math.abs(rects[0].x - 50 * 1.5)).toBeLessThanOrEqual(3);
    expect(rects[0].w).toBeGreaterThan(60);
  });

  it('returns separate rects for a multi-line span', () => {
    // Line 1 at y=800, line 2 at y=770 (12pt drop).
    const a = item('first line', 50, 800, 12, { width: 60 });
    const b = item('second line', 50, 770, 12, { width: 66 });
    const tc = { items: [a, b] };
    const { normText, charMap } = buildPageIndex(tc);
    // Span "line second" actually crosses both items (last word of line 1 +
    // first word of line 2). The end position is the start of " line" in
    // line 2 — keeps the span symmetric.
    const idx = normText.indexOf('line second');
    expect(idx).toBeGreaterThanOrEqual(0);
    const span = { start: idx, end: idx + 'line second'.length };
    const rects = spanToRects(tc.items, charMap, span, VIEWPORT);
    // Different baselines → no x/y-tolerance merge.
    expect(rects.length).toBeGreaterThanOrEqual(2);
    const ys = rects.map(r => r.y);
    expect(Math.abs(ys[0] - ys[1])).toBeGreaterThan(10);
  });
});

describe('mergeAdjacentRects', () => {
  it('merges touching rects on the same baseline', () => {
    const merged = mergeAdjacentRects([
      { x: 10, y: 100, w: 20, h: 14 },
      { x: 31, y: 100, w: 25, h: 14 },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].x).toBe(10);
    expect(merged[0].w).toBe(46); // 56 - 10
  });
  it('keeps rects on different baselines separate', () => {
    const merged = mergeAdjacentRects([
      { x: 10, y: 100, w: 20, h: 14 },
      { x: 31, y: 130, w: 25, h: 14 },
    ]);
    expect(merged).toHaveLength(2);
  });
});

describe('findingsToHighlights', () => {
  it('places matched findings on the right page', () => {
    const pages = [
      {
        pageNumber: 1,
        textContent: { items: [item('preamble text', 50, 800)] },
        viewport: VIEWPORT,
      },
      {
        pageNumber: 2,
        textContent: { items: [item('Total amount: 100', 50, 800)] },
        viewport: VIEWPORT,
      },
    ];
    const findings = [
      { id: 'f1', level: 'high', suggest: { from: 'Total amount' } },
      { id: 'f2', level: 'med', suggest: { from: 'no such phrase' } },
    ];
    const hls = findingsToHighlights(pages, findings);
    expect(hls).toHaveLength(2);
    expect(hls[0].findingId).toBe('f1');
    expect(hls[0].page).toBe(2);
    expect(hls[0].matched).toBe(true);
    expect(hls[0].rects.length).toBeGreaterThan(0);
    expect(hls[1].findingId).toBe('f2');
    expect(hls[1].matched).toBe(false);
    expect(hls[1].rects).toEqual([]);
  });
});
