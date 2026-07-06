import { describe, it, expect } from 'vitest';
import { sectionsToMarkdown } from './exportDoc';

describe('sectionsToMarkdown', () => {
  it('returns empty string for empty / undefined input', () => {
    expect(sectionsToMarkdown([])).toBe('');
    expect(sectionsToMarkdown(undefined)).toBe('');
    expect(sectionsToMarkdown(null)).toBe('');
  });

  it('joins sections with a horizontal-rule separator and ## header', () => {
    const md = sectionsToMarkdown([
      { number: '1.', title: 'ПРЕДМЕТ', text: 'Продавець зобов’язується.' },
      { number: '2.', title: 'ЦІНА', text: '100 000 грн.' },
    ]);
    expect(md).toBe(
      '## 1. ПРЕДМЕТ\n\nПродавець зобов’язується.\n\n---\n\n## 2. ЦІНА\n\n100 000 грн.',
    );
  });

  it('handles sections without a title (body-only)', () => {
    const md = sectionsToMarkdown([
      { number: '', title: '', text: 'Просто параграф.' },
    ]);
    expect(md).toBe('Просто параграф.');
  });

  it('handles sections with only a title (no body)', () => {
    const md = sectionsToMarkdown([
      { number: '3.', title: 'РІЗНЕ', text: '' },
    ]);
    expect(md).toBe('## 3. РІЗНЕ\n\n');
  });
});
