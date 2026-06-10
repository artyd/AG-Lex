"""Team module routes (spec §5.3): members + permissions + audit.

Phase 2.3. Three tabs in the frontend, one router here. All write operations
require the `manage` capability and the last-manage-holder safeguard kicks in
before any destructive change to roles, users, or the permission matrix.
"""
from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, Body, Depends, HTTPException, status
from pydantic import BaseModel, EmailStr, Field

from . import audit as audit_module
from .auth import (
    current_user,
    create_user,
    get_user_by_email,
    get_user_by_id,
)
from .database import get_db
from .rbac import (
    ROLES,
    count_manage_users,
    get_permissions_matrix,
    has_capability,
    reset_permissions_to_default,
    set_cell,
)


# ---------------------------------------------------------------------------
# Pydantic
# ---------------------------------------------------------------------------

Role = Literal["partner", "senior", "lawyer", "paralegal", "admin"]


class RoleChange(BaseModel):
    role: Role


class InviteRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    email: EmailStr
    role: Role
    password: str = Field(..., min_length=8, max_length=128)


class PermissionToggle(BaseModel):
    capability: str
    role: Role
    allowed: bool


# ---------------------------------------------------------------------------
# Manage-capability dependency
# ---------------------------------------------------------------------------
# We don't use rbac.require("manage") here directly because team-management
# actions need the current_user *object* (not just the gate) — for the audit
# `actor_name`. Resolve both at once.

def _require_manage(
    user: dict = Depends(current_user),
    conn: sqlite3.Connection = Depends(get_db),
) -> dict:
    if not has_capability(conn, user["role"], "manage"):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "Forbidden — your role does not have the 'manage' capability.",
        )
    return user


# ---------------------------------------------------------------------------
# Router
# ---------------------------------------------------------------------------

router = APIRouter(prefix="/api/team", tags=["team"])


def _public_user(user: dict) -> dict:
    return {
        "id": user["id"],
        "email": user["email"],
        "name": user["name"],
        "role": user["role"],
        "created_at": user["created_at"],
    }


# ---- members --------------------------------------------------------------

@router.get("/members")
def list_members(
    user: dict = Depends(current_user),
    conn: sqlite3.Connection = Depends(get_db),
) -> list[dict]:
    """Anyone authenticated can see the roster; only `manage` can mutate it."""
    rows = conn.execute(
        "SELECT id, email, name, role, password_hash, created_at FROM users ORDER BY id"
    ).fetchall()
    return [
        _public_user({"id": r[0], "email": r[1], "name": r[2], "role": r[3],
                      "password_hash": r[4], "created_at": r[5]})
        for r in rows
    ]


@router.patch("/members/{member_id}")
def change_role(
    member_id: int,
    change: RoleChange,
    user: dict = Depends(_require_manage),
    conn: sqlite3.Connection = Depends(get_db),
) -> dict:
    target = get_user_by_id(conn, member_id)
    if target is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Member not found")

    if target["role"] == change.role:
        return _public_user(target)

    old_role = target["role"]
    conn.execute("UPDATE users SET role = ? WHERE id = ?", (change.role, member_id))
    conn.commit()

    if count_manage_users(conn) < 1:
        # Roll the role back — must always have at least one manager.
        conn.execute("UPDATE users SET role = ? WHERE id = ?", (old_role, member_id))
        conn.commit()
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Cannot change role: at least one user must retain the 'manage' capability.",
        )

    updated = get_user_by_id(conn, member_id)
    audit_module.log(
        conn, actor=user, action=audit_module.ACTION_ROLE_CHANGE,
        target=f"{target['name']} → {change.role}",
        meta={"member_id": member_id, "from": old_role, "to": change.role},
    )
    return _public_user(updated)


@router.delete("/members/{member_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_member(
    member_id: int,
    user: dict = Depends(_require_manage),
    conn: sqlite3.Connection = Depends(get_db),
):
    if member_id == user["id"]:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Cannot remove yourself.")
    target = get_user_by_id(conn, member_id)
    if target is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Member not found")

    conn.execute("DELETE FROM users WHERE id = ?", (member_id,))
    conn.commit()

    if count_manage_users(conn) < 1:
        # Restore the user with their original hash + timestamps.
        conn.execute(
            "INSERT INTO users (id, email, name, role, password_hash, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (target["id"], target["email"], target["name"], target["role"],
             target["password_hash"], target["created_at"]),
        )
        conn.commit()
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Cannot remove member: at least one user must retain the 'manage' capability.",
        )

    audit_module.log(
        conn, actor=user, action=audit_module.ACTION_REMOVE,
        target=target["name"],
        meta={"member_id": member_id, "email": target["email"], "role": target["role"]},
    )


@router.post("/members", status_code=status.HTTP_201_CREATED)
def invite_member(
    body: InviteRequest,
    user: dict = Depends(_require_manage),
    conn: sqlite3.Connection = Depends(get_db),
) -> dict:
    """Create a user with a known initial password.

    Phase 2.3 MVP keeps this simple: caller supplies the initial password (or
    generates one client-side). A "magic link" invite flow can land later.
    """
    if get_user_by_email(conn, body.email):
        raise HTTPException(status.HTTP_409_CONFLICT, "Email already registered.")
    created = create_user(
        conn,
        email=body.email,
        name=body.name.strip(),
        role=body.role,
        password=body.password,
    )
    audit_module.log(
        conn, actor=user, action=audit_module.ACTION_INVITE,
        target=f"{created['name']} · {created['role']}",
        meta={"member_id": created["id"], "email": created["email"], "role": created["role"]},
    )
    return _public_user(created)


# ---- permissions matrix ---------------------------------------------------

@router.get("/permissions")
def list_permissions(
    user: dict = Depends(current_user),
    conn: sqlite3.Connection = Depends(get_db),
) -> list[dict]:
    return get_permissions_matrix(conn)


@router.patch("/permissions")
def update_permission(
    cell: PermissionToggle,
    user: dict = Depends(_require_manage),
    conn: sqlite3.Connection = Depends(get_db),
) -> list[dict]:
    """Toggle one cell of the matrix. Rolls back if it would zero out manage."""
    # Capture the previous value so we can describe the action in the log.
    prev = conn.execute(
        "SELECT allowed FROM permissions WHERE capability = ? AND role = ?",
        (cell.capability, cell.role),
    ).fetchone()
    prev_allowed = bool(prev[0]) if prev else False

    set_cell(conn, cell.capability, cell.role, cell.allowed)
    if count_manage_users(conn) < 1:
        set_cell(conn, cell.capability, cell.role, prev_allowed)
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Cannot disable: at least one role with active members must keep the 'manage' capability.",
        )

    audit_module.log(
        conn, actor=user,
        action=audit_module.ACTION_PERM_ON if cell.allowed else audit_module.ACTION_PERM_OFF,
        target=f"{cell.capability} · {cell.role}",
        meta={"capability": cell.capability, "role": cell.role, "allowed": cell.allowed},
    )
    return get_permissions_matrix(conn)


@router.post("/permissions/reset")
def reset_permissions(
    user: dict = Depends(_require_manage),
    conn: sqlite3.Connection = Depends(get_db),
) -> list[dict]:
    """Wipe overrides and restore the default matrix (spec §5.3 «Типові права»)."""
    reset_permissions_to_default(conn)
    audit_module.log(
        conn, actor=user, action=audit_module.ACTION_PERM_RESET, target="defaults",
    )
    return get_permissions_matrix(conn)


# ---- audit log ------------------------------------------------------------

@router.get("/audit")
def list_audit(
    user: dict = Depends(_require_manage),
    conn: sqlite3.Connection = Depends(get_db),
) -> list[dict]:
    return audit_module.list_audit(conn)
