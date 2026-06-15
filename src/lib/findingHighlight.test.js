import { describe, it, expect } from 'vitest';
import {
  clauseNumOf,
  buildFromRegex,
  findFragment,
  groupFindingsByClause,
  buildHighlightParts,
} from './findingHighlight';

describe('clauseNumOf', () => {
  it('extracts numbers from common labels', () => {
    expect(clauseNumOf('п. 4.1')).toBe('4.1');
    expect(clauseNumOf('Пункт 7')).toBe('7');
    expect(clauseNumOf('Стаття 12.3.4 ЦКУ')).toBe('12.3.4');
  });
  it('returns null for empty/non-numeric', () => {
    expect(clauseNumOf('')).toBe(null);
    expect(clauseNumOf(null)).toBe(null);
    expect(clauseNumOf('Преамбула')).toBe(null);
  });
});

describe('buildFromRegex', () => {
  it('matches loose whitespace', () => {
    const re = buildFromRegex('форс  мажор');
    expect('у разі форс мажор настає...'.match(re)[0]).toBe('форс мажор');
  });
  it('matches across line breaks', () => {
    const re = buildFromRegex('форс мажор');
    expect('у разі форс\nмажор настає...'.match(re)[0]).toBe('форс\nмажор');
  });
  it('strips wrapping quotes so inner phrase still matches', () => {
    // Model often quotes verbatim with its own wrap chars — match either way.
    const re = buildFromRegex('«Замовник зобов’язується»');
    expect('коли Замовник зобов’язується платити...'.match(re)[0])
      .toBe('Замовник зобов’язується');
  });
  it('treats double-quote variants as interchangeable', () => {
    const re = buildFromRegex('the "party" pays');
    expect('the “party” pays after 30 days'.match(re)[0]).toBe('the “party” pays');
  });
  it('returns null for empty input', () => {
    expect(buildFromRegex('')).toBe(null);
    expect(buildFromRegex('   « »  ')).toBe(null);
    expect(buildFromRegex(null)).toBe(null);
  });
});

describe('findFragment', () => {
  it('finds the exact citation', () => {
    const text = 'Сторона зобов’язується сплатити 100% протягом 10 днів.';
    const hit = findFragment(text, '100% протягом 10 днів');
    expect(hit).toBeTruthy();
    expect(text.slice(hit.start, hit.end)).toBe('100% протягом 10 днів');
  });
  it('returns null when not found', () => {
    expect(findFragment('hello world', 'something else')).toBe(null);
  });
});

describe('groupFindingsByClause', () => {
  it('buckets findings by clause number', () => {
    const findings = [
      { id: 'a', clause: 'п. 4.1' },
      { id: 'b', clause: 'п. 4.2' },
      { id: 'c', clause: 'п. 4.1' },
      { id: 'd', clause: 'Преамбула' },
    ];
    const m = groupFindingsByClause(findings);
    expect(m.get('4.1').map(f => f.id)).toEqual(['a', 'c']);
    expect(m.get('4.2').map(f => f.id)).toEqual(['b']);
    expect(m.get('').map(f => f.id)).toEqual(['d']);
  });
});

describe('buildHighlightParts', () => {
  const text = 'Замовник зобов’язується сплатити 100% протягом 10 днів від дати акту.';

  it('inserts a finding object for the matched fragment', () => {
    const findings = [{ id: 'f1', level: 'high', suggest: { from: '100% протягом 10 днів', to: '50%...' } }];
    const { parts, matched, unmatched } = buildHighlightParts(text, findings);
    expect(matched.has('f1')).toBe(true);
    expect(unmatched).toEqual([]);
    expect(parts).toHaveLength(3);
    expect(typeof parts[0]).toBe('string');
    expect(parts[1].f.id).toBe('f1');
    expect(parts[1].matched).toBe('100% протягом 10 днів');
    expect(typeof parts[2]).toBe('string');
  });

  it('returns the original text when no findings match', () => {
    const findings = [{ id: 'f1', suggest: { from: 'не існує тут' } }];
    const { parts, matched, unmatched } = buildHighlightParts(text, findings);
    expect(matched.size).toBe(0);
    expect(unmatched.map(f => f.id)).toEqual(['f1']);
    expect(parts).toEqual([text]);
  });

  it('chains multiple non-overlapping matches in order', () => {
    const t = 'A штраф 10% і пеня 0,5% за кожен день прострочення.';
    const findings = [
      { id: 'a', suggest: { from: '0,5%' } },
      { id: 'b', suggest: { from: 'штраф 10%' } },
    ];
    const { parts } = buildHighlightParts(t, findings);
    const ids = parts.filter(p => typeof p !== 'string').map(p => p.f.id);
    expect(ids).toEqual(['b', 'a']);
  });

  it('handles overlapping matches by keeping the earlier one', () => {
    const t = 'десять тисяч гривень з ПДВ';
    const findings = [
      { id: 'a', suggest: { from: 'десять тисяч' } },
      { id: 'b', suggest: { from: 'тисяч гривень' } },
    ];
    const { parts, matched, unmatched } = buildHighlightParts(t, findings);
    const ids = parts.filter(p => typeof p !== 'string').map(p => p.f.id);
    expect(ids).toEqual(['a']);
    expect(matched.has('a')).toBe(true);
    expect(unmatched.map(f => f.id)).toEqual(['b']);
  });

  it('survives missing suggest blocks', () => {
    const findings = [{ id: 'x' }];
    const { parts, matched, unmatched } = buildHighlightParts(text, findings);
    expect(matched.size).toBe(0);
    expect(unmatched.map(f => f.id)).toEqual(['x']);
    expect(parts).toEqual([text]);
  });
});
