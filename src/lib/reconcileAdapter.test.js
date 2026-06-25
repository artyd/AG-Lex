import { describe, it, expect } from 'vitest';
import {
  reconcileToFindings,
  reconcileToComparison,
  reconcileToScore,
  reconcileToAnalysisProps,
  snippetForCat,
} from './reconcileAdapter';

describe('reconcileToFindings', () => {
  it('maps severity → level for the full table', () => {
    const run = {
      findings: [
        { id: 'a', severity: 'must',   cat: 'incoterms', location: 'п. 2.3', issue: 'X', rec: 'Y' },
        { id: 'b', severity: 'should', cat: 'payment',   location: 'п. 4.1', issue: 'X', rec: 'Y' },
        { id: 'c', severity: 'nice',   cat: 'packaging', location: 'п. 7',   issue: 'X', rec: 'Y' },
        { id: 'd', severity: 'flag',   cat: 'origin',    location: 'п. 1',   issue: 'X', rec: 'Y' },
      ],
    };
    const levels = reconcileToFindings(run).map((f) => f.level);
    expect(levels).toEqual(['high', 'med', 'low', 'info']);
  });

  it('flows issue→title, rec→desc, location→clause; id falls back to f.id', () => {
    const run = {
      findings: [
        { id: 'X', severity: 'must',   cat: '',   location: 'п. 4', issue: 'I', rec: 'R' },
        { id: 'Y', severity: 'should', cat: 'pq', location: '',     issue: 'I', rec: 'R' },
      ],
    };
    const out = reconcileToFindings(run);
    expect(out[0].id).toBe('X');
    expect(out[0].clause).toBe('п. 4');
    expect(out[0].title).toBe('I');
    expect(out[0].desc).toBe('R');
    expect(out[1].id).toBe('pq');
  });

  it('leaves law null and falls back to suggest:null when no docs snippet exists', () => {
    const run = { findings: [{ id: 'a', severity: 'must', issue: 'i', rec: 'r' }] };
    const f = reconcileToFindings(run)[0];
    expect(f.law).toBe(null);
    expect(f.suggest).toBe(null);
  });

  it('derives suggest.from from docs.contract when category matches', () => {
    const run = {
      findings: [{ id: 'a', severity: 'must', cat: 'incoterms', issue: 'i', rec: 'r' }],
      docs: {
        contract: {
          sections: [{
            uaP: [
              { t: 'CIF Гданськ, MSC/Maersk до 12.04.2026', cat: 'incoterms', st: 'mismatch' },
              { t: 'CIF', cat: 'incoterms', st: 'mismatch' },
            ],
          }],
        },
      },
    };
    const f = reconcileToFindings(run)[0];
    expect(f.suggest).toEqual({ from: 'CIF Гданськ, MSC/Maersk до 12.04.2026', to: '' });
  });

  it('handles missing/empty findings without crashing', () => {
    expect(reconcileToFindings(null)).toEqual([]);
    expect(reconcileToFindings({})).toEqual([]);
    expect(reconcileToFindings({ findings: [] })).toEqual([]);
  });
});

describe('snippetForCat', () => {
  it('returns the longest matching fragment across uaP and enP', () => {
    const docs = {
      contract: {
        sections: [
          { uaP: [{ t: 'short', cat: 'price', st: 'mismatch' }] },
          { enP: [{ t: 'a much longer fragment about price', cat: 'price', st: 'mismatch' }] },
        ],
      },
    };
    expect(snippetForCat(docs, 'price')).toBe('a much longer fragment about price');
  });

  it('ignores cat:"plain" and st:"ok" fragments', () => {
    const docs = {
      contract: {
        sections: [{
          uaP: [
            { t: 'this is plain text and should be ignored', cat: 'plain', st: 'ok' },
            { t: 'this is also ignored', cat: 'price', st: 'ok' },
            { t: '25 kg', cat: 'price', st: 'mismatch' },
          ],
        }],
      },
    };
    expect(snippetForCat(docs, 'price')).toBe('25 kg');
  });

  it('returns null when no fragment matches', () => {
    expect(snippetForCat(null, 'price')).toBe(null);
    expect(snippetForCat({}, 'price')).toBe(null);
    expect(snippetForCat({ contract: { sections: [] } }, 'price')).toBe(null);
    expect(snippetForCat({ contract: { sections: [{ uaP: [{ t: 'x', cat: 'other', st: 'mismatch' }] }] } }, 'price')).toBe(null);
  });
});

describe('reconcileToComparison', () => {
  it('translates row status to the analyze comparison status', () => {
    const run = {
      rows: [
        { key: 'price',     name: 'Ціна',     status: 'ok',       reason: '' },
        { key: 'incoterms', name: 'Incoterms', status: 'mismatch', reason: 'CIF vs FCA' },
        { key: 'payment',   name: 'Оплата',   status: 'flag',     reason: 'розбіжність' },
        { key: 'extra',     name: 'Extra',     status: 'absent',   reason: '' },
      ],
    };
    const out = reconcileToComparison(run);
    expect(out.map((c) => c.status)).toEqual(['ok', 'deviate', 'warn', 'missing']);
    expect(out[1].note).toBe('CIF vs FCA');
  });
});

describe('reconcileToScore', () => {
  it('matches the Library row formula (100 − 12·must − 5·should)', () => {
    expect(reconcileToScore({ mustCount: 0, shouldCount: 0 }).value).toBe(100);
    expect(reconcileToScore({ mustCount: 1, shouldCount: 1 }).value).toBe(83);
    expect(reconcileToScore({ mustCount: 3, shouldCount: 0 }).value).toBe(64);
  });
  it('clips to 0 instead of going negative', () => {
    expect(reconcileToScore({ mustCount: 100, shouldCount: 0 }).value).toBe(0);
  });
});

describe('reconcileToAnalysisProps', () => {
  it('emits two documents (contract + handover) with derived sections', () => {
    const run = {
      contractFile: 'contract.docx',
      handoverFile: 'handover.xlsx',
      docs: {
        contract: {
          sections: [
            { n: '1', ua: 'Предмет', en: 'Subject',
              uaP: [{ t: 'Підлягає постачанню субстанції X у кількості 25 кг.', cat: 'plain', st: 'ok' }],
              enP: [{ t: 'Substance X delivered, qty 25 kg.', cat: 'plain', st: 'ok' }] },
          ],
        },
        handover: {
          appendix: 'Додаток №1',
          title: 'Лист погодження',
          rows: [
            { n: '1', label: 'Інкотермс', value: 'CIF Гданськ' },
            { n: '2', label: 'Оплата',    value: '30/70' },
          ],
        },
      },
      findings: [],
      rows: [],
      mustCount: 0,
      shouldCount: 0,
    };
    const props = reconcileToAnalysisProps(run);
    expect(props.documents).toHaveLength(2);
    expect(props.documents[0].label).toBe('contract.docx');
    expect(props.documents[0].filename).toBe('contract.docx');
    expect(props.documents[0].sections).toHaveLength(1);
    expect(props.documents[0].sections[0].number).toBe('1');
    expect(props.documents[0].sections[0].text).toContain('25 кг');
    expect(props.documents[1].label).toBe('handover.xlsx');
    expect(props.documents[1].sections[0].text).toContain('Інкотермс');
    expect(props.legalBasis).toEqual([]);
    expect(props.warnings).toEqual([]);
  });

  it('returns empty sections when docs payload is absent', () => {
    const run = { contractFile: 'c.docx', handoverFile: 'h.xlsx', findings: [], rows: [], mustCount: 0, shouldCount: 0 };
    const props = reconcileToAnalysisProps(run);
    expect(props.documents[0].sections).toEqual([]);
    expect(props.documents[1].sections).toEqual([]);
  });
});
