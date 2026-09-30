/* ============================================================
   sanitizeHighlighted — make the backend's "markdown with inlined
   <mark>" safe for dangerouslySetInnerHTML.

   The document text comes from user uploads (converter output can
   carry raw HTML such as <img onerror=…>), so everything is escaped
   except the exact <mark> shape documents_routes.build_highlighted
   emits. Those tags are rebuilt from an attribute allowlist; their
   values are already attribute-escaped by the backend and cannot
   contain a double quote (the regex stops at it).
   ============================================================ */

const MARK_OPEN = /^<mark\s[^>]*>$/i;
const TOKENS = /(<mark\s[^>]*>|<\/mark>)/gi;
const ATTR = /([a-z-]+)="([^"<>]*)"/gi;
const ALLOWED = new Set(['class', 'data-error-id', 'data-error-type', 'data-explanation']);

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function rebuildMark(tag) {
  const attrs = [];
  let m;
  ATTR.lastIndex = 0;
  while ((m = ATTR.exec(tag)) !== null) {
    const name = m[1].toLowerCase();
    if (!ALLOWED.has(name)) continue;
    // class is ours ("doc-error err-high"): keep only class-name characters.
    const value = name === 'class' ? m[2].replace(/[^a-z0-9 _-]/gi, '') : m[2];
    attrs.push(`${name}="${value}"`);
  }
  return `<mark ${attrs.join(' ')}>`;
}

export function sanitizeHighlighted(src) {
  if (!src) return '';
  let depth = 0;
  return String(src)
    .split(TOKENS)
    .map((part) => {
      if (MARK_OPEN.test(part)) { depth += 1; return rebuildMark(part); }
      if (/^<\/mark>$/i.test(part)) {
        if (depth === 0) return escapeHtml(part);  // stray closer from the document itself
        depth -= 1;
        return '</mark>';
      }
      return escapeHtml(part);
    })
    .join('') + '</mark>'.repeat(depth);
}
