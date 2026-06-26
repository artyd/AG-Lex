---
description: Snapshot of repo state — branches in flight, recent TODOs, business-critical edits, health-check status. Writes a dated file to `.claude/audits/`.
---

Run an end-of-day audit on the repo state. Output goes to
`.claude/audits/YYYY-MM-DD.md` (one per day; if today's file already
exists, append a `## Run NN — HH:MM` section).

## Steps

1. **Branches in flight**
   ```bash
   git for-each-ref --sort=-committerdate \
     --format='%(refname:short) %(committerdate:relative) %(authorname)' \
     refs/heads/ refs/remotes/ | head -20
   ```
2. **Recent TODO / FIXME deltas vs main**
   ```bash
   git diff origin/main..HEAD 2>/dev/null | grep -E "^\+.*(TODO|FIXME|XXX|HACK)" | head
   ```
   (Empty is fine.)
3. **Business-critical files touched on active branches**
   - List branches whose diff vs main touches any of:
     `legal_app/backend/{auth,rbac,cases_acl,prompts,claude_client,database,models,main,realtime,contract_analysis,reconciliation}.py`
     or `docker-compose.yml`, `.github/workflows/deploy.yml`.
   - For each, report branch + file + 1-line change summary.
4. **Codex health**
   ```bash
   python legal_app/scripts/check_codex.py 2>&1 | head -30
   ```
   Or — if Python isn't available — read the most recent
   `.claude/audits/*.md` codex line and note "skipped (no venv active)".
5. **Smoke health-check commands** (run if quick, skip if slow)
   - `npm run lint 2>&1 | tail -5`
   - `npm test 2>&1 | tail -5`
   - `cd legal_app && pytest -q 2>&1 | tail -5` (cd back after)
6. **Verdict**: `GREEN / YELLOW / RED` based on:
   - GREEN: lint+tests pass, no critical-file edits unreviewed,
     codex_ready
   - YELLOW: one of the above is degraded
   - RED: critical-file edits unreviewed AND tests failing, OR codex
     `vec_ready=false` on a branch that touches RAG

## File template (`.claude/audits/YYYY-MM-DD.md`)

```
# Daily audit — YYYY-MM-DD

## Run 01 — HH:MM (timezone)

### Branches in flight
<paste from step 1>

### Recent TODO/FIXME deltas
<paste from step 2, or "none">

### Business-critical files touched
- `<branch>` — `<file>` — <one-line summary>
<or "none">

### Codex health
- total_articles: N
- by_source: {...}
- fts_ready: true/false
- vec_ready: true/false

### Smoke checks
- lint: PASS / FAIL (<excerpt>)
- vitest: PASS / FAIL (<excerpt>)
- pytest: PASS / FAIL / SKIPPED (<excerpt>)

### Verdict
**GREEN / YELLOW / RED** — <one-line reason>

### Top action
<the single next thing to do, e.g. "review feat/X for prompts.py
diff", "re-run /pre-merge on chore/Y", "investigate failing pytest in
test_rbac.py">
```

## Things to remember

- Don't run `git pull`, `git fetch`, or modify any branch state. Audit
  is observational.
- Don't commit the audit file from inside the skill — let the user
  decide whether to commit it (most users keep audits gitignored or
  commit periodically).
- If a smoke check is slow on this machine, skip it and note SKIPPED.
- Today's date in this conversation context is the date in the
  filename — use absolute YYYY-MM-DD.
