"""Phase 2.4 — row-level access control for Matters.

`require_member(case_id)` is the FastAPI dependency every read/write on a
specific matter goes through. It resolves the authenticated user
(`current_user`), maps their auth INTEGER id to the TEXT prototype id
(`u1, u2, …`) via `users.legacy_id`, and rejects the request with 403 when
that user isn't in `case_members` for the requested case.

Helpers:
- `list_member_ids(conn, case_id)` — the broadcast fan-out target.
- `add_member` / `remove_member` — single-transaction writes that also append
  to `activity_log` and queue a `notifications` row for the affected user.
- `resolve_user_text_id(conn, user_int_id)` — the bridge between auth and
  domain identifiers; idempotently backfills `users.legacy_id` when missing.
"""
from __future__ import annotations

import datetime
import json
import sqlite3
import uuid
from typing import Iterable

from fastapi import Depends, HTTPException, Path, status

from .auth import current_user
from .database import get_db


# ---------------------------------------------------------------------------
# user_id bridge: auth INTEGER ↔ domain TEXT
# ---------------------------------------------------------------------------

def resolve_user_text_id(conn: sqlite3.Connection, user_int_id: int) -> str:
    """Return the prototype TEXT user id (`u1, u2, …`) for an auth user.

    Reads `users.legacy_id`. If NULL (a new account created post-migration
    without seed mapping), fabricates `u{user_int_id}` and persists it so
    later lookups hit the index. Idempotent.
    """
    row = conn.execute(
        "SELECT legacy_id FROM users WHERE id = ?", (user_int_id,)
    ).fetchone()
    if row is None:
        # Shouldn't happen — current_user already verified the user exists —
        # but handle defensively.
        raise HTTPException(status_code=404, detail="User no longer exists.")
    legacy_id = row[0]
    if legacy_id:
        return legacy_id
    fabricated = f"u{user_int_id}"
    conn.execute(
        "UPDATE users SET legacy_id = ? WHERE id = ? AND legacy_id IS NULL",
        (fabricated, user_int_id),
    )
    conn.commit()
    return fabricated


# ---------------------------------------------------------------------------
# membership queries
# ---------------------------------------------------------------------------

def list_member_ids(conn: sqlite3.Connection, case_id: str) -> list[str]:
    """All TEXT user_ids who can see / receive broadcasts for this case."""
    return [
        row[0]
        for row in conn.execute(
            "SELECT user_id FROM case_members WHERE case_id = ?", (case_id,)
        ).fetchall()
    ]


def is_member(conn: sqlite3.Connection, case_id: str, user_text_id: str) -> bool:
    return conn.execute(
        "SELECT 1 FROM case_members WHERE case_id = ? AND user_id = ?",
        (case_id, user_text_id),
    ).fetchone() is not None


def is_lead(conn: sqlite3.Connection, case_id: str, user_text_id: str) -> bool:
    """Lead can manage membership (add/remove other users). Partners can too,
    via the existing role check at the call site — this helper only covers
    the case-level role."""
    row = conn.execute(
        "SELECT role_in_case FROM case_members WHERE case_id = ? AND user_id = ?",
        (case_id, user_text_id),
    ).fetchone()
    return bool(row and row[0] == "lead")


# ---------------------------------------------------------------------------
# require_member dependency factory
# ---------------------------------------------------------------------------

def require_member(case_id_param: str = "case_id"):
    """Build a FastAPI dependency that 403s non-members of the case.

    Usage:
        @router.get("/api/matters/{case_id}", dependencies=[Depends(require_member())])
        def get_case(case_id: str, ...): ...

    The dependency injects nothing — it only gates. Routes that need the
    user text id can also `Depends(current_user_text_id)` below.
    """
    async def _checker(
        case_id: str = Path(..., alias=case_id_param),
        user: dict = Depends(current_user),
        conn: sqlite3.Connection = Depends(get_db),
    ) -> None:
        user_text_id = resolve_user_text_id(conn, user["id"])
        if not is_member(conn, case_id, user_text_id):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Not a member of this case.",
            )

    return _checker


def current_user_text_id(
    user: dict = Depends(current_user),
    conn: sqlite3.Connection = Depends(get_db),
) -> str:
    """Convenience dependency: gives endpoints the TEXT user id directly."""
    return resolve_user_text_id(conn, user["id"])


# ---------------------------------------------------------------------------
# membership mutations
# ---------------------------------------------------------------------------

def _now() -> str:
    return datetime.datetime.now(tz=datetime.timezone.utc).isoformat()


def add_member(
    conn: sqlite3.Connection,
    *,
    case_id: str,
    user_text_id: str,
    added_by_text_id: str,
    role_in_case: str = "collaborator",
) -> dict | None:
    """Add a user to a case + write activity_log + queue a notification.

    Returns a `notifications` row dict (or None if the user was already a
    member, which is treated as no-op). The caller is responsible for
    committing the transaction and for broadcasting the resulting events.
    """
    existing = conn.execute(
        "SELECT role_in_case FROM case_members WHERE case_id = ? AND user_id = ?",
        (case_id, user_text_id),
    ).fetchone()
    if existing:
        return None  # already a member — silent no-op
    ts = _now()
    conn.execute(
        "INSERT INTO case_members (case_id, user_id, role_in_case, added_at, added_by) "
        "VALUES (?, ?, ?, ?, ?)",
        (case_id, user_text_id, role_in_case, ts, added_by_text_id),
    )
    log_id = uuid.uuid4().hex
    conn.execute(
        "INSERT INTO activity_log (id, case_id, user_id, action, field, old_value, new_value, created_at) "
        "VALUES (?, ?, ?, 'member.added', NULL, NULL, ?, ?)",
        (log_id, case_id, added_by_text_id, user_text_id, ts),
    )
    # Don't notify users about themselves (e.g. case creator).
    if user_text_id == added_by_text_id:
        return None
    notif_id = uuid.uuid4().hex
    payload = json.dumps({"role_in_case": role_in_case, "added_by": added_by_text_id})
    conn.execute(
        "INSERT INTO notifications (id, user_id, case_id, type, message, payload, is_read, created_at) "
        "VALUES (?, ?, ?, 'member.added', ?, ?, 0, ?)",
        (notif_id, user_text_id, case_id, "Вас додали до справи", payload, ts),
    )
    return {
        "id": notif_id,
        "user_id": user_text_id,
        "case_id": case_id,
        "type": "member.added",
        "message": "Вас додали до справи",
        "payload": payload,
        "is_read": 0,
        "created_at": ts,
    }


def remove_member(
    conn: sqlite3.Connection,
    *,
    case_id: str,
    user_text_id: str,
    removed_by_text_id: str,
) -> bool:
    """Remove a user from a case + write activity_log. Returns True if a row
    was removed."""
    deleted = conn.execute(
        "DELETE FROM case_members WHERE case_id = ? AND user_id = ?",
        (case_id, user_text_id),
    ).rowcount
    if not deleted:
        return False
    log_id = uuid.uuid4().hex
    conn.execute(
        "INSERT INTO activity_log (id, case_id, user_id, action, field, old_value, new_value, created_at) "
        "VALUES (?, ?, ?, 'member.removed', NULL, ?, NULL, ?)",
        (log_id, case_id, removed_by_text_id, user_text_id, _now()),
    )
    return True


def mark_case_notifications_read(
    conn: sqlite3.Connection,
    *,
    case_id: str,
    user_text_id: str,
) -> int:
    """When a user opens a case, all their unread notifications about it
    clear at once. Returns the number of rows updated."""
    return conn.execute(
        "UPDATE notifications SET is_read = 1 "
        "WHERE user_id = ? AND case_id = ? AND is_read = 0",
        (user_text_id, case_id),
    ).rowcount


def log_field_change(
    conn: sqlite3.Connection,
    *,
    case_id: str,
    user_text_id: str,
    field: str,
    old_value: str | None,
    new_value: str | None,
) -> str:
    """One row per changed field — the activity_log is the audit trail."""
    log_id = uuid.uuid4().hex
    conn.execute(
        "INSERT INTO activity_log (id, case_id, user_id, action, field, old_value, new_value, created_at) "
        "VALUES (?, ?, ?, 'case.updated', ?, ?, ?, ?)",
        (log_id, case_id, user_text_id, field, old_value, new_value, _now()),
    )
    return log_id
