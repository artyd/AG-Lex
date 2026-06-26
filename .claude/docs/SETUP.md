# Local setup

Tested on Windows + WSL/PowerShell and Linux/macOS. Python 3.12, Node 20.

## First-time

```bash
# 1. Repo
git clone https://github.com/artyd/AG-Lex.git
cd AG-Lex

# 2. Frontend
npm install                       # installs Vite + React + ESLint + Playwright

# 3. Backend (Python venv)
cd legal_app
python -m venv venv
source venv/bin/activate          # PowerShell: venv\Scripts\Activate.ps1
pip install -r requirements.txt
cd ..

# 4. Env vars
cp legal_app/.env.example legal_app/.env
# Fill: API_KEY (Anthropic), JWT_SECRET. Defaults are OK for everything else.

# 5. Optional: install Playwright browsers (one-off, ~150 MB)
npx playwright install chromium
```

## Run

Two processes, two terminals.

```bash
# Terminal 1 — backend (port 8001)
cd legal_app
source venv/bin/activate
uvicorn backend.main:app --reload --workers 1 --port 8001
```

```bash
# Terminal 2 — frontend (port 5173, proxies /api → 8001)
npm run dev
```

Open `http://localhost:5173`. Log in with `test@aglex.ua / test1234`.

**Single worker is mandatory** — see `realtime.py` for why.

## Docker (production-like)

```bash
cp .env.example .env              # API_KEY, JWT_SECRET at minimum
docker compose up -d --build
curl -fsS http://localhost:8002/api/health
```

Open `http://localhost:8002`.

## Daily commands

```bash
npm run dev                       # Vite dev server
npm test                          # vitest (unit)
npm run test:watch                # vitest watch
npm run test:e2e                  # Playwright (auto-runs AGLEX_MOCK_AI=1 backend)
npm run lint                      # ESLint
npm run build                     # Vite production build → dist/
npm run docs                      # regenerate docs/ from source
npm run docs:check                # check docs/ is in sync with source (pre-commit gate)

# Backend
cd legal_app
pytest                            # all backend tests
pytest tests/test_rbac.py         # one file
pytest -k matters                 # by keyword
python scripts/check_codex.py     # codex stats + 3-article sample per source
python scripts/import_codex.py    # (re-)import every codex file
```

## E2E mode

`AGLEX_MOCK_AI=1` short-circuits every Claude call to deterministic
fixtures (`legal_app/backend/mock_ai.py`). Used by:

- Playwright (`playwright.config.js` boots the backend with this env var)
- Offline dev when you don't have an `API_KEY` configured

Mock-mode fixtures include a pre-rendered `mock_display.pdf` so the
soffice path is also skipped on CI / Windows machines that don't have
LibreOffice installed.

## Docs auto-generation + pre-commit hook

```bash
node tools/hooks/install.mjs       # one-off: install pre-commit hook
```

The hook runs `python scripts/generate_docs.py --check` and blocks
commits where source and `docs/<module>.md` are out of sync. Regenerate
locally with `npm run docs`.

## Bugs log

Every fixed bug gets an entry in `docs/BUGS.md` (append-only). Use
`/lesson` to draft the entry in the project's format.

## Optional: soffice (display PDF)

LibreOffice headless is needed for the DOCX/XLSX → PDF display pipeline.

```bash
# Debian/Ubuntu
apt-get install --no-install-recommends \
    libreoffice-core libreoffice-writer libreoffice-calc \
    fonts-noto fonts-noto-cjk

# macOS
brew install --cask libreoffice

# Windows
choco install libreoffice-fresh    # or grab the installer
```

Without it, `/api/upload` returns `display_pdf_error` but the markdown
analysis still works (the FE falls back to markdown view).

Set `SOFFICE_PATH=/absolute/path/to/soffice` in `.env` if it's not on PATH.

## Common ports

| Service           | Port   |
|-------------------|--------|
| Backend (dev)     | 8001   |
| Frontend (dev)    | 5173   |
| Edge nginx (prod) | 8002   |
| Backend (docker)  | internal :8000 |
| Frontend (docker) | internal :80   |
| E2E backend       | 8765   |
