import { describe, it, expect } from 'vitest';
import { applyFixToMarkdown } from './ContractAnalysis';

const doc = [
  '## 1. ПРЕДМЕТ',
  '',
  'Продавець передає товар покупцю в термін до 15 днів.',
  '',
  '---',
  '',
  '## 2. ВІДПОВІДАЛЬНІСТЬ',
  '',
  'Відповідальність обмежена сумою 50 000 грн.',
].join('\n');

describe('applyFixToMarkdown', () => {
  it('replaces the first match of suggest.from with suggest.to and returns the new range', () => {
    const { markdown, changedRange } = applyFixToMarkdown(doc, {
      suggest: { from: 'обмежена сумою 50 000 грн', to: 'дорівнює 100% від ціни договору' },
    });
    expect(markdown).toContain('дорівнює 100% від ціни договору');
    expect(markdown).not.toContain('обмежена сумою 50 000 грн');
    expect(changedRange).not.toBeNull();
    expect(markdown.slice(changedRange.from, changedRange.to)).toBe('дорівнює 100% від ціни договору');
  });

  it('is tolerant of whitespace variance in the anchor', () => {
    const { markdown, changedRange } = applyFixToMarkdown(doc, {
      suggest: { from: 'Продавець   передає\nтовар', to: 'Постачальник вручає товар' },
    });
    expect(markdown).toContain('Постачальник вручає товар');
    expect(changedRange).not.toBeNull();
  });

  it('returns null changedRange when anchor is not present', () => {
    const { markdown, changedRange } = applyFixToMarkdown(doc, {
      suggest: { from: 'фраза, якої немає в договорі', to: 'нове' },
    });
    expect(markdown).toBe(doc);
    expect(changedRange).toBeNull();
  });

  it('returns null changedRange when suggest is missing', () => {
    const r1 = applyFixToMarkdown(doc, {});
    expect(r1.markdown).toBe(doc);
    expect(r1.changedRange).toBeNull();
    const r2 = applyFixToMarkdown(doc, { suggest: { from: '', to: '' } });
    expect(r2.markdown).toBe(doc);
    expect(r2.changedRange).toBeNull();
  });
});
