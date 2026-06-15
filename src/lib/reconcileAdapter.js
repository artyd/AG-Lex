/* ============================================================
   Map a /api/reconcile run → the unified shape AnalysisView expects.

   Phase 4.x PR4. The single-contract pipeline (/api/analyze/contract)
   already returns the canonical shape; this adapter brings the
   reconcile result alongside it so one AnalysisView screen renders
   both flows.

   Severity mapping table (kept here, not in AnalysisView):
     must   → high
     should → med
     nice   → low
     flag   → info
   ============================================================ */

const SEV_TO_LEVEL = { must: 'high', should: 'med', nice: 'low', flag: 'info' };

const ROW_STATUS_TO_NOTE = {
  ok: 'ok',
  mismatch: 'deviate',
  flag: 'warn',
  absent: 'missing',
  positive: 'ok',
};

/** Convert reconcile findings to the analyze-contract finding shape so the
 *  existing AiPanel / FindingCard / overlay code paths Just Work. */
export function reconcileToFindings(run) {
  const list = (run && run.findings) || [];
  return list.map((f) => ({
    id: String(f.cat || f.id || ''),
    level: SEV_TO_LEVEL[f.severity] || 'info',
    clause: f.location || '',
    weight: 1,
    title: f.issue || '',
    desc: f.rec || '',
    severity: f.severity,
    law: null,
    // No rewrite suggestion in the reconcile schema; AnalysisView's overlay
    // still anchors via clause-number fallback when needed.
    suggest: null,
    _source: f.source || null,
    _verified: f.verified || null,
  }));
}

/** Reduce reconcile rows → the analyze-shaped `comparison[]` AiPanel renders
 *  in the "Compare" tab. Only categories with a non-ok status surface as
 *  notes (the panel hides the ok rows so they don't drown the signal). */
export function reconcileToComparison(run) {
  return ((run && run.rows) || []).map((r) => ({
    clause: r.name || r.key || '',
    status: ROW_STATUS_TO_NOTE[r.status] || 'warn',
    note: r.reason || r.rec || '',
  }));
}

/** Reduce reconcile counts → analyze-shaped score `{value, label, risks}`.
 *  Same formula `useReconciliationRows` already uses (must=12, should=5),
 *  so the Library row and the AnalysisView header agree. */
export function reconcileToScore(run) {
  const must = (run && run.mustCount) || 0;
  const should = (run && run.shouldCount) || 0;
  const value = Math.max(0, 100 - must * 12 - should * 5);
  const label = value >= 80 ? 'Чисто' : value >= 60 ? 'Помірний ризик' : 'Підвищений ризик';
  return {
    value,
    label,
    risks: { high: must, med: should, low: 0 },
  };
}

/** Full bundle AnalysisView consumes: findings + comparison + score +
 *  legalBasis + warnings + documents (two-tab strip for the reconcile
 *  case). Empty legalBasis since /api/reconcile doesn't emit law refs. */
export function reconcileToAnalysisProps(run, t = {}) {
  return {
    findings: reconcileToFindings(run),
    comparison: reconcileToComparison(run),
    legalBasis: [],
    score: reconcileToScore(run),
    warnings: [],
    documents: [
      {
        label: (run && run.contractFile) || t.cmpSlotContract || 'Договір',
        displayPdfUrl: (run && run.displayPdfUrl) || null,
      },
      {
        label: (run && run.handoverFile) || t.cmpSlotHandover || 'Передача справ',
        displayPdfUrl: (run && run.handoverDisplayPdfUrl) || null,
      },
    ],
  };
}
