# AG Lex e2e (Playwright)

Smoke suite for the upload → analyze → reconcile → library flows. The
backend runs with **`AGLEX_MOCK_AI=1`** so analyze / reconcile / chat
return deterministic fixtures from `legal_app/backend/mock_ai.py` — no
Claude tokens are spent and the same fixtures are used as an offline
fallback if you ever flip the env var in production.

## Requirements
- Node 20+, the project's `npm install` already pulled in `@playwright/test`.
- Python venv at `legal_app/venv/` with the project dependencies. Browsers:
  `npx playwright install chromium` (one-off, ~150 MB).

## Run

```bash
npm run test:e2e
```

`playwright.config.js` will:
1. Wipe `e2e/.tmp/aglex-e2e.sqlite` (via `globalSetup.js`).
2. Build the frontend (`npm run build`).
3. Boot FastAPI with `AGLEX_MOCK_AI=1` + the scratch DB on port 8765.
4. Run `e2e/smoke.spec.js` against `http://127.0.0.1:8765`.

The seeded demo user `test@aglex.ua` / `test1234` (from
`auth.seed_test_user`) is used to log in.

## Fixtures
- `e2e/fixtures/contract.docx` — single-contract upload (matches the
  mock-mode `suggest.from` strings so highlights render).
- `e2e/fixtures/contract-pair.docx` + `e2e/fixtures/handover.xlsx` —
  contract + handover pair for the reconcile flow.

Regenerate (only if you change the content):

```bash
legal_app/venv/Scripts/python e2e/fixtures/generate.py   # Windows
legal_app/venv/bin/python e2e/fixtures/generate.py        # *nix
```

## What's covered

- Login lands on dashboard.
- Hub → Contract → upload `contract.docx` → see `.analysis` shell, at least
  one `<mark.hl>` highlight and a `.finding` with a `.law-chip`.
- Hub → Compare → modal with two squares → upload pair → see the
  reconciliation result (`.cmp-find` cards).
- Library shows both the saved contract and the saved reconciliation as
  separate rows with the right type chips.
