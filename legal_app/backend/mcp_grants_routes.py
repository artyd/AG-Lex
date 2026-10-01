"""Connected MCP apps + privilege policy (docs/mcp/DESIGN.md §5, §6).

- `/api/me/connected-apps` — the current user's own connections.
- `/api/admin/connected-apps` — everyone's, `manage` capability only
  (lost laptop, departing lawyer, suspicious client).

Revocation kills every token the client holds for that user; the client
must go through the OAuth consent again. Both actions land in `audit`.

- `/api/me/mcp-links`, `/api/admin/mcp-links` — secret-link connectors
  (`/mcp/k/<key>`, no OAuth login). Creating one needs the account password
  again; the URL is shown once; links expire and can be revoked.
- `/api/mcp/policy` — `manage` only: list matters/clients with their
  `ai_external` flag and toggle it. Denied data never reaches external AI
  through MCP (mcp_acl.check_matter_policy + filters in the tools).
"""
from __future__ import annotations

import sqlite3
import time
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from . import audit as audit_module
from .auth import current_user
from .config import get_settings
from .database import get_db
from .oauth_store import (
    GLOBAL_DOCUMENTS,
    create_link,
    link_owner,
    list_links,
    revoke_all_for_user,
    revoke_link,
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
ACTION_MCP_LINK_CREATE = "mcp_link_create"
ACTION_MCP_LINK_REVOKE = "mcp_link_revoke"

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


# ---------------------------------------------------------------------------
# secret-link connectors (/mcp/k/<key>)
# ---------------------------------------------------------------------------

_PW_FAILS: dict[int, list[float]] = {}
_PW_LIMIT, _PW_WINDOW = 5, 15 * 60.0


def _pw_throttled(user_id: int) -> bool:
    now = time.time()
    recent = [t for t in _PW_FAILS.get(user_id, []) if now - t < _PW_WINDOW]
    _PW_FAILS[user_id] = recent
    return len(recent) >= _PW_LIMIT


def _pw_fail(user_id: int) -> None:
    _PW_FAILS.setdefault(user_id, []).append(time.time())


class LinkIn(BaseModel):
    label: str = Field("Claude Desktop", min_length=1, max_length=60)
    profile: Literal["full", "restricted"] = "full"
    password: str = Field(..., min_length=1, max_length=128)
    ttl_days: int = Field(90, ge=7, le=365)


@router.get("/api/me/mcp-links")
def my_links(user: dict = Depends(current_user), conn: sqlite3.Connection = Depends(get_db)) -> list[dict]:
    return list_links(conn, user_id=user["id"])


@router.post("/api/me/mcp-links", status_code=201)
def create_my_link(
    body: LinkIn,
    user: dict = Depends(current_user),
    conn: sqlite3.Connection = Depends(get_db),
) -> dict:
    """The link is a standing credential, so creating one re-checks the
    password (a stolen browser session alone can't mint one) and refuses
    accounts still on a password that is published in the repo."""
    from .auth import verify_password
    from .oauth_server import PUBLIC_DEMO_EMAILS, SEED_PASSWORDS

    if _pw_throttled(user["id"]):
        raise HTTPException(status_code=429, detail="Забагато невдалих спроб. Зачекайте 15 хвилин.")
    if not verify_password(body.password, user["password_hash"]):
        _pw_fail(user["id"])
        raise HTTPException(status_code=403, detail="Невірний пароль.")
    if user["email"] in PUBLIC_DEMO_EMAILS:
        raise HTTPException(status_code=403, detail="Демо-акаунт не може створювати посилання.")
    if SEED_PASSWORDS.get(user["email"]) == body.password:
        raise HTTPException(status_code=403, detail="Спершу змініть початковий пароль акаунта.")
    label = " ".join(body.label.split())
    try:
        link_id, key = create_link(conn, user=user, label=label, profile=body.profile, ttl_days=body.ttl_days)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e
    audit_module.log(conn, actor=user, action=ACTION_MCP_LINK_CREATE, target=label,
                     meta={"link_id": link_id, "profile": body.profile, "ttl_days": body.ttl_days})
    base = get_settings().PUBLIC_BASE_URL.rstrip("/")
    return {"id": link_id, "label": label, "profile": body.profile, "url": f"{base}/mcp/k/{key}",
            "expires_in_days": body.ttl_days,
            "warning": "Посилання показується один раз. Хто його має — працює від вашого імені."}


@router.delete("/api/me/mcp-links/{link_id}")
def revoke_my_link(link_id: int, user: dict = Depends(current_user), conn: sqlite3.Connection = Depends(get_db)) -> dict:
    if revoke_link(conn, link_id, user_id=user["id"]) == 0:
        raise HTTPException(status_code=404, detail="Посилання не знайдено.")
    audit_module.log(conn, actor=user, action=ACTION_MCP_LINK_REVOKE, target=str(link_id), meta={"by": "self"})
    return {"revoked": 1}


@router.get("/api/admin/mcp-links")
def all_links(user: dict = Depends(require("manage")), conn: sqlite3.Connection = Depends(get_db)) -> list[dict]:
    return list_links(conn)


@router.delete("/api/admin/mcp-links/{link_id}")
def revoke_any_link(link_id: int, user: dict = Depends(require("manage")),
                    conn: sqlite3.Connection = Depends(get_db)) -> dict:
    owner = link_owner(conn, link_id) or {}
    if revoke_link(conn, link_id) == 0:
        raise HTTPException(status_code=404, detail="Посилання не знайдено.")
    audit_module.log(conn, actor=user, action=ACTION_MCP_LINK_REVOKE, target=owner.get("label") or str(link_id),
                     meta={"by": "admin", "link_id": link_id, "owner": owner.get("email")})
    return {"revoked": 1}


@router.delete("/api/admin/mcp-access/{user_id}")
def revoke_all_mcp_access(user_id: int, user: dict = Depends(require("manage")),
                          conn: sqlite3.Connection = Depends(get_db)) -> dict:
    """Incident response: every link and OAuth token of one employee, at once."""
    n = revoke_all_for_user(conn, user_id)
    audit_module.log(conn, actor=user, action=ACTION_MCP_REVOKE, target=f"user:{user_id}",
                     meta={"by": "admin", "scope": "all", "count": n})
    return {"revoked": n}
