# Bug history — append-only

Every bug we fix gets one entry here. **Old entries are never deleted.**
The point is to give future-you (and future code reviewers) a way to
trace *why* a function evolved the way it did — not just *what* changed.

When fixing a bug, append a new entry below the most recent one using
the template:

```
## YYYY-MM-DD — <short title>

- **Status**: fixed | in progress
- **Symptom**: what the user saw / reported
- **Cause**: the actual root cause (not the symptom)
- **Fix**: what we changed
- **Affected**: `path/to/file.py:function_name` (one or many)
- **Commit / PR**: <sha-or-PR-link>
```

Keep the entries terse — full reasoning lives in the commit message.
This log is the index, not the encyclopedia.

---

## 2026-06-16 — Training-mode tooltips snapped to the corner

- **Status**: fixed
- **Symptom**: With "Режим навчання" enabled, hovering any element made
  the tooltip appear in the top-left corner of the screen instead of
  next to the cursor / element.
- **Cause**: `<HelpTip>` wraps children in `<span class="helptip-wrap">`
  with `display: contents`. Per spec (and every major browser engine) a
  display:contents element has no own bounding rect — its
  `getBoundingClientRect()` returns ~zero. The positioning math then
  placed the bubble off-screen, auto-flipped to `top: 10`, and clamped
  `left` to the viewport-padding minimum — i.e. the corner.
- **Fix**: rewrote `HelpTip` to (a) default to cursor-following placement
  (bubble follows the mouse with a 14×18 px offset, re-aimed on
  mousemove), (b) when keyboard focus is used, fall back to measuring
  `wrapRef.current.firstElementChild?.getBoundingClientRect()` — the
  first child has real bounds even when the wrap doesn't.
- **Affected**: `src/ui/HelpTip.jsx` (whole component rewrite),
  `src/styles/styles.css` (.helptip-bubble visual overhaul),
  `src/App.jsx` (settings card redesign that exposes the new behavior).
- **Commit / PR**: PR #36 — `feat/training-mode-redesign`

## 2026-06-16 — Reconcile pair upload appeared to hang

- **Status**: fixed
- **Symptom**: After clicking "Compare" in the pair-upload modal, the
  page sat on a static "analyzing" overlay with a frozen 60% progress
  bar. Users assumed the site hung and refreshed.
- **Cause**: PR #32 (`unify reconcile into analyze route`) ported the
  result-screen body but not the original `AnalyzingStep`'s animation
  effects — the new `<ReconcileResult pending>` block hardcoded
  `width: 60%` with no interval-based progress, no elapsed counter, all
  steps shown as "now".
- **Fix**: Extracted `<ReconcileAnalyzingOverlay>` from the inline body,
  restored the cycling step animation + jitter-incrementing progress
  bar (capped at 96% — the final hop happens when the real result
  lands), added an `Ns` elapsed-seconds counter.
- **Affected**: `src/screens/ContractAnalysis.jsx` (ReconcileResult
  early-return branch + new ReconcileAnalyzingOverlay sub-component).
- **Commit / PR**: PR #35 — `fix/reconcile-animated-progress`

## 2026-06-16 — Single-contract upload flashed the reconcile overlay

- **Status**: fixed
- **Symptom**: When uploading a single contract for analysis, the
  reconcile analyzing overlay flashed briefly before the
  contract-analyze flow rendered.
- **Cause**: `useReconcileHandoff()` runs on every analyze-route mount
  and pops `RECON_OPEN_KEY` from localStorage. First render returned
  `undefined` → renders `<ReconcileResult pending />` → effect resolves
  to `null` → renders `<ContractAnalysisSingle>`. Brief but jarring
  flash of an unrelated overlay.
- **Fix**: hook now takes a `hasIncoming` arg. When the route was
  opened with an `incoming` payload (upload-modal flow), we know the
  user came via a specific intent and skip the handoff lookup entirely.
  Only Library reopens (which navigate to `/analyze` with NO incoming)
  hit the handoff path.
- **Affected**: `src/screens/ContractAnalysis.jsx:useReconcileHandoff`,
  `src/screens/ContractAnalysis.jsx:ContractAnalysisMain`.
- **Commit / PR**: PR #35 — `fix/reconcile-animated-progress` (same PR
  as the animation fix above)

## 2026-06-16 — Display-PDF returned 401 with no actionable message

- **Status**: fixed
- **Symptom**: On `rec-c7a48086` the analyze screen showed
  "Сервер повернув HTTP 401" in the display-PDF banner. Users assumed
  the .docx format was the problem.
- **Cause**: `/api/.../display.pdf` is `current_user`-gated. When the
  JWT in localStorage expired (24h TTL by default), the binary fetch
  in `AnalysisView` got 401 but the catch-all `if (!r.ok)` arm just
  reported "HTTP 401" with no auth context. Worse, the cached session
  was never cleared so other screens kept rendering authenticated
  state.
- **Fix**: AnalysisView's fetch handler special-cases `status === 401` —
  calls `lxLogout()` (same as `api.js`'s `request()` wrapper does for
  all other 401s) and the banner now reads "Сесія прострочена або
  недійсна — увійдіть знову…" instead of the generic HTTP message.
- **Affected**: `src/screens/analysis/AnalysisView.jsx` (401 branch in
  the fetch `.then`, banner copy lookup).
- **Commit / PR**: PR #31 — `fix/analysis-401-banner`

## 2026-06-16 — `aglex` systemd unit couldn't launch `soffice` (exit 127)

- **Status**: fixed
- **Symptom**: After installing LibreOffice on the server, reconcile
  still failed with `serverKind: "crash"`, `serverMessage: "soffice exit
  127 rendering ...docx"`. Manual `soffice --version` worked.
- **Cause**: `/usr/bin/soffice` is a `/bin/sh` wrapper that shells out
  to `dirname`/`basename`/`sed`/`grep`/`uname` to compute its own
  install dir. The aglex systemd unit set
  `Environment="PATH=/root/ag-lex/legal_app/venv/bin"` — only the
  venv, no `/usr/bin`. Wrapper couldn't find coreutils, fell back to
  `$PWD` (= `WorkingDirectory=/root/ag-lex/legal_app`), then tried to
  exec `/root/ag-lex/legal_app/oosplash` → 127.
- **Fix**: `to_display_pdf` builds a child env that always prepends
  `/usr/bin`, `/bin`, `/usr/sbin`, `/sbin` to PATH before exec'ing
  soffice. Parent's PATH preserved; system bins come first.
- **Affected**: `legal_app/backend/documents.py:to_display_pdf`.
- **Commit / PR**: PR #30 commit `44ca1d9` — within
  `fix/display-pdf-error-surfacing`

## 2026-06-16 — `shutil.which("soffice")` failed even when soffice existed

- **Status**: fixed
- **Symptom**: With LibreOffice installed at `/usr/bin/soffice`,
  `to_display_pdf` still raised `DisplayPdfError(kind="missing",
  message="soffice binary not found")`.
- **Cause**: same systemd PATH issue as the next bug, but surfaced
  earlier in the code path — `shutil.which("soffice")` couldn't find
  the bare command name in the stripped PATH.
- **Fix**: when `which()` returns None for a bare command name, probe
  a tight list of canonical install paths (`/usr/bin/soffice`,
  `/usr/lib/libreoffice/program/soffice`, the macOS bundle, Windows
  Program Files). An explicit absolute `SOFFICE_PATH` still wins.
- **Affected**: `legal_app/backend/documents.py:to_display_pdf`.
- **Commit / PR**: PR #30 commit `330513b` — within
  `fix/display-pdf-error-surfacing`

## 2026-06-16 — Reconcile findings never highlighted on the PDF

- **Status**: fixed
- **Symptom**: After running a contract↔handover comparison, the PDF
  showed no highlight overlays even when the documents clearly differed
  on price / Incoterms / payment.
- **Cause**: `reconcileToFindings` (in `src/lib/reconcileAdapter.js`)
  hardcoded `suggest: null` for every finding. `pdfHighlight.findSpan`
  needs either a text snippet (`suggest.from`) or a parseable
  clause-number anchor (`f.clause`) — reconcile findings have neither
  reliably. Meanwhile the backend response carries the actual text to
  highlight in `docs.contract.sections[].uaP[].t` fragments tagged with
  the matching `cat` — the adapter just threw those away.
- **Fix**: new helper `snippetForCat(docs, cat)` walks
  `docs.contract.sections` for the longest fragment whose `cat`
  matches the finding's `cat` and whose `st !== 'ok'`, then sets
  `suggest.from` to that snippet. Findings without a matching snippet
  fall back to `suggest: null` (same as before). Pure FE change; zero
  backend risk.
- **Affected**: `src/lib/reconcileAdapter.js:snippetForCat` (new),
  `src/lib/reconcileAdapter.js:reconcileToFindings` (updated).
- **Commit / PR**: PR #32 — `fix/reconcile-highlights-and-route-cleanup`

## 2026-06-16 — Display-PDF 404 didn't explain WHY the BLOB was missing

- **Status**: fixed
- **Symptom**: When `to_display_pdf` failed during `/api/reconcile`,
  the reconciliation row was saved without the BLOB. Later, the
  display endpoint returned a generic 404 and the FE banner read only
  "preview unavailable" — no hint about whether soffice was missing,
  crashed, or timed out.
- **Cause**: the failure reason was logged to stderr (and onward to
  `journalctl`) but never persisted to the row, so the FE 404 path
  had no information to surface.
- **Fix**: added `contract_display_pdf_error` / `handover_display_pdf_error`
  / `display_pdf_error` TEXT columns (with idempotent migrations).
  `_ingest_upload` now returns `{kind, message}` alongside the
  (possibly-null) PDF bytes. `_stream_display_pdf` reads the column
  and returns the 404 body as `{detail, kind, message}` when populated.
  Frontend banner maps each `kind` to a specific Ukrainian explanation.
- **Affected**: `legal_app/backend/models.py:migrate_reconciliations_display_pdf`,
  `legal_app/backend/models.py:migrate_contracts_display_pdf`,
  `legal_app/backend/main.py:_ingest_upload`,
  `legal_app/backend/main.py:_stream_display_pdf`,
  `src/screens/analysis/AnalysisView.jsx` (404 body parsing + banner).
- **Commit / PR**: PR #30 — `fix/display-pdf-error-surfacing`

## 2026-06-16 — SPA catch-all served `../legal/secret` outside dist

- **Status**: fixed
- **Symptom**: `legal_app/backend/main.py`'s catch-all SPA fallback
  served `index.html` for any unknown path — but with a request like
  `/../legal/private.key` it could resolve outside the FRONTEND_DIR
  and serve arbitrary files from the host.
- **Cause**: the path was concatenated without normalizing or
  validating that the resolved path stayed within the dist root.
- **Fix**: resolve to absolute path with `(.. / requested).resolve()`,
  verify `is_relative_to(FRONTEND_DIR.resolve())`. On miss, fall
  through to `index.html` (correct SPA behavior for an actual route
  that maps to client-side rendering).
- **Affected**: `legal_app/backend/main.py:spa_fallback`.
- **Commit / PR**: commit `9e7c24b` — `security/spa-path-traversal`

---

_Add new entries above this line (most recent on top is OK too — just
be consistent within the file)._
