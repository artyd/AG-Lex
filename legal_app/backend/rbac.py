"""Server-side RBAC for AG Lex.

Phase 2.3 (spec §5.2–5.3). Five roles, eight capabilities, the matrix stored
in a `permissions` table (one row per role×capability cell). The matrix is
editable from the Team module — the defaults below mirror the prototype's
`LX.permissions` so a fresh install behaves like the demo.

`require(capability)` is the only thing routes interact with. Drop it onto
any endpoint that needs gating:

    @app.post("/api/analyze", dependencies=[Depends(require("ai"))])
    def analyze(...): ...

Role comes from the JWT-validated user — never from the request body. That's
the trust boundary; everything else is bookkeeping.
"""
from __future__ import annotations

import sqlite3
from typing import Iterable

from fastapi import Depends, HTTPException, status

from .auth import current_user
from .database import get_db


# ---------------------------------------------------------------------------
# Roles, capabilities, defaults
# ---------------------------------------------------------------------------

ROLES: tuple[str, ...] = ("partner", "senior", "lawyer", "paralegal", "admin")
CAPABILITIES: tuple[str, ...] = (
    "view", "edit", "ai", "approve", "sign", "pdata", "billing", "manage",
)

# Mirrors src/data/lx.js `permissions`. Order = display order in the Team UI.
DEFAULT_PERMISSIONS: tuple[tuple[str, dict[str, bool]], ...] = (
    ("view",    {"partner": True,  "senior": True,  "lawyer": True,  "paralegal": True,  "admin": True}),
    ("edit",    {"partner": True,  "senior": True,  "lawyer": True,  "paralegal": False, "admin": False}),
    ("ai",      {"partner": True,  "senior": True,  "lawyer": True,  "paralegal": True,  "admin": False}),
    ("approve", {"partner": True,  "senior": True,  "lawyer": False, "paralegal": False, "admin": False}),
    ("sign",    {"partner": True,  "senior": False, "lawyer": False, "paralegal": False, "admin": False}),
    ("pdata",   {"partner": True,  "senior": True,  "lawyer": True,  "paralegal": False, "admin": True}),
    ("billing", {"partner": True,  "senior": False, "lawyer": False, "paralegal": False, "admin": True}),
    ("manage",  {"partner": True,  "senior": False, "lawyer": False, "paralegal": False, "admin": True}),
)

# Human-readable capability labels (Ukrainian) — surfaced to the UI via /api/team/permissions.
CAPABILITY_LABELS: dict[str, str] = {
    "view":    "Перегляд договорів",
    "edit":    "Редагування та правки",
    "ai":      "Запуск ШІ-аналізу",
    "approve": "Погодження редакції",
    "sign":    "Електронний підпис",
    "pdata":   "Доступ до персональних даних",
    "billing": "Білінг і рахунки",
    "manage":  "Керування командою",
}

# Order matters for the wire format the Team grid expects.
_CAP_ORDER = {cap: i for i, cap in enumerate(CAPABILITIES)}


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------

PERMISSIONS_SCHEMA = """
CREATE TABLE IF NOT EXISTS permissions (
    capability  TEXT NOT NULL,
    role        TEXT NOT NULL,
    allowed     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (capability, role)
);
CREATE INDEX IF NOT EXISTS idx_permissions_role ON permissions(role);
"""


def init_permissions_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(PERMISSIONS_SCHEMA)
    conn.commit()


def seed_default_permissions(conn: sqlite3.Connection) -> None:
    """Insert the default matrix if missing. Idempotent — INSERT OR IGNORE."""
    rows = []
    for capability, role_map in DEFAULT_PERMISSIONS:
        for role in ROLES:
            rows.append((capability, role, 1 if role_map.get(role) else 0))
    conn.executemany(
        "INSERT OR IGNORE INTO permissions (capability, role, allowed) VALUES (?, ?, ?)",
        rows,
    )
    conn.commit()


def reset_permissions_to_default(conn: sqlite3.Connection) -> None:
    """Used by `POST /api/team/permissions/reset` — wipes overrides."""
    conn.execute("DELETE FROM permissions")
    seed_default_permissions(conn)


# ---------------------------------------------------------------------------
# Reads
# ---------------------------------------------------------------------------

def has_capability(conn: sqlite3.Connection, role: str, capability: str) -> bool:
    row = conn.execute(
        "SELECT allowed FROM permissions WHERE role = ? AND capability = ?",
        (role, capability),
    ).fetchone()
    return bool(row[0]) if row else False


def get_permissions_matrix(conn: sqlite3.Connection) -> list[dict]:
    """Return the matrix in the wire shape the Team UI expects.

    Each row: `{key, cap, partner, senior, lawyer, paralegal, admin}` — one
    row per capability, columns for every role. Order matches CAPABILITIES.
    """
    rows = conn.execute("SELECT capability, role, allowed FROM permissions").fetchall()
    by_cap: dict[str, dict] = {}
    for capability, role, allowed in rows:
        cell = by_cap.setdefault(capability, {})
        cell[role] = bool(allowed)
    out = []
    for capability in CAPABILITIES:
        cell = by_cap.get(capability, {})
        out.append({
            "key": capability,
            "cap": CAPABILITY_LABELS[capability],
            **{role: bool(cell.get(role, False)) for role in ROLES},
        })
    return out


def count_manage_users(conn: sqlite3.Connection) -> int:
    """How many users currently hold `manage` via their role."""
    row = conn.execute("""
        SELECT COUNT(DISTINCT u.id) FROM users u
        JOIN permissions p
          ON p.role = u.role
         AND p.capability = 'manage'
         AND p.allowed = 1
    """).fetchone()
    return row[0] if row else 0


# ---------------------------------------------------------------------------
# Writes
# ---------------------------------------------------------------------------

def set_cell(conn: sqlite3.Connection, capability: str, role: str, allowed: bool) -> None:
    if capability not in CAPABILITIES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Unknown capability: {capability}")
    if role not in ROLES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Unknown role: {role}")
    conn.execute(
        "INSERT INTO permissions (capability, role, allowed) VALUES (?, ?, ?) "
        "ON CONFLICT(capability, role) DO UPDATE SET allowed = excluded.allowed",
        (capability, role, 1 if allowed else 0),
    )
    conn.commit()


# ---------------------------------------------------------------------------
# FastAPI dependency
# ---------------------------------------------------------------------------

def require(capability: str):
    """FastAPI dependency: 403 unless the current user's role grants `capability`."""
    if capability not in CAPABILITIES:
        raise ValueError(f"Unknown capability: {capability}")

    def dependency(
        user: dict = Depends(current_user),
        conn: sqlite3.Connection = Depends(get_db),
    ) -> dict:
        if not has_capability(conn, user["role"], capability):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Forbidden — your role does not have the '{capability}' capability.",
            )
        return user

    return dependency
