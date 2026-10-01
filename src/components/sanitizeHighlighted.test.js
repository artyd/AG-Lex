import { describe, expect, it } from 'vitest';
import { sanitizeHighlighted } from './sanitizeHighlighted';

describe('sanitizeHighlighted', () => {
  it('escapes raw HTML from the document', () => {
    const out = sanitizeHighlighted('Hi <img src=x onerror="alert(1)"> & <script>x</script>');
    expect(out).not.toMatch(/<img|<script/);
    expect(out).toContain('&lt;img');
    expect(out).toContain('&amp;');
  });

  it('keeps backend marks with allowlisted attributes only', () => {
    const src = 'a <mark class="doc-error err-high" data-error-id="e1" data-error-type="typo" '
      + 'data-explanation="x &lt;b&gt;" onclick="evil()">word</mark> b';
    const out = sanitizeHighlighted(src);
    expect(out).toContain('<mark class="doc-error err-high" data-error-id="e1" data-error-type="typo" data-explanation="x &lt;b&gt;">word</mark>');
    expect(out).not.toContain('onclick');
  });

  it('escapes a stray closing mark and closes unbalanced openers', () => {
    expect(sanitizeHighlighted('x</mark>y')).toBe('x&lt;/mark&gt;y');
    expect(sanitizeHighlighted('<mark class="doc-error">open')).toBe('<mark class="doc-error">open</mark>');
  });
});
