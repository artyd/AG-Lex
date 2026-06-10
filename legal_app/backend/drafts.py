"""Draft documents — custom router with personal / team scoping.

Fix 1 swaps the generic CRUD that Phase 3.3 stood up for a dedicated module
because none of the other 13 workspace entities need per-row authorization.
Rules:

  - List returns rows where `user_id = current_user.id` OR `is_shared = 1`.
    The author column comes from a `JOIN users` so the UI can label team
    drafts with whoever wrote them.
  - Create injects `user_id` from the JWT — never trusts the body.
  - Get / PATCH / DELETE: visible if mine or shared, but mutations are
    rejected unless I'm the author or my role has `manage`.
  - PATCH /{id}/share toggles `is_shared`. Same author-or-manage gate.

The wire shape mirrors the prototype (camelCase `typeId`, `documentMarkdown`,
`createdAt`, `userId`, `isShared`, `authorName`). JSON columns (`params`,
`options`) decode to objects on read and encode on write.
"""
from __future__ import annotations

import json
import sqlite3
import uuid
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from .auth import current_user
from .database import get_db
from .rbac import has_capability


router = APIRouter(prefix="/api/drafts", tags=["drafts"])


# ---------------------------------------------------------------------------
# Pydantic
# ---------------------------------------------------------------------------

class DraftIn(BaseModel):
    typeId: str = Field(..., min_length=1)
    name: str = Field(..., min_length=1, max_length=500)
    party: Optional[str] = None
    documentMarkdown: str = Field(..., min_length=1)
    params: Optional[dict] = None
    options: Optional[dict] = None
    # Optional override; we default to "now" when omitted. Kept for parity with
    # the frontend that already sends `createdAt`.
    createdAt: Optional[str] = None


class DraftPatch(BaseModel):
    name: Optional[str] = None
    party: Optional[str] = None
    documentMarkdown: Optional[str] = None
    params: Optional[dict] = None
    options: Optional[dict] = None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_SELECT_SQL = """
SELECT d.id, d.type_id, d.name, d.party, d.document_markdown,
       d.params, d.options, d.created_at, d.user_id, d.is_shared,
       u.name AS author_name
FROM drafts d
LEFT JOIN users u ON u.id = d.user_id
"""


def _row_to_dict(row) -> dict | None:
    if row is None:
        return None
    params: Any = row[5]
    options: Any = row[6]
    try:
        params = json.loads(params) if isinstance(params, str) else (params or {})
    except json.JSONDecodeError:
        params = {}
    try:
        options = json.loads(options) if isinstance(options, str) else (options or {})
    except json.JSONDecodeError:
        options = {}
    return {
        "id": row[0],
        "typeId": row[1],
        "name": row[2],
        "party": row[3],
        "documentMarkdown": row[4],
        "params": params,
        "options": options,
        "createdAt": row[7],
        "userId": row[8],
        "isShared": bool(row[9]),
        "authorName": row[10],
    }


def _can_mutate(draft_row: dict, user: dict, conn: sqlite3.Connection) -> bool:
    """Author OR `manage` may edit/delete/share."""
    if draft_row["userId"] is not None and draft_row["userId"] == user["id"]:
        return True
    return has_capability(conn, user["role"], "manage")


def _new_id() -> str:
    return f"dr-{uuid.uuid4().hex[:10]}"


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.get("")
def list_drafts(
    user: dict = Depends(current_user),
    conn: sqlite3.Connection = Depends(get_db),
) -> list[dict]:
    """Personal drafts I authored + team-shared drafts from anyone."""
    rows = conn.execute(
        _SELECT_SQL + "WHERE d.user_id = ? OR d.is_shared = 1 "
                      "ORDER BY datetime(d.created_at) DESC",
        (user["id"],),
    ).fetchall()
    return [_row_to_dict(r) for r in rows]


@router.get("/{draft_id}")
def get_draft(
    draft_id: str,
    user: dict = Depends(current_user),
    conn: sqlite3.Connection = Depends(get_db),
) -> dict:
    row = conn.execute(_SELECT_SQL + "WHERE d.id = ?", (draft_id,)).fetchone()
    draft = _row_to_dict(row)
    if draft is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Draft not found")
    # Only mine or team-shared rows are visible.
    if not draft["isShared"] and draft["userId"] != user["id"]:
        # 404 (not 403) to avoid leaking the existence of other people's
        # personal drafts.
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Draft not found")
    return draft


@router.post("", status_code=status.HTTP_201_CREATED)
def create_draft(
    body: DraftIn,
    user: dict = Depends(current_user),
    conn: sqlite3.Connection = Depends(get_db),
) -> dict:
    from datetime import datetime, timezone
    draft_id = _new_id()
    created_at = body.createdAt or datetime.now(tz=timezone.utc).isoformat()
    conn.execute(
        "INSERT INTO drafts "
        "(id, type_id, name, party, document_markdown, params, options, "
        " created_at, user_id, is_shared) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)",
        (
            draft_id,
            body.typeId,
            body.name,
            body.party,
            body.documentMarkdown,
            json.dumps(body.params or {}, ensure_ascii=False),
            json.dumps(body.options or {}, ensure_ascii=False),
            created_at,
            user["id"],
        ),
    )
    conn.commit()
    row = conn.execute(_SELECT_SQL + "WHERE d.id = ?", (draft_id,)).fetchone()
    return _row_to_dict(row)


@router.patch("/{draft_id}")
def update_draft(
    draft_id: str,
    body: DraftPatch,
    user: dict = Depends(current_user),
    conn: sqlite3.Connection = Depends(get_db),
) -> dict:
    row = conn.execute(_SELECT_SQL + "WHERE d.id = ?", (draft_id,)).fetchone()
    draft = _row_to_dict(row)
    if draft is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Draft not found")
    if not _can_mutate(draft, user, conn):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only the author or a manager can edit this draft.")

    updates: dict[str, Any] = {}
    if body.name is not None:
        updates["name"] = body.name
    if body.party is not None:
        updates["party"] = body.party
    if body.documentMarkdown is not None:
        updates["document_markdown"] = body.documentMarkdown
    if body.params is not None:
        updates["params"] = json.dumps(body.params, ensure_ascii=False)
    if body.options is not None:
        updates["options"] = json.dumps(body.options, ensure_ascii=False)

    if updates:
        set_clause = ", ".join(f"{col} = ?" for col in updates)
        conn.execute(
            f"UPDATE drafts SET {set_clause} WHERE id = ?",
            (*updates.values(), draft_id),
        )
        conn.commit()

    row = conn.execute(_SELECT_SQL + "WHERE d.id = ?", (draft_id,)).fetchone()
    return _row_to_dict(row)


@router.delete("/{draft_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_draft(
    draft_id: str,
    user: dict = Depends(current_user),
    conn: sqlite3.Connection = Depends(get_db),
):
    row = conn.execute(_SELECT_SQL + "WHERE d.id = ?", (draft_id,)).fetchone()
    draft = _row_to_dict(row)
    if draft is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Draft not found")
    if not _can_mutate(draft, user, conn):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only the author or a manager can delete this draft.")
    conn.execute("DELETE FROM drafts WHERE id = ?", (draft_id,))
    conn.commit()


@router.patch("/{draft_id}/share")
def share_draft(
    draft_id: str,
    user: dict = Depends(current_user),
    conn: sqlite3.Connection = Depends(get_db),
) -> dict:
    """Toggle `is_shared`. Author or `manage` only.

    Returning the full updated draft is the cheapest way for the UI to
    re-render without a follow-up GET.
    """
    row = conn.execute(_SELECT_SQL + "WHERE d.id = ?", (draft_id,)).fetchone()
    draft = _row_to_dict(row)
    if draft is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Draft not found")
    if not _can_mutate(draft, user, conn):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "Only the author or a user with the 'manage' capability can share this draft.",
        )
    new_value = 0 if draft["isShared"] else 1
    conn.execute("UPDATE drafts SET is_shared = ? WHERE id = ?", (new_value, draft_id))
    conn.commit()
    row = conn.execute(_SELECT_SQL + "WHERE d.id = ?", (draft_id,)).fetchone()
    return _row_to_dict(row)
