---
name: pre-merge-checklist
description: Full preflight before opening a PR — typecheck, lint, unit tests, e2e in mock-AI mode, docs sync. Run with /pre-merge or invoke directly when the user signals "ready to merge".
---

Run these in order. Stop at the first failure and report it; the user
decides whether to fix or proceed. **Don't push or open the PR yourself.**

## Steps

1. **Working tree clean?**
   ```bash
   git status --short
   ```
   If output is non-empty: report what's uncommitted and ask whether to
   continue. Don't `git add` things behind the user's back.

2. **Frontend lint**
   ```bash
   npm run lint
   ```

3. **Frontend unit tests**
   ```bash
   npm test
   ```

4. **Backend tests (pytest)**
   ```bash
   cd legal_app && pytest -q
   ```
   ~22 test files. First run can be slow if the embedder cache is cold.

5. **Docs sync**
   ```bash
   npm run docs:check
   ```
   Pre-commit hook will block the commit if this fails; surface it now.
   If it fails: run `npm run docs` to regenerate, review the diff, ask
   the user whether to include it in the PR.

6. **Frontend build**
   ```bash
   npm run build
   ```
   Catches Vite-time errors that lint and tests miss.

7. **Smoke-import the backend (mirrors CI)**
   ```bash
   python -c "from legal_app.backend.main import app; assert app.title == 'AG Lex'"
   ```
   Uses whatever venv is active. CI runs this with `API_KEY=ci-noop
   JWT_SECRET=ci-noop-secret`.

8. **Playwright e2e (optional but recommended)**
   ```bash
   npm run test:e2e
   ```
   Runs with `AGLEX_MOCK_AI=1` — no tokens spent. Wipes
   `e2e/.tmp/aglex-e2e.sqlite`, builds the FE, boots the backend on
   port 8765. Slowest step (~1-2 min). Skip only if the diff doesn't
   touch UI / API / Claude calls.

9. **Diff vs main**
   ```bash
   git log --oneline origin/main..HEAD
   git diff --stat origin/main...HEAD
   ```
   So the report includes commit list + line counts.

## Report

```
## pre-merge report

**Branch**: <name>
**Commits ahead of main**: <N>
**Files changed**: <M> (+<INS> / -<DEL>)

| Step | Result |
|---|---|
| Lint | ✓ / ✗ |
| Vitest | ✓ / ✗ |
| Pytest | ✓ / ✗ |
| Docs check | ✓ / ✗ |
| Build | ✓ / ✗ |
| Backend smoke | ✓ / ✗ |
| E2E (Playwright) | ✓ / ✗ / SKIPPED |

### Failures
<paste the relevant section of the failing command's stderr>

### Suggested next
PASS  → run `/draft-pr` to draft the PR body
FAIL  → fix the failures above, re-run /pre-merge
```

## Things not to do

- Don't `git add -A`. Don't commit. Don't push.
- Don't skip a step silently — say "SKIPPED" with a reason.
- Don't run `docker compose up` here. Pre-merge is local-fast.
- Don't suggest auto-fixes for lint without showing the diff first.
