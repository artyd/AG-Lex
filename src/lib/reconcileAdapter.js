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

// Human labels for the A–I categories from LanguageStyleCheckAgent. Kept
// here (not in a translations file) because the labels are legal-workflow
// specific and shouldn't be translated per locale — the counsel checklist
// itself is Ukrainian.
const LANG_CATEGORY_LABEL = {
  A: 'Орфографія, пунктуація, граматика',
  B: 'Стиль і тон',
  C: 'Визначені терміни',
  D: 'Нумерація і крос-посилання',
  E: 'Білінгвальна відповідність EN ↔ UA/RU',
  F: 'Типографіка',
  G: 'Адреси і реквізити сторін',
  H: 'Логістичні терміни (Incoterms)',
  I: 'Таблиці і специфікації',
};

/** Fold reconciliation.language_findings[] into the analyze-shaped finding
 *  list so ContractAnalysis's FindingCard + Apply-fix work verbatim.
 *
 *  Mapping:
 *   - id       ← `lang-<A-I>-<seq>` from Claude; falls back to a synthesized
 *                 id so React lists have a stable key.
 *   - level    ← must→high, should→med, nice→low (same as SEV_TO_LEVEL).
 *   - clause   ← finding.location, e.g. «п. 3.1 (Price)».
 *   - title    ← the checklist category label (A–I), so the FindingCard
 *                 header immediately signals which shelf of the checklist
 *                 this belongs to. The Claude explanation goes in desc.
 *   - suggest  ← the real `{from, to}` — non-empty `to` means the Apply-fix
 *                 button in the editor toolbar can perform the replacement.
 *   - kind='lang' + `_category`, `_language`, `_bilingual` — surfaced to the
 *                 UI so the split-tab view can filter and badge them.
 */
export function languageToFindings(run) {
  const list = (run && run.languageFindings) || (run && run.language_findings) || [];
  return list.map((f, idx) => {
    const category = String(f.category || 'A').toUpperCase();
    const label = LANG_CATEGORY_LABEL[category] || 'Мова та стиль';
    let suggestFrom = (f.suggest && f.suggest.from) || f.quote || '';
    const suggestTo = (f.suggest && f.suggest.to) || '';
    // Same validation as risk findings — if the phrase Claude quoted doesn't
    // literally appear anywhere in the contract streams, painting a phantom
    // highlight would only mislead. Prefer null so the FindingCard speaks
    // for itself.
    if (suggestFrom && !_existsInAnyStream(suggestFrom.trim(), run)) {
      suggestFrom = '';
    }
    return {
      id: String(f.id || `lang-${category}-${idx}`),
      kind: 'lang',
      level: SEV_TO_LEVEL[f.severity] || 'med',
      clause: f.location || '',
      weight: 1,
      title: `[${category}] ${label}`,
      desc: f.explanation || '',
      severity: f.severity || 'should',
      law: null,
      suggest: suggestFrom ? { from: suggestFrom, to: suggestTo } : null,
      _category: category,
      _language: f.language || 'unknown',
      _bilingual: Boolean(f.bilingual),
      _source: 'Мова та стиль',
    };
  });
}

const ROW_STATUS_TO_NOTE = {
  ok: 'ok',
  mismatch: 'deviate',
  flag: 'warn',
  absent: 'missing',
  positive: 'ok',
};

/** Pick the longest inline-highlight fragment from `docs.contract` whose
 *  category matches `cat` and whose status isn't `ok`. This is the text
 *  the backend already emitted as the actionable highlight target inside
 *  `docs.contract.sections[].uaP[]` / `enP[]` (per the reconciliation
 *  prompt: each fragment carries `{t, cat, st}`).
 *
 *  We prefer the longest fragment because short tokens like "CIF" or
 *  numeric clauses collide with the table-of-contents or page header
 *  when `pdfHighlight.findSpan` does its `indexOf`. A longer fragment
 *  like "CIF Гданськ, MSC/Maersk до 12.04.2026" is essentially unique
 *  on the page, so the overlay lands on the actual disputed phrase.
 *
 *  Returns `null` when no suitable fragment exists — the caller falls
 *  back to the clause-number anchor in `findSpan`. */
export function snippetForCat(docs, cat) {
  if (!docs || !cat) return null;
  const contract = docs.contract || {};
  const sections = Array.isArray(contract.sections) ? contract.sections : [];
  let best = '';
  for (const s of sections) {
    for (const arr of [s.uaP, s.enP]) {
      if (!Array.isArray(arr)) continue;
      for (const p of arr) {
        if (!p || typeof p.t !== 'string') continue;
        if (p.cat !== cat) continue;
        if (p.st === 'ok' || p.st == null) continue;
        if (p.t.length > best.length) best = p.t;
      }
    }
  }
  return best || null;
}

// Placeholder markers the reconciliation prompt sometimes emits into
// rows[].contract when the contract is silent on a field (empty string is
// preferred per the prompt, but historically Claude has produced these).
// If we let them into `suggest.from`, buildFromRegex would look for
// "NOT SPECIFIED IN CONTRACT" literal in the mammoth markdown and always
// miss — so we treat them as absent.
const _CONTRACT_PLACEHOLDER_RE = /^(?:—|-|—|<absent>|n\/?a|not\s+specified|не\s+вказано|відсутнє?)$/i;

function _isUsableContractPhrase(s) {
  if (!s || typeof s !== 'string') return false;
  const trimmed = s.trim();
  if (trimmed.length < 3) return false;      // "≥5" style single-token annotations
  if (_CONTRACT_PLACEHOLDER_RE.test(trimmed)) return false;
  return true;
}

function _existsInAnyStream(needle, run) {
  if (!needle || !run) return false;
  const streams = [
    run.contractMarkdown, run.contractMarkdownEn, run.contractMarkdownUa,
  ].filter((s) => typeof s === 'string' && s.length > 0);
  // Permissive fallback: when no markdown is available (older runs, unit
  // tests that only wire `docs`), trust the caller's phrase. The runtime
  // highlighter falls back to a gutter flag if the regex misses anyway.
  if (streams.length === 0) return true;
  return streams.some((h) => h.includes(needle));
}

/** Convert reconcile findings to the analyze-contract finding shape so the
 *  existing AiPanel / FindingCard / overlay code paths Just Work.
 *
 *  `suggest.from` derivation, in preference order:
 *    1. `row.contract` — the actual value Claude extracted from the contract
 *       text. The prompt now requires this to be a verbatim substring, so
 *       it's the highest-fidelity source we have for the inline highlight.
 *    2. `snippetForCat(docs, cat)` — the annotation fragment from
 *       `docs.contract.sections[].uaP/enP`. Kept as a fallback because
 *       older reconciliations don't guarantee verbatim `row.contract`, but
 *       these annotations are frequently paraphrased so the highlight can
 *       still miss.
 *    3. `null` — no inline decoration; FindingCard still renders + gutter
 *       flag still fires on the clause-number block.
 *
 *  Post-derivation validation: if the chosen phrase doesn't literally
 *  appear in any of the persisted contract streams, we drop `suggest` to
 *  `null` so the editor doesn't paint a phantom flag on the first block
 *  (that used to happen when `NOT SPECIFIED IN CONTRACT` fell through).
 */
export function reconcileToFindings(run) {
  const list = (run && run.findings) || [];
  const docs = (run && run.docs) || null;
  const rowByCat = {};
  for (const r of ((run && run.rows) || [])) {
    if (r && r.key) rowByCat[r.key] = r;
  }
  return list.map((f) => {
    const row = rowByCat[f.cat] || null;
    const t3Val = row && row.t3 ? String(row.t3).trim() : '';
    const contractVal = row && row.contract ? String(row.contract).trim() : '';
    // Preferred source: verbatim `row.contract`. Fallback: sections snippet.
    let anchor = null;
    if (_isUsableContractPhrase(contractVal)) anchor = contractVal;
    if (!anchor) {
      const snippet = snippetForCat(docs, f.cat);
      if (_isUsableContractPhrase(snippet)) anchor = snippet;
    }
    // Validate against the real markdown — if the anchor isn't a literal
    // substring, `buildFromRegex` will fail silently and we'd paint a
    // gutter flag on a random block. Better to render no highlight and
    // let the FindingCard speak for itself.
    if (anchor && !_existsInAnyStream(anchor, run)) anchor = null;

    // Compose an actionable description: the recommendation plus a compact
    // "ПД / Договір" delta so the card explains *what to change* without
    // requiring a jump to the comparison table.
    const deltaLines = [];
    if (t3Val) deltaLines.push(`ПД: «${t3Val}»`);
    if (contractVal) deltaLines.push(`Договір: «${contractVal}»`);
    const desc = [f.rec || '', deltaLines.join(' · ')].filter(Boolean).join(' — ');
    // For `mismatch` rows we can propose the T3 value verbatim; for `absent`
    // or `flag` there is nothing concrete to insert, so we leave `to` empty
    // and let the FindingCard fall back to diagnostic-only mode.
    const canApply = anchor && t3Val && row && row.status === 'mismatch';
    return {
      id: String(f.cat || f.id || ''),
      level: SEV_TO_LEVEL[f.severity] || 'info',
      clause: f.location || '',
      weight: 1,
      title: f.issue || '',
      desc,
      severity: f.severity,
      law: null,
      suggest: anchor
        ? { from: anchor, to: canApply ? t3Val : '' }
        : null,
      _source: f.source || null,
      _verified: f.verified || null,
    };
  });
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

/** Join one `uaP`/`enP` token stream into plain paragraph text. Handles both
 *  the flat shape `[{t, cat, st}, ...]` the analyzer actually emits and the
 *  nested-paragraph shape `[[token, ' tail'], ...]` the mock fixtures use,
 *  so MarkdownDoc reads the same text regardless of source. */
function _joinParts(parts) {
  if (!Array.isArray(parts)) return '';
  const out = [];
  for (const item of parts) {
    if (typeof item === 'string') {
      const s = item.trim();
      if (s) out.push(s);
    } else if (item && typeof item.t === 'string') {
      const s = item.t.trim();
      if (s) out.push(s);
    } else if (Array.isArray(item)) {
      const para = item.map((x) =>
        typeof x === 'string' ? x : (x && typeof x.t === 'string' ? x.t : ''),
      ).join('');
      const s = para.trim();
      if (s) out.push(s);
    }
  }
  return out.join(' ').replace(/\s+/g, ' ').trim();
}

/** Convert `docs.contract.sections` → MarkdownDoc's `[{number, title, text}]`.
 *  Each section concatenates the Ukrainian then the English paragraph stream;
 *  empty sections are skipped so the reader doesn't render blank shells. */
export function reconcileToSections(docs) {
  if (!docs || !docs.contract) return [];
  const list = Array.isArray(docs.contract.sections) ? docs.contract.sections : [];
  const out = [];
  for (const s of list) {
    if (!s) continue;
    const ua = _joinParts(s.uaP);
    const en = _joinParts(s.enP);
    const text = [ua, en].filter(Boolean).join('\n\n');
    if (!text) continue;
    out.push({
      number: s.n || '',
      title: s.ua || s.en || '',
      text,
    });
  }
  return out;
}

/** Flatten `docs.handover` (table-shaped, not section-shaped) into one
 *  readable preamble + a bullet list of rows so MarkdownDoc has something
 *  to render. The original structure (appendix/title/sub + rows[]) isn't
 *  natively prose — we present it as a single "summary" section. */
export function handoverToSections(docs) {
  if (!docs || !docs.handover) return [];
  const h = docs.handover;
  const head = [h.appendix, h.title, h.sub, h.section].filter(Boolean).join(' · ');
  const rows = Array.isArray(h.rows) ? h.rows : [];
  const lines = rows
    .map((r) => {
      const tail = [r.label, r.value, r.note].filter(Boolean).join(' — ');
      const num = r.n ? `${r.n}. ` : '';
      return tail ? `- ${num}${tail}` : '';
    })
    .filter(Boolean);
  const text = [head, lines.join('\n'), h.footnote].filter(Boolean).join('\n\n');
  if (!text) return [];
  return [{ number: '', title: h.title || 'Передача справ', text }];
}

/** Full bundle AnalysisView consumes: findings + comparison + score +
 *  legalBasis + warnings + documents (two-tab strip for the reconcile
 *  case). Empty legalBasis since /api/reconcile doesn't emit law refs.
 *
 *  Findings merge two sources: the 15-category Table 3 comparison (kind:
 *  "risk" — implicit, no `kind` field) and the A–I language & style
 *  findings (kind: "lang"). The FindingsPanel splits them into two tabs
 *  but they share the same Milkdown highlight machinery. */
export function reconcileToAnalysisProps(run, t = {}) {
  const docs = (run && run.docs) || null;
  const riskFindings = reconcileToFindings(run);
  const langFindings = languageToFindings(run);
  return {
    findings: [...riskFindings, ...langFindings],
    comparison: reconcileToComparison(run),
    legalBasis: [],
    score: reconcileToScore(run),
    warnings: [],
    // Convenience flag the ContractAnalysis screen reads to render the
    // «Table 3 / Мова & стиль» tab header. Kept out of `findings` so a
    // downstream consumer doesn't have to iterate to know the split exists.
    hasLanguageFindings: langFindings.length > 0,
    documents: [
      {
        label: (run && run.contractFile) || t.cmpSlotContract || 'Договір',
        filename: (run && run.contractFile) || t.cmpSlotContract || 'Договір',
        sections: reconcileToSections(docs),
      },
      {
        label: (run && run.handoverFile) || t.cmpSlotHandover || 'Передача справ',
        filename: (run && run.handoverFile) || t.cmpSlotHandover || 'Передача справ',
        sections: handoverToSections(docs),
      },
    ],
  };
}
