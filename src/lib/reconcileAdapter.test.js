import { describe, it, expect } from 'vitest';
import {
  reconcileToFindings,
  reconcileToComparison,
  reconcileToScore,
  reconcileToAnalysisProps,
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

  it('leaves law and suggest null on every output', () => {
    const run = { findings: [{ id: 'a', severity: 'must', issue: 'i', rec: 'r' }] };
    const f = reconcileToFindings(run)[0];
    expect(f.law).toBe(null);
    expect(f.suggest).toBe(null);
  });

  it('handles missing/empty findings without crashing', () => {
    expect(reconcileToFindings(null)).toEqual([]);
    expect(reconcileToFindings({})).toEqual([]);
    expect(reconcileToFindings({ findings: [] })).toEqual([]);
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
  it('emits two documents (contract + handover) with both display URLs', () => {
    const run = {
      contractFile: 'contract.docx',
      handoverFile: 'handover.xlsx',
      displayPdfUrl: '/api/reconciliations/r-1/contract-display.pdf',
      handoverDisplayPdfUrl: '/api/reconciliations/r-1/handover-display.pdf',
      findings: [],
      rows: [],
      mustCount: 0,
      shouldCount: 0,
    };
    const props = reconcileToAnalysisProps(run);
    expect(props.documents).toHaveLength(2);
    expect(props.documents[0].label).toBe('contract.docx');
    expect(props.documents[1].label).toBe('handover.xlsx');
    expect(props.documents[0].displayPdfUrl).toMatch(/contract-display\.pdf$/);
    expect(props.documents[1].displayPdfUrl).toMatch(/handover-display\.pdf$/);
    expect(props.legalBasis).toEqual([]);
    expect(props.warnings).toEqual([]);
  });
});
