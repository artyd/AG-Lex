# AG Lex — backend

Phase 0 skeleton: FastAPI app that serves the React (Vite) build of AG Lex and exposes `/health`.
Business logic ships in later phases — see `../../files/00-INDEX.md`.

## Layout

```
legal_app/
├── backend/         FastAPI app (config, main, future routes)
├── database/        SQLite files (created in Phase 1.1)
├── data/codex_sources/  Raw codex texts (filled in Phase 1.1)
├── scripts/         One-off scripts
├── tests/           pytest suite
├── .env             secrets (gitignored)
├── .env.example     template
└── requirements.txt
```

FastAPI serves the Vite build from `../dist/` (one folder up). Run `npm run build`
in `AG-Lex/` first; otherwise `/` returns a 503 with a clear hint.

## Local setup (Windows / PowerShell)

```powershell
cd C:\Users\a.svystelnyk\Downloads\AG-Lex\legal_app

# 1. Build the frontend once (FastAPI will serve dist/).
cd ..; npm run build; cd legal_app

# 2. Create a virtualenv and install deps.
python -m venv venv
venv\Scripts\Activate.ps1
pip install -r requirements.txt

# 3. Copy .env.example to .env and fill in secrets (API_KEY, JWT_SECRET).
copy .env.example .env

# 4. Run.  IMPORTANT: keep --workers 1.
# The realtime WebSocket fan-out uses an in-process ConnectionManager
# (see backend/realtime.py).  Multiple workers would silo their sockets
# and break realtime broadcast.  Scale-out later via Redis pub/sub.
uvicorn backend.main:app --reload --workers 1
```

Open:
- http://localhost:8000/         — AG Lex UI (served from dist/)
- http://localhost:8000/health   — `{"status":"ok"}`
- http://localhost:8000/docs     — OpenAPI (only once API routes exist)

## Running tests

```powershell
pytest
```
