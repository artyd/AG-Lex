import { describe, it, expect } from 'vitest';
import { sectionsToMarkdown } from './exportDoc';

describe('sectionsToMarkdown', () => {
  it('returns empty string for empty / undefined input', () => {
    expect(sectionsToMarkdown([])).toBe('');
    expect(sectionsToMarkdown(undefined)).toBe('');
    expect(sectionsToMarkdown(null)).toBe('');
  });

  it('joins sections with blank lines and a ## header (no hr)', () => {
    const md = sectionsToMarkdown([
      { number: '1.', title: 'ПРЕДМЕТ', text: 'Продавець зобов’язується.' },
      { number: '2.', title: 'ЦІНА', text: '100 000 грн.' },
    ]);
    expect(md).toBe(
      '## 1. ПРЕДМЕТ\n\nПродавець зобов’язується.\n\n## 2. ЦІНА\n\n100 000 грн.',
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

  it('renders sub-points (1.1, 2.3) as inline paragraphs, not H2', () => {
    const md = sectionsToMarkdown([
      { number: '1.', title: 'ПРЕДМЕТ', text: 'Головне зобовʼязання.' },
      { number: '1.1', title: '', text: 'Постачальник передає товар покупцю.' },
      { number: '1.2', title: '', text: 'Разом з товаром — сертифікат.' },
      { number: '2.', title: 'ЦІНА', text: '' },
    ]);
    expect(md).toBe(
      '## 1. ПРЕДМЕТ\n\nГоловне зобовʼязання.'
      + '\n\n1.1 Постачальник передає товар покупцю.'
      + '\n\n1.2 Разом з товаром — сертифікат.'
      + '\n\n## 2. ЦІНА\n\n',
    );
  });
});
