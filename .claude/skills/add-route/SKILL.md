---
name: add-route
description: Scaffold a new FastAPI endpoint in `legal_app/backend/` with the right auth gating, dependency injection, registration order in main.py, and matching wrapper in `src/lib/api.js`. Use when the user asks "add an endpoint for X" or "expose Y to the frontend".
---

You walk the user through adding a new HTTP endpoint correctly. Don't
skip steps even if some feel obvious — getting registration order or
auth gating wrong is the easy mistake.

## Ask first

1. **HTTP method + path** (e.g. `GET /api/matters/{case_id}/summary`).
2. **Auth gate**:
   - `Depends(current_user)` (just logged in)
   - `Depends(require("<cap>"))` (RBAC capability — `view`, `edit`,
     `ai`, `approve`, `sign`, `pdata`, `billing`, `manage`)
   - `Depends(require_member())` (case-level ACL — only for routes
     scoped to a specific matter)
3. **Where it lives**:
   - Existing module under `legal_app/backend/<area>.py`?
   - New module? Then a new `APIRouter(prefix="/api/<area>", tags=["<area>"])`.
4. **Does it collide with the generic CRUD?** Routes whose path matches
   `/api/<entity-with-dashes>` for an entry in `crud.ALL_ENTITIES` must
   either replace it (custom router) or live above the
   `for _entity in ALL_ENTITIES` loop in `main.py`.

## Backend scaffold

Inside the chosen module:

```python
from fastapi import APIRouter, Depends, HTTPException
from .auth import current_user
from .database import get_db
from .rbac import require            # if RBAC-gated
from .cases_acl import require_member, current_user_text_id  # if matter-scoped
import sqlite3

router = APIRouter(prefix="/api/<area>", tags=["<area>"])

@router.get("/<path>", dependencies=[Depends(require("<cap>"))])
def <handler_name>(
    user: dict = Depends(current_user),
    conn: sqlite3.Connection = Depends(get_db),
) -> dict:
    """One-line purpose. What it returns; what it raises."""
    row = conn.execute("SELECT ... FROM ... WHERE ... = ?", (...,)).fetchone()
    if row is None:
        raise HTTPException(404, "<thing> not found")
    return _row_to_dict(row)
```

Conventions to honour:

- **camelCase wire ↔ snake_case DB.** If the new endpoint reads/writes
  rows from a CRUD entity, route through `crud._row_to_dict(entity, row)`
  so the aliases apply.
- **Mock AI short-circuit.** If the route calls Claude, start the body
  with `if is_mock_ai(): return mock_<thing>()`.
- **Commit then broadcast.** If the route mutates a matter,
  `conn.commit()` before `schedule_broadcast(...)`.

## Register in `main.py`

If the module's router isn't already imported, add the import + the
`app.include_router(...)` call. Placement rules:

- Custom routers that handle a path the generic CRUD loop would also
  handle (e.g. `/api/matters/...`, `/api/contracts`) go **above** the
  `for _entity in ALL_ENTITIES` loop. Mark the generic loop's
  `if _entity.table == "<table>": continue` if you're fully replacing.
- Everything else goes alongside the existing `include_router` block at
  the top.

## Frontend wire-up (`src/lib/api.js`)

Add the wrapper next to the existing `api.<group>` blocks. Don't add
fetch calls inside a screen.

```js
const <group> = {
  <action>: (arg) => request(`/api/<area>/${encodeURIComponent(arg)}`),
  <create>: (body) => request('/api/<area>', { method: 'POST', body }),
};

export const api = {
  // ...existing...
  <group>,
};
```

If the route lives under one of the 15 generic CRUD entities,
`entity('<slug>')` may already cover it — don't add a parallel wrapper.

## Tests

Add a pytest module under `legal_app/tests/test_<area>.py` (or extend
an existing one). Pattern:

```python
def test_<thing>(client, auth_header):
    r = client.get("/api/<area>/<path>", headers=auth_header)
    assert r.status_code == 200
    assert r.json() == {...}
```

Existing fixtures (`client`, `auth_header`, `conn`, `seed_user`) live in
`legal_app/tests/conftest.py`. Use them, don't duplicate setup.

If the endpoint is reachable from the UI, extend `e2e/smoke.spec.js`
with one Playwright step (mock-AI mode covers AI calls).

## Output

Tell the user, in order:

1. The 3-line `@router.<verb>(...)` block to drop into `<area>.py`.
2. The exact `app.include_router(...)` line for `main.py` (and where
   it goes relative to the generic CRUD loop).
3. The new `api.<group>.<action>` wrapper for `src/lib/api.js`.
4. The pytest test stub.
5. One sentence reminder: "Run `Skill: pre-merge-checklist` before
   opening the PR."

Don't apply the edits unless the user says "do it". The skill is a
guide, not a doer.
