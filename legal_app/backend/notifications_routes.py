"""Phase 2.4 — notifications for the bell + the "Вас додали" badge.

Notifications are queued from server-side mutations (e.g. `add_member` writes
one) and surfaced via this router. The bell in the TopBar reads from
`GET /api/notifications`; opening a matter clears all that case's unread rows
(see matters_routes.py `get_matter`).
"""
from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Depends, HTTPException, status

from .cases_acl import current_user_text_id
from .database import get_db


router = APIRouter(prefix="/api/notifications", tags=["notifications"])


@router.get("")
def list_notifications(
    unread: int = 0,
    limit: int = 50,
    user_text_id: str = Depends(current_user_text_id),
    conn: sqlite3.Connection = Depends(get_db),
) -> list[dict]:
    where = "WHERE user_id = ?"
    params: tuple = (user_text_id,)
    if unread:
        where += " AND is_read = 0"
    rows = conn.execute(
        f"SELECT id, user_id, case_id, type, message, payload, is_read, created_at "
        f"FROM notifications {where} ORDER BY created_at DESC LIMIT ?",
        params + (limit,),
    ).fetchall()
    return [
        {
            "id": r[0], "user_id": r[1], "case_id": r[2], "type": r[3],
            "message": r[4], "payload": r[5], "is_read": bool(r[6]),
            "created_at": r[7],
        }
        for r in rows
    ]


@router.post("/{notification_id}/read", status_code=status.HTTP_204_NO_CONTENT)
def mark_read(
    notification_id: str,
    user_text_id: str = Depends(current_user_text_id),
    conn: sqlite3.Connection = Depends(get_db),
) -> None:
    cur = conn.execute(
        "UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?",
        (notification_id, user_text_id),
    )
    if cur.rowcount == 0:
        # Either the row doesn't exist or belongs to someone else. Both 404
        # because we don't want to leak the existence of other users' notifs.
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Notification not found.")
    conn.commit()


@router.post("/read-all", status_code=status.HTTP_204_NO_CONTENT)
def mark_all_read(
    user_text_id: str = Depends(current_user_text_id),
    conn: sqlite3.Connection = Depends(get_db),
) -> None:
    conn.execute(
        "UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0",
        (user_text_id,),
    )
    conn.commit()
