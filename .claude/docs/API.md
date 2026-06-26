# API catalogue

All routes are mounted on the same FastAPI app behind nginx at
`http://<host>:8002/api/...`. Auth: `Authorization: Bearer <jwt>` for
everything except `/api/auth/{register,login}` and `/api/health`.

`Depends(current_user)` = "any logged-in user".
`Depends(require("<cap>"))` = "user role has this RBAC capability".

## Auth — `auth.router`

| Method | Path                  | Auth          | Notes                                  |
|--------|-----------------------|---------------|----------------------------------------|
| POST   | `/api/auth/register`  | —             | `name, email, password, role` → JWT     |
| POST   | `/api/auth/login`     | —             | generic 401 message on failure          |
| GET    | `/api/auth/me`        | bearer        | returns the user row                    |
| POST   | `/api/auth/refresh`   | bearer        | rolling 1-year JWT, called on app mount |

## Health

| GET `/health` and `/api/health` — `{"status": "ok"}` (used by the deploy probe). |

## RAG / codex

| Method | Path                          | Cap     | Notes                              |
|--------|-------------------------------|---------|------------------------------------|
| GET    | `/api/codex/stats`            | `view`  | total + by-source + fts_ready + vec_ready |
| GET    | `/api/codex/sources`          | `view`  | sidebar payload                     |
| GET    | `/api/codex/articles`         | `view`  | `?source=...&q=...&limit=&offset=` (list or search mode) |
| GET    | `/api/codex/articles/{id}`    | `view`  | full article body                   |

## AI surfaces (gated by `ai` capability)

| Method | Path                       | Notes                                  |
|--------|----------------------------|----------------------------------------|
| POST   | `/api/analyze`             | one-shot question + optional section + sources filter |
| POST   | `/api/analyze/contract`    | structured findings/comparison/score/legal_basis      |
| POST   | `/api/reconcile`           | multipart: contract + handover → 15-category compare  |
| POST   | `/api/lawyer-chat`         | multi-turn chat (history shipped from FE)             |
| POST   | `/api/assist/summary`      | full-contract summary (lawyer or plain audience)      |
| POST   | `/api/assist/translate`    | translate a passage between UA/EN                     |
| POST   | `/api/generate-document`   | template + form → DOCX (doc builder, Phase 3.3)        |

## Chat sessions — `chat_sessions.router`

| Method | Path                                          | Notes                  |
|--------|-----------------------------------------------|------------------------|
| GET    | `/api/chat/sessions`                          | sessions list (own)    |
| POST   | `/api/chat/sessions`                          | create blank session   |
| PATCH  | `/api/chat/sessions/{id}`                     | rename                 |
| DELETE | `/api/chat/sessions/{id}`                     | cascade-deletes msgs   |
| GET    | `/api/chat/sessions/{id}/messages`            | full thread            |

## Document upload + display PDF

| Method | Path             | Notes                                                    |
|--------|------------------|----------------------------------------------------------|
| POST   | `/api/upload`    | PDF/DOCX → markdown + sections + token stats + display_pdf_b64 |

Display-PDF rendering uses LibreOffice (`soffice`). Failures are soft — they
return `display_pdf_error` in the response and store it alongside a NULL
BLOB so the UI can explain *why* the 1:1 viewer is unavailable.

## Matters — `matters_routes.router` (custom, NOT the generic CRUD)

| Method | Path                                                     | Auth           |
|--------|----------------------------------------------------------|----------------|
| GET    | `/api/matters`                                           | scoped to caller's `case_members` |
| GET    | `/api/matters/{id}`                                      | `require_member`                  |
| POST   | `/api/matters`                                           | auto-generates `{TYPE}-{YEAR}-{NN}` code |
| PATCH  | `/api/matters/{id}`                                      | per-field activity_log entry      |
| POST   | `/api/matters/{id}/members`                              | lead/partner only                 |
| DELETE | `/api/matters/{id}/members/{member_user_id}`             | lead/partner only                 |
| POST   | `/api/matters/{id}/{notes\|hearings\|parties\|tasks\|time-entries}` | activity_log + WS broadcast |

## Drafts — `drafts.router` (custom, replaces generic CRUD)

GET/PATCH/DELETE include per-row author vs `shared_with` checks.

## Workspace entities — generic CRUD via `crud.build_router`

For every entity in `crud.ALL_ENTITIES` except `matters` (custom router) and
`contracts` (custom POST for the display-PDF BLOB), five endpoints are
mounted automatically:

```
GET    /api/<table-with-dashes>           list_rows
GET    /api/<table-with-dashes>/{pk}      get_row
POST   /api/<table-with-dashes>           insert_row
PATCH  /api/<table-with-dashes>/{pk}      update_row
DELETE /api/<table-with-dashes>/{pk}      delete_row
```

Tables: `tasks, clients, templates, invoices, time-entries, clause-lib,
laws, comments, approval, deadlines, obligations, versions, reconciliations,
contracts`.

`invoices` is double-gated by the `billing` capability for both read and
write (Phase 2.3, see `main.py`).

## Team & RBAC — `team.router`

| Method | Path                                | Cap     |
|--------|-------------------------------------|---------|
| GET    | `/api/team/members`                 | view    |
| PATCH  | `/api/team/members/{id}`            | manage  |
| DELETE | `/api/team/members/{id}`            | manage  |
| POST   | `/api/team/members`                 | manage  |
| GET    | `/api/team/permissions`             | manage  |
| PATCH  | `/api/team/permissions`             | manage  |
| POST   | `/api/team/permissions/reset`       | manage  |
| GET    | `/api/team/audit`                   | manage  |

## Notifications + calendar

| Method | Path                                      | Notes                          |
|--------|-------------------------------------------|--------------------------------|
| GET    | `/api/notifications?unread=&limit=`       | scoped to caller               |
| POST   | `/api/notifications/{id}/read`            |                                |
| POST   | `/api/notifications/read-all`             |                                |
| GET    | `/api/calendar/events?from_=&to=&only_mine=` | aggregates hearings + tasks |

## WebSocket — `/ws`

`GET /ws?token=<jwt>` (browsers can't set Authorization on `new WebSocket`).
Server validates the JWT, registers the socket, and only replies to client
`{"type":"ping"}` with `{"type":"pong"}`. All meaningful events are pushed
from the server (`schedule_broadcast` / `schedule_notify`).
