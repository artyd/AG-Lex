/* ============================================================
   Pure mapper: finding (from /api/analyze/contract) → text segments.

   Given a section's plain text and the findings the analyzer attached to
   that section, produce a "parts" array the renderer can walk:

     [ "before text", { f, matched: "the quoted fragment" }, "after text" ]

   Matching is loose on the things that always differ between a contract
   and a model-quoted snippet — whitespace runs and quote characters — and
   strict on everything else (so we never silently highlight the wrong
   clause). Unmatched findings get returned in `fallback` so the renderer
   can decorate the section heading instead.

   No DOM, no React — kept pure so the unit test can run under node.
   ============================================================ */

/** Pull the bare clause number out of a label like "п. 4.1" → "4.1". */
export function clauseNumOf(clauseStr) {
  if (clauseStr == null) return null;
  const m = String(clauseStr).match(/\d+(?:\.\d+)*/);
  return m ? m[0] : null;
}

/** Escape user text for use inside a RegExp. */
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Build a loose-match regex from a quoted fragment.
 *  - strips wrapping quotes (« » " ' " ' ’ ‘) the model often adds
 *  - collapses any whitespace run to \s+ so soft-wraps don't break the match
 *  - treats any double-quote-ish char as interchangeable
 *  Returns null when the input is empty after trimming. */
export function buildFromRegex(from) {
  if (typeof from !== 'string') return null;
  const stripped = from
    .replace(/^[«»"“”'‘’\s]+/, '')
    .replace(/[«»"“”'‘’\s]+$/, '')
    .trim();
  if (!stripped) return null;
  const body = escapeRegex(stripped)
    .replace(/\s+/g, '\\s+')
    .replace(/["“”«»]/g, '[«»"“”]')
    .replace(/['‘’]/g, "['‘’]");
  try { return new RegExp(body); }
  catch (_e) { return null; }
}

/** Find one finding's `suggest.from` in `text`. Returns {start,end,matched}
 *  in the original text's coordinates, or null when not found. */
export function findFragment(text, from) {
  if (!text || typeof text !== 'string') return null;
  const re = buildFromRegex(from);
  if (!re) return null;
  const m = re.exec(text);
  if (!m) return null;
  return { start: m.index, end: m.index + m[0].length, matched: m[0] };
}

/** Group findings by the section number their `clause` mentions.
 *  Returns a Map<sectionNumberString, finding[]>. Findings without a number
 *  fall under the key "". */
export function groupFindingsByClause(findings) {
  const map = new Map();
  for (const f of findings || []) {
    const num = clauseNumOf(f.clause) || '';
    if (!map.has(num)) map.set(num, []);
    map.get(num).push(f);
  }
  return map;
}

/** Build the parts array for one paragraph of text. Tries each finding's
 *  `suggest.from` against `text`; non-overlapping matches sorted by start.
 *  Returns { parts, matched: Set<finding.id>, unmatched: finding[] }. */
export function buildHighlightParts(text, findings) {
  const matchedIds = new Set();
  const unmatched = [];
  const hits = [];
  for (const f of findings || []) {
    const from = f && f.suggest && f.suggest.from;
    const hit = findFragment(text, from);
    if (hit) hits.push({ f, ...hit });
    else unmatched.push(f);
  }
  // Sort by start; resolve overlaps by preferring the earlier hit (drop later
  // overlapping ones into `unmatched` so the panel still surfaces them).
  hits.sort((a, b) => a.start - b.start);
  const kept = [];
  let cursor = 0;
  for (const h of hits) {
    if (h.start < cursor) { unmatched.push(h.f); continue; }
    kept.push(h);
    cursor = h.end;
  }
  if (kept.length === 0) {
    return { parts: text ? [text] : [], matched: matchedIds, unmatched };
  }
  const parts = [];
  let i = 0;
  for (const h of kept) {
    if (h.start > i) parts.push(text.slice(i, h.start));
    parts.push({ f: h.f, matched: text.slice(h.start, h.end) });
    matchedIds.add(h.f.id);
    i = h.end;
  }
  if (i < text.length) parts.push(text.slice(i));
  return { parts, matched: matchedIds, unmatched };
}
