# AG Lex — architecture reference

Long-form companion to `CLAUDE.md`. Read this when you need to understand
**why** something is shaped the way it is before changing it.

## What AG Lex is

A FastAPI + React workspace built for one law firm. Three product surfaces:

1. **Contract analysis** — lawyer uploads a PDF/DOCX, the backend extracts
   text, calls Claude with the firm's prompts + the relevant codex articles,
   returns findings/comparison/score/legal_basis. Result is persisted.
2. **Contract ↔ Handover reconciliation** — procurement uploads both the
   signed contract and a "Лист погодження" (Table 3); Claude returns a
   15-category cross-check + finding list.
3. **AI-lawyer chat** — multi-turn legal chat grounded in the codex via RAG;
   each user owns persistent sessions in the DB.

Around those: matters/tasks/clients CRUD, a clause library, calendar,
notifications, audit log, team & RBAC management, realtime collaboration.

## Backend (`legal_app/backend/`)

### Boot sequence (`main.py:lifespan`)

Runs **on every uvicorn start** (single worker). All steps are idempotent.

1. `set_main_loop(asyncio.get_running_loop())` — captures the loop so sync
   REST handlers (run in threadpool) can still schedule realtime broadcasts
   via `run_coroutine_threadsafe`. Without this, sync-handler broadcasts
   silently no-op.
2. `init_schema` + `init_user_schema` + `init_chat_schema` +
   `init_entity_schema` + `init_permissions_schema` + `init_audit_schema`
   — every DDL is `CREATE IF NOT EXISTS`.
3. `migrate_*` helpers in `models.py` — ALTER TABLE ADD COLUMN gated by a
   PRAGMA `table_info` check (idempotent).
4. `auth.seed_test_user` + `auth.seed_viktoria_user` +
   `rbac.seed_default_permissions` + `scripts.seed_demo.seed_all` —
   `INSERT OR IGNORE` everywhere.
5. **Background thread**: `scripts.import_codex.bootstrap_codex` opens its
   own connection, downloads the embedding model on first run (~200 MB),
   embeds ~2 500 articles. Runs out-of-band because the deploy workflow's
   health-check window is **15s** (`docker compose restart nginx; sleep 15;
   curl /api/health`) — synchronous bootstrap would block past it and
   nginx would 502. See PR #60.

### Route registration order

`main.py` registers routers in this exact order — **don't reorder**:

```
auth, team, assist, builder, lawyer_chat, chat_sessions, drafts,
matters, notifications, calendar,                # custom routers
<custom POST /api/contracts handler>,           # contract BLOB writer
for entity in ALL_ENTITIES:                     # generic CRUD loop
    if entity.table == "matters": continue      # already handled above
    build_router(entity, ...)
```

The generic `build_router` would otherwise shadow `matters_routes.router`
(no row-level ACL) and the contract BLOB POST (no display_pdf handling).

### Auth (`auth.py`)

- bcrypt direct (passlib dropped — bcrypt 4.x broke its `__about__` probe).
- JWT HS256, **1-year TTL**. The FE calls `/api/auth/refresh` on every app
  mount → rolling token, user effectively never logs out.
- Generic 401 message + identical timing on login failure → no user
  enumeration.
- bcrypt's 72-byte input limit is real for Cyrillic (2 bytes/char); UTF-8
  truncation lives in `_to_bcrypt_input`.
- Two seeded accounts on boot: `test@aglex.ua/test1234` (full demo data) and
  `viktoria@aglex.ua/viktoria2026` (partner role, **clean workspace** — see
  `crud.py:_account_hides_demo` which filters seed IDs lacking the dash
  prefix).

### RBAC (`rbac.py`)

5 roles × 8 capabilities, stored in the `permissions` table. Editable from
the Team UI; defaults live in `DEFAULT_PERMISSIONS`. Use as a FastAPI
dependency: `Depends(require("ai"))`. Role comes from JWT — never the
request body.

### Row-level ACL (`cases_acl.py`)

`case_members(case_id, user_id, role_in_case)` is the row-level gate for
matters. `require_member()` is the dependency. The user ID inside the
domain is **TEXT** (`u1`, `u2`, …) and bridged from the auth INTEGER ID via
`users.legacy_id` (back-filled lazily by `resolve_user_text_id`).

### Realtime (`realtime.py`)

In-process `ConnectionManager` keyed by TEXT user_id (multiple sockets per
user supported — tabs + mobile). Broadcasts:
- `schedule_broadcast(conn, case_id=..., type_=...)` — fans event to every
  `case_members.user_id` for the case. Called from sync REST handlers
  **after** `conn.commit()`.
- `schedule_notify(user_text_id=..., type_=...)` — single-user push for
  `notification.new`.

WS auth on `/ws` happens via `?token=…` query string (browsers can't set
`Authorization` on `new WebSocket`). The endpoint validates the JWT,
resolves the TEXT id, accepts the socket, and only replies to client
`ping` (server is the publisher).

### Codex / RAG (`search.py`, `claude_client.py`, `prompts.py`)

- `articles(article_number, title, content, source, embedding)` + an FTS5
  external-content mirror with INSERT/UPDATE/DELETE triggers keeping them
  in sync.
- `hybrid_search(query, source=None, limit=5)` = vector (`vec_distance_cosine`)
  ∪ keyword (BM25 via FTS5), fused with Reciprocal Rank Fusion (k=60),
  oversample 2× before trimming.
- Embedder = `sentence-transformers` with the model in
  `settings.EMBED_MODEL` (default `paraphrase-multilingual-MiniLM-L12-v2`).
  **Must match the import-time model**, otherwise vectors compare nonsense.
- Claude call has **two cache breakpoints**: the system prompt and the
  formatted articles block. `format_articles` is deterministic (no `set`,
  no time) — that's the cache invariant.

### Structured-output Claude calls

`contract_analysis.py` and `reconciliation.py` pass
`output_config.format = "json_schema"` with strict
`additionalProperties: false` schemas, so the model can't drift the wire
shape. The frontend renders directly from these — **schema drift = client
crash**.

### Mock AI (`mock_ai.py`)

`AGLEX_MOCK_AI=1` env makes `pipeline.analyze`,
`contract_analysis.analyze_contract`, `reconciliation.reconcile`, and
`lawyer_chat.chat` return deterministic fixtures. Used by Playwright e2e
and offline dev. `mock_display_pdf_bytes()` returns a pre-rendered PDF
from `e2e/fixtures/` so the soffice path can be skipped on CI.

### Workspace entities (`crud.py` + `models.py`)

15 entities: matters, tasks, clients, templates, invoices, time_entries,
clause_lib, laws, comments, approval, deadlines, obligations, versions,
reconciliations, contracts. Each = one `Entity` declaration; the factory
mounts five endpoints (`list / get / post / patch / delete`). Conventions:

- TEXT PKs with prefix (`m-…`, `tk-…`); seed rows from `seed_demo.py` have
  no dash (`m1`, `tk0`).
- `column_aliases` maps camelCase wire → snake_case columns.
- `json_columns` are JSON-encoded TEXT on disk, decoded on read.
- `_account_hides_demo(user)` strips seed rows from list/get for opted-in
  accounts (viktoria@aglex.ua).

## Frontend (`src/`)

### `App.jsx`

Single state hub: route, lang (uk/en), tweaks (accent/font/dark/density),
user (cached session), notifications. Realtime subscriber wired here.
`DEPRECATED_ROUTES` silently re-maps stale localStorage routes from old
nav refactors. The `EDITMODE-BEGIN`/`END` markers around `TWEAK_DEFAULTS`
are read by the tweaks panel persistence — don't strip them.

### `src/lib/`

- `api.js` — fetch helper. Maps every backend route under `api.<group>`.
  On 401 calls `lxSessionExpired()` → fires `AUTH_LOGOUT_EVENT` → App.jsx
  drops React state so the next render lands on `/auth`.
- `auth.js` — JWT in `localStorage` (`aglex_session_v2`). Has a
  client-side `exp` check with 30s skew for cheap stale-token detection;
  the server is still authoritative.
- `realtime.js` — WS client. Subscribes are pub/sub keyed by event type.

### Screens worth knowing

- `ContractAnalysis.jsx` (1471L) — single contract + reconciliation result
  views (branches on `incoming.reconcileRun`); `<ReconcileAnalyzingOverlay>`
  is the progress UI restored by PR #35.
- `Practice.jsx` (1366L) — matters list/detail, team picker, kanban tasks.
- `DocBuilder.jsx` (961L) — typed-form document generator (Phase 3.3).
- `Knowledge.jsx` — clause library, team & permissions screens.
- `screens/legislation/` — 3-column codex browser (sources rail → list →
  reader) with markdown reader (PR #58 replaced the PDF viewer).
- `screens/chat/` — persistent AI-lawyer sessions (PR #48), sidebar history.

## Deploy

`docker compose up -d --build` produces three containers: `backend`,
`frontend`, `nginx-edge`. Edge listens on host **port 8002**; backend stays
on internal `:8000`, frontend on internal `:80`. Volumes `aglex_db` and
`aglex_data` persist the SQLite file and codex sources across rebuilds.

CI: `.github/workflows/deploy.yml` runs `build-check` on every PR (imports
the FastAPI app + builds Vite), and on push to `main` SSHes to Hetzner,
`git pull`s, `docker compose up -d --build`, restarts nginx, sleeps 15s,
hits `/api/health`. If the Hetzner secrets aren't set, the deploy step
exits 0 (forks stay green).

## Patterns to copy

- **Add a backend endpoint** → use `Skill: add-route`. Mind the
  registration order (custom before generic CRUD).
- **Add a workspace entity** → declare an `Entity(...)` in `crud.py`,
  add the DDL to `models.ENTITY_SCHEMA`, add the camelCase aliases.
  `init_entity_schema` already runs in lifespan.
- **Add a realtime broadcast** → call `schedule_broadcast(conn,
  case_id=..., type_=..., data=...)` from the sync REST handler
  **after** `conn.commit()`. Subscribers live in `src/lib/realtime.js`.
- **Touch a prompt** → read `.claude/docs/RAG.md` first. Byte-stability
  is the cache invariant; spawn `Agent: ai-prompt-guardian` before
  merging.
