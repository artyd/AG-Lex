"""Connected MCP apps + privilege policy (docs/mcp/DESIGN.md §5, §6).

- `/api/me/connected-apps` — the current user's own connections.
- `/api/admin/connected-apps` — everyone's, `manage` capability only
  (lost laptop, departing lawyer, suspicious client).

Revocation kills every token the client holds for that user; the client
must go through the OAuth consent again. Both actions land in `audit`.

- `/api/mcp/policy` — `manage` only: list matters/clients with their
  `ai_external` flag and toggle it. Denied data never reaches external AI
  through MCP (mcp_acl.check_matter_policy + filters in the tools).
"""
from __future__ import annotations

import sqlite3
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from . import audit as audit_module
from .auth import current_user
from .database import get_db
from .oauth_store import (
    GLOBAL_DOCUMENTS,
    denied_keys,
    documents_all_denied,
    list_grants,
    norm_name,
    revoke_grant,
    set_policy,
)
from .rbac import require

ACTION_MCP_REVOKE = "mcp_revoke"
ACTION_MCP_POLICY = "mcp_policy"

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


# ---------------------------------------------------------------------------
# privilege policy
# ---------------------------------------------------------------------------

class PolicyIn(BaseModel):
    kind: Literal["matter", "client", "document", "global"]
    key: str = Field(..., min_length=1, max_length=300)
    deny: bool


@router.get("/api/mcp/policy")
def get_policy(
    user: dict = Depends(require("manage")),
    conn: sqlite3.Connection = Depends(get_db),
) -> dict:
    denied_m, denied_c = denied_keys(conn)
    matters = [
        {
            "id": r[0], "code": r[1], "title": r[2], "client": r[3],
            "denied": r[0] in denied_m,
            "deniedViaClient": norm_name(r[3]) in denied_c,
        }
        for r in conn.execute("SELECT id, code, title, client FROM matters ORDER BY code").fetchall()
    ]
    # One row per normalised name across all three free-text sources.
    by_norm: dict[str, str] = {}
    for sql in ("SELECT name FROM clients", "SELECT client FROM matters", "SELECT client FROM invoices"):
        for (n,) in conn.execute(sql):
            if n and n.strip():
                by_norm.setdefault(norm_name(n), n.strip())
    clients = [{"name": disp, "denied": key in denied_c} for key, disp in sorted(by_norm.items())]
    # Denied names that no longer match anything (renamed client?) — surface
    # them so the partner can re-apply the flag to the new spelling.
    stale = sorted(
        k for (k,) in conn.execute("SELECT key FROM mcp_policy WHERE kind = 'client'")
        if norm_name(k) not in by_norm
    )
    return {
        "matters": matters,
        "clients": clients,
        "staleClients": stale,
        "documentsDenied": documents_all_denied(conn),
    }


@router.put("/api/mcp/policy")
def put_policy(
    body: PolicyIn,
    user: dict = Depends(require("manage")),
    conn: sqlite3.Connection = Depends(get_db),
) -> dict:
    key = body.key.strip()
    if body.kind == "matter" and not conn.execute("SELECT 1 FROM matters WHERE id = ?", (key,)).fetchone():
        raise HTTPException(status_code=404, detail="Справу не знайдено.")
    if body.kind == "document" and not conn.execute("SELECT 1 FROM documents WHERE id = ?", (key,)).fetchone():
        raise HTTPException(status_code=404, detail="Документ не знайдено.")
    if body.kind == "global" and key != GLOBAL_DOCUMENTS:
        raise HTTPException(status_code=422, detail=f"global key must be '{GLOBAL_DOCUMENTS}'.")
    if body.kind == "client":
        known = {
            norm_name(n)
            for sql in ("SELECT name FROM clients", "SELECT client FROM matters", "SELECT client FROM invoices")
            for (n,) in conn.execute(sql)
        }
        stored = {norm_name(k): k for (k,) in conn.execute("SELECT key FROM mcp_policy WHERE kind = 'client'")}
        if norm_name(key) not in known and norm_name(key) not in stored:
            raise HTTPException(status_code=404, detail="Клієнта не знайдено.")
        key = stored.get(norm_name(key), key)  # un-deny must hit the stored spelling
    was = conn.execute("SELECT 1 FROM mcp_policy WHERE kind = ? AND key = ?", (body.kind, key)).fetchone() is not None
    if was == body.deny:
        return {"kind": body.kind, "key": key, "denied": body.deny}  # no-op: no audit noise
    set_policy(conn, kind=body.kind, key=key, deny=body.deny, user_id=user["id"])
    audit_module.log(conn, actor=user, action=ACTION_MCP_POLICY, target=f"{body.kind}:{key}",
                     meta={"ai_external": "deny" if body.deny else "allow"})
    return {"kind": body.kind, "key": key, "denied": body.deny}
