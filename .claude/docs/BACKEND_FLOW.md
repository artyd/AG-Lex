# Backend request flow

## Boot (`main.py:lifespan`)

```
uvicorn starts
  → set_main_loop()                # captures the loop for sync-handler broadcasts
  → init_schema(conn)              # articles + FTS + triggers + backfill
  → init_user_schema(conn)         # users
  → init_chat_schema(conn)         # chat_sessions, chat_messages
  → init_entity_schema(conn)       # 15 workspace tables + ACL tables
  → init_permissions_schema(conn)  # permissions matrix
  → init_audit_schema(conn)        # audit log
  → migrate_drafts / users / matters / reconciliations / contracts
  → seed_test_user, seed_viktoria_user
  → seed_default_permissions
  → seed_demo.seed_all             # INSERT OR IGNORE demo workspace data
  → threading.Thread(_bootstrap_codex_in_background).start()
  → yield                          # app is now ready
```

The codex bootstrap runs out-of-band because the deploy probe's window is
15s and the embedding model download is ~200 MB. See PR #60.

## Router registration order (do NOT reorder)

```python
app.include_router(auth_module.router)            # /api/auth/*
app.include_router(team_module.router)            # /api/team/*
app.include_router(assist_module.router)          # /api/assist/*
app.include_router(builder_module.router)         # /api/generate-document
app.include_router(lawyer_chat_module.router)     # /api/lawyer-chat
app.include_router(chat_sessions_module.router)   # /api/chat/sessions/*
app.include_router(drafts_module.router)          # /api/drafts/* (custom, not generic)
app.include_router(matters_module.router)         # /api/matters/* (custom + row ACL)
app.include_router(notifications_module.router)   # /api/notifications/*
app.include_router(calendar_module.router)        # /api/calendar/*

# Custom POST /api/contracts (display-PDF BLOB) — declared before the loop
# so it wins the POST route match. GET/PATCH/DELETE still come from the
# loop's build_router(CONTRACTS).
@app.post("/api/contracts", ...)
def create_contract_with_pdf(...): ...

# Generic CRUD loop — skips matters (already mounted with row ACL).
for _entity in ALL_ENTITIES:
    if _entity.table == "matters": continue
    if _entity.table == "invoices":
        app.include_router(build_router(_entity, read_capability="billing",
                                                 write_capability="billing"))
    else:
        app.include_router(build_router(_entity))
```

Why this order matters:
- `matters_module.router` must register before `build_router(MATTERS)` would
  fire, otherwise the generic CRUD shadows the row-level ACL.
- The custom `POST /api/contracts` must register before `build_router(CONTRACTS)`
  so the BLOB writer wins.
- Drafts moved to a custom router because the generic CRUD has no per-row
  author/team-share check knobs.

## Per-request lifecycle

```
nginx (host:8002)
  → /api/* → backend:8000 → FastAPI
                              → middleware (none custom)
                              → dependency resolution:
                                   _oauth2_scheme  → extract Bearer
                                   current_user    → decode JWT, load user
                                   require("cap")  → permissions matrix check
                                   require_member  → case_members check (for /api/matters/*)
                                   get_db          → fresh sqlite3.Connection
                              → route handler runs (sync handlers in threadpool)
                              → conn.commit()
                              → schedule_broadcast / schedule_notify (optional)
                              → response JSON
                              → get_db close
```

## Common patterns

### Read row → return

```python
@router.get("/{id}", dependencies=[Depends(require("view"))])
def get_thing(id: str, conn: sqlite3.Connection = Depends(get_db)) -> dict:
    row = conn.execute("SELECT ... FROM things WHERE id = ?", (id,)).fetchone()
    if row is None:
        raise HTTPException(404, "thing not found")
    return _row_to_dict(row)
```

### Write row → commit → broadcast

```python
@router.post("/{case_id}/notes",
             dependencies=[Depends(require_member())], status_code=201)
def add_note(
    case_id: str,
    body: NoteIn,
    user_text_id: str = Depends(current_user_text_id),
    conn: sqlite3.Connection = Depends(get_db),
) -> dict:
    note_id = uuid.uuid4().hex
    conn.execute("INSERT INTO case_notes (...) VALUES (...)", (...))
    conn.commit()  # commit BEFORE scheduling the broadcast
    schedule_broadcast(conn, case_id=case_id, type_="note.added",
                       actor_id=user_text_id, data={"id": note_id, ...})
    return {"id": note_id, ...}
```

### Claude-backed endpoint

```python
@app.post("/api/<thing>", dependencies=[Depends(require("ai"))])
def do_thing(req: ThingRequest, conn: sqlite3.Connection = Depends(get_db)):
    if is_mock_ai():
        return mock_thing()                 # short-circuit for e2e
    hits = hybrid_search(req.question, source=req.sources, conn=conn)
    try:
        result = ask_claude(req.question, hits, contract_section=req.section)
    except ClaudeError as e:
        raise HTTPException(502, str(e))
    return result
```

## Threadpool ↔ event loop

Sync REST handlers run in a threadpool. Two consequences:

1. `get_db` opens the SQLite connection with `check_same_thread=False` so
   the connection can cross the threadpool boundary inside the request.
2. `asyncio.get_running_loop()` won't see the main loop from inside the
   threadpool. `realtime.set_main_loop(...)` is called from `lifespan` to
   capture it; `_schedule(coro)` falls back to `run_coroutine_threadsafe`
   on that captured loop when not in an async context.
