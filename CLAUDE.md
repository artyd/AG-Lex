# AG Lex

AI-assisted legal workspace for the «Альянс Груп 95» law firm: contract
analysis, contract↔handover reconciliation, an AI-lawyer chat grounded in the
Ukrainian codex (ЦКУ/ГКУ/КК/КЗпП/КУпАП + EU regulations), matters/tasks/billing
CRUD, RBAC, and realtime case collaboration.

## Stack

| Layer    | Tech                                                                    |
|----------|-------------------------------------------------------------------------|
| Frontend | React 19, Vite 8, ESLint 10, vitest, JSX (no TypeScript)                |
| Backend  | FastAPI, Python 3.12, uvicorn (single worker), pydantic v2              |
| Storage  | SQLite + `sqlite-vec` (vectors) + FTS5 (keyword) — `legal_app/database/legal.sqlite` |
| AI       | Anthropic Claude (Sonnet 4.6 default) · prompt caching · structured output |
| Embed    | sentence-transformers `paraphrase-multilingual-MiniLM-L12-v2`            |
| Docs PDF | LibreOffice `soffice` (DOCX/XLSX → PDF for FE rendering)                |
| Edge     | nginx (port 8002 host) → backend `:8000` + frontend `:80` + `/ws`        |
| Deploy   | docker-compose on Hetzner via `.github/workflows/deploy.yml` (SSH)       |
| E2E      | Playwright with `AGLEX_MOCK_AI=1` (deterministic fixtures, no tokens)    |

## Layout

```
legal_app/backend/      27 modules — FastAPI app, routes, RAG, Claude wrapper
  main.py               lifespan + router registration + WS endpoint
  auth.py rbac.py       JWT/bcrypt + 5 roles × 8 capabilities matrix
  cases_acl.py          row-level access to matters (case_members)
  crud.py models.py     generic CRUD factory + 15-entity schema
  database.py           sqlite + sqlite-vec connection, FTS5 triggers
  search.py             hybrid search (vector + BM25, RRF fusion)
  claude_client.py      anthropic SDK + cache breakpoints + retry
  prompts.py            byte-stable system prompts (cache invariant)
  contract_analysis.py  /api/analyze/contract — JSON-schema structured output
  reconciliation.py     /api/reconcile — contract ↔ handover (Table 3)
  lawyer_chat.py        /api/lawyer-chat — multi-turn legal chat
  documents.py          PDF/DOCX/XLSX → markdown + display-PDF pipeline
  realtime.py           in-process WS fan-out (single worker only)
legal_app/scripts/      seed_demo.py · import_codex.py · check_codex.py
legal_app/data/codex_sources/    tsku, kk, kupap, kzpp, gdpr (.txt)
src/                    React SPA: App.jsx + lib/{api,auth,realtime}.js
src/screens/            ContractAnalysis · DocBuilder · Practice · Litigation · …
docker/ + nginx/        edge + per-service Dockerfiles + nginx config
e2e/                    Playwright smoke (AGLEX_MOCK_AI=1)
```

## Critical conventions

1. **Route ordering in `main.py`:** custom routers (matters, contracts POST,
   drafts) register **before** the `for _entity in ALL_ENTITIES: build_router(...)`
   loop, otherwise the generic CRUD handler wins the route match and bypasses
   row-level ACL / blob handling.
2. **Single uvicorn worker.** `realtime.ConnectionManager` is in-process —
   `--workers 2+` silently silos WS fan-out. Backend Dockerfile + dev README
   both pin `--workers 1`. Don't override.
3. **`prompts.py` is byte-stable.** Whitespace or wording changes invalidate
   every active Anthropic prompt-cache entry (5-min TTL × across servers).
   Treat edits like a versioned schema change.
4. **Wire ↔ DB casing.** CRUD payloads are camelCase, columns are snake_case.
   Mapping lives in each `Entity.column_aliases` (see `crud.py`). Don't
   reinvent — extend the mapping.
5. **Schemas are idempotent.** Every `init_*_schema` uses `CREATE IF NOT
   EXISTS`; seeds use `INSERT OR IGNORE`. Lifespan re-runs them on every boot.
   New tables must follow the same shape — fresh deploys and the persistent
   `aglex_db` volume both go through this path.

## Business-critical files — DO NOT silently modify

These need explicit approval; spawn the matching agent first.

| File(s) | Why | Agent |
|---------|-----|-------|
| `legal_app/backend/auth.py`, `rbac.py`, `cases_acl.py` | JWT signing, 5×8 RBAC matrix, row-level case ACL. Wrong change = auth bypass or perm escalation. | `auth-rbac-reviewer` |
| `legal_app/backend/prompts.py`, `claude_client.py`, `contract_analysis.py`, `reconciliation.py`, `lawyer_chat.py` | Byte-stable prompts (cache hits), JSON schemas for structured output, persona/legal voice. Token bill + legal correctness. | `ai-prompt-guardian` |
| `legal_app/backend/database.py`, `models.py` | Schema + migrations running against the populated `aglex_db` volume in prod. | `migration-safety-reviewer` |
| `legal_app/backend/main.py` (lifespan, router registration order) | One wrong move = generic CRUD overrides ACL/blob routes. | review by hand |
| `legal_app/backend/realtime.py` + `--workers` references | Single-worker invariant. | review by hand |

## More context

- Long-form architecture, patterns to copy, and module-by-module notes:
  [`.claude/PROJECT.md`](.claude/PROJECT.md)
- Per-topic deep references: [`.claude/docs/`](.claude/docs/)
- Sub-agents (guards + reviewers): [`.claude/agents/`](.claude/agents/)
- Recurring workflows: [`.claude/skills/`](.claude/skills/) and [`.claude/commands/`](.claude/commands/)
- Daily-audit + lesson log: [`.claude/audits/`](.claude/audits/), [`.claude/docs/LESSONS.md`](.claude/docs/LESSONS.md)
