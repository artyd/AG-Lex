# Auth, RBAC, and case-level ACL

Three layers, in order of evaluation:

1. **JWT** (`current_user`) — is this a logged-in user?
2. **RBAC** (`require("<cap>")`) — does the user's role hold this capability?
3. **Case ACL** (`require_member()`) — is the user in `case_members` for the
   case in the URL?

## JWT (`legal_app/backend/auth.py`)

- Signed with HS256 using `settings.JWT_SECRET`.
- TTL **1 year** (`TOKEN_TTL_HOURS = 24 * 365`).
- Payload: `{sub: user_id_str, role, iat, exp}`.
- Rolling refresh: the FE calls `POST /api/auth/refresh` on every mount, so
  any user who opens the app at least once a year never sees a login screen.
- Login failures return one generic message — same wording, same timing,
  no user enumeration via the response body.
- bcrypt direct (passlib dropped — bcrypt 4.x's `__about__` changed and
  broke passlib's probe). UTF-8 input is truncated to 72 bytes before
  hashing because Cyrillic chars are 2 bytes each in UTF-8.

### Seeded accounts

| Email                | Password         | Role     | Notes                                     |
|----------------------|------------------|----------|-------------------------------------------|
| `test@aglex.ua`      | `test1234`       | partner  | Demo account; sees full seeded workspace.  |
| `viktoria@aglex.ua`  | `viktoria2026`   | partner  | Clean workspace — `crud._account_hides_demo` filters seed rows. Handover credential — rotate after first login. |

Both seeds are idempotent (`if get_user_by_email(...) return`).

## RBAC matrix (`legal_app/backend/rbac.py`)

5 roles × 8 capabilities, stored as one row per cell in the `permissions`
table. Defaults match `src/data/lx.js` (`LX.permissions`) so a fresh
install behaves like the prototype.

| Capability | Description (UA UI label)            | Default holders                     |
|------------|--------------------------------------|-------------------------------------|
| `view`     | Перегляд договорів                   | partner, senior, lawyer, paralegal, admin |
| `edit`     | Редагування та правки                | partner, senior, lawyer              |
| `ai`       | Запуск ШІ-аналізу                    | partner, senior, lawyer, paralegal   |
| `approve`  | Погодження редакції                  | partner, senior                      |
| `sign`     | Електронний підпис                   | partner                              |
| `pdata`    | Доступ до персональних даних         | partner, senior, lawyer, admin       |
| `billing`  | Білінг і рахунки                     | partner, admin                       |
| `manage`   | Керування командою                   | partner, admin                       |

### `Depends(require("<cap>"))`

Drop the dependency onto any route to gate it:

```python
@app.post("/api/analyze", dependencies=[Depends(require("ai"))])
def analyze(...): ...
```

Role comes from the JWT-validated user — never from the request body.
That's the trust boundary; everything else is bookkeeping.

### Generic CRUD double-gating

`build_router(entity)` defaults to `Depends(current_user)` only. The
`invoices` entity registers with explicit caps:

```python
build_router(_entity, read_capability="billing", write_capability="billing")
```

To add another double-gated entity, follow the same pattern in `main.py`'s
registration loop.

### Audit log

Every team-management action lands in `audit` via `audit.log(...)`. UI tail
lives at `GET /api/team/audit` (manage cap required). Action codes are
canonical strings — translation to display labels happens client-side via
i18n.

## Case-level ACL (`legal_app/backend/cases_acl.py`)

Row-level access to matters. The `case_members` table is the source of
truth — a user only sees a matter if they're a member (or the request
is by a partner via the team-wide override at the route level).

### `Depends(require_member())`

Drops a 403 when the authenticated user (resolved to their TEXT id) isn't
in `case_members` for the case in the path.

```python
@router.get("/{case_id}", dependencies=[Depends(require_member())])
def get_matter(case_id: str, ...): ...
```

### TEXT user-id bridge

The matters/ACL domain uses TEXT user IDs (`u1`, `u2`, …) inherited from
the prototype. Auth uses INTEGER `users.id`. `users.legacy_id` is the
bridge column. `resolve_user_text_id`:

- Returns `users.legacy_id` if set.
- Otherwise fabricates `u{user_int_id}` and persists it back to the row
  (idempotent — only fills NULL).

That's why new accounts work in matters without any seed step.

### Membership writes

`add_member` and `remove_member` always update three things in one
transaction:

1. `case_members`
2. `activity_log` (action `member.added` / `member.removed`)
3. `notifications` (for the added user — silent on self-add)

After commit, the route handler calls `schedule_broadcast(...)` to push
the membership event to every existing member of the case.

## Realtime auth

`/ws?token=<jwt>` validates the JWT (browsers can't set Authorization on
`new WebSocket`). Failures close the socket with code 1008 (policy
violation) — what browsers see as "401 over WS". The server registers the
socket against the resolved TEXT user id, then only handles client `ping`
frames. Every meaningful event is server-pushed via `ConnectionManager`.
