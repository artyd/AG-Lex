# Database

Single SQLite file. Production volume: `aglex_db` mounted at
`/app/legal_app/database/legal.sqlite`. **Never delete by hand** — the
codex re-import on a fresh volume is multi-minute.

Connection: `legal_app/backend/database.py:get_connection()` loads the
`sqlite-vec` extension and sets `PRAGMA foreign_keys = ON`. Every request
opens a fresh connection via the `get_db()` dependency.

## RAG tables — `database.SCHEMA`

```sql
articles (
    id              INTEGER PRIMARY KEY,
    article_number  TEXT NOT NULL,
    title           TEXT,
    content         TEXT NOT NULL,
    source          TEXT NOT NULL,         -- ЦКУ, ГКУ, EU_GDPR, ...
    embedding       BLOB,                  -- float32 vector, sqlite-vec
    UNIQUE(article_number, source)
)
articles_fts          -- FTS5 external-content mirror, tokenize='unicode61'
                      -- triggers keep it in sync on insert/update/delete
```

`_FTS_BACKFILL` re-runs inside `init_schema` so any pre-existing rows that
missed the trigger (e.g. imported before FTS was wired) get indexed.

## Auth — `database.USER_SCHEMA`

```sql
users (
    id              INTEGER PRIMARY KEY,
    email           TEXT UNIQUE NOT NULL,  -- lowercased on write
    name            TEXT NOT NULL,
    role            TEXT NOT NULL,         -- partner/senior/lawyer/paralegal/admin
    password_hash   TEXT NOT NULL,         -- bcrypt
    created_at      TEXT NOT NULL,
    legacy_id       TEXT                   -- TEXT bridge (u1, u2, …); back-filled
)
```

`legacy_id` is the bridge to the prototype's TEXT user IDs used across the
matters/ACL domain. `cases_acl.resolve_user_text_id` fabricates one if
missing — that's why new accounts start working without any seed step.

## Chat — `database.CHAT_SCHEMA`

```sql
chat_sessions  (id TEXT PK, user_id INT FK CASCADE, title, created_at, updated_at)
chat_messages  (id INT PK, session_id TEXT FK CASCADE,
                role TEXT CHECK IN ('user','assistant'),
                content TEXT, created_at)
```

Cascade delete on `chat_sessions` wipes the message rows.

## Workspace entities — `models.ENTITY_SCHEMA`

15 tables, all TEXT PKs. CRUD comes from `crud.build_router(Entity(...))`.

```
matters          tasks            clients         templates
invoices         time_entries     clause_lib      laws
comments         approval         deadlines       obligations
versions         reconciliations  contracts
```

Extensions added by `models.migrate_*` (idempotent, PRAGMA-gated):
- `matters` — `summary, priority, opponent, court, judge, outcome,
  next_deadline, next_label, description, started_at, closed_at, updated_at`
- `users` — `legacy_id` (Phase 2.4 bridge)
- `drafts` — see `drafts.py` (custom router)
- `reconciliations` + `contracts` — `display_pdf BLOB`, `display_pdf_error TEXT`

## Realtime + collaboration — `models.ENTITY_SCHEMA` (Phase 2.4 block)

```sql
case_members   (case_id, user_id, role_in_case, added_at, added_by)
                PK (case_id, user_id)  -- composite

activity_log   (id, case_id, user_id, action, field, old_value, new_value, created_at)
                -- per-field change log; the matter timeline reads from here

notifications  (id, user_id, case_id, type, message, payload, is_read, created_at)
                -- pushed via /ws + readable via /api/notifications
```

`notifications.payload` is JSON-encoded TEXT.

## RBAC + audit

```sql
permissions    (capability, role, allowed, PK(capability, role))
audit          (id, ts, actor_id, actor_name, action, target, meta)
                -- meta is JSON-encoded TEXT
```

`actor_name` is denormalized so the log survives user deletion.

## JSON-encoded TEXT columns

These columns store JSON-as-TEXT and are decoded by `crud._row_to_dict`
on read:

| Table            | Columns                                            |
|------------------|----------------------------------------------------|
| `clause_lib`     | `tags`                                             |
| `comments`       | `mentions`                                         |
| `reconciliations`| `pair_json, rows_json, findings_json, docs_json`   |
| `contracts`      | `analysis_json`                                    |

## Migration discipline

- Every DDL is `CREATE IF NOT EXISTS`.
- Every `migrate_*` checks `PRAGMA table_info(...)` before `ALTER TABLE`.
- All seeds are `INSERT OR IGNORE`.
- Lifespan re-runs all of the above on every uvicorn start — never assume
  a fresh DB. Production has a populated volume.
- If you need a destructive migration, write a one-off script under
  `legal_app/scripts/` and document it in the PR body; **do not** put it in
  lifespan.

## Operational

- DB path: `legal_app/database/legal.sqlite` (dev) or
  `/app/legal_app/database/legal.sqlite` (Docker volume `aglex_db`).
- Backup: copy the SQLite file while the backend is stopped (or use SQLite
  online backup API).
- Reset: `docker compose down -v` wipes both `aglex_db` and `aglex_data`.
  Codex re-import on next start runs in the background (~minutes).
