"""Connected MCP apps: list + revoke (docs/mcp/DESIGN.md §5).

- `/api/me/connected-apps` — the current user's own connections.
- `/api/admin/connected-apps` — everyone's, `manage` capability only
  (lost laptop, departing lawyer, suspicious client).

Revocation kills every token the client holds for that user; the client
must go through the OAuth consent again. Both actions land in `audit`.
"""
from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Depends, HTTPException

from . import audit as audit_module
from .auth import current_user
from .database import get_db
from .oauth_store import list_grants, revoke_grant
from .rbac import require

ACTION_MCP_REVOKE = "mcp_revoke"

router = APIRouter(tags=["mcp"])


@router.get("/api/me/connected-apps")
def my_connected_apps(
    user: dict = Depends(current_user),
    conn: sqlite3.Connection = Depends(get_db),
) -> list[dict]:
    return list_grants(conn, user_id=user["id"])


@router.delete("/api/me/connected-apps/{client_id}")
def revoke_my_app(
    client_id: str,
    user: dict = Depends(current_user),
    conn: sqlite3.Connection = Depends(get_db),
) -> dict:
    n = revoke_grant(conn, client_id=client_id, user_id=user["id"])
    if n == 0:
        raise HTTPException(status_code=404, detail="Підключення не знайдено.")
    audit_module.log(conn, actor=user, action=ACTION_MCP_REVOKE, target=client_id,
                     meta={"user_id": user["id"], "by": "self"})
    return {"revoked": n}


@router.get("/api/admin/connected-apps")
def all_connected_apps(
    user: dict = Depends(require("manage")),
    conn: sqlite3.Connection = Depends(get_db),
) -> list[dict]:
    return list_grants(conn)


@router.delete("/api/admin/connected-apps/{client_id}/{user_id}")
def revoke_app_for_user(
    client_id: str,
    user_id: int,
    user: dict = Depends(require("manage")),
    conn: sqlite3.Connection = Depends(get_db),
) -> dict:
    n = revoke_grant(conn, client_id=client_id, user_id=user_id)
    if n == 0:
        raise HTTPException(status_code=404, detail="Підключення не знайдено.")
    audit_module.log(conn, actor=user, action=ACTION_MCP_REVOKE, target=client_id,
                     meta={"user_id": user_id, "by": "admin"})
    return {"revoked": n}
