"""Phase 2.4 — calendar aggregator.

Single endpoint that unions tasks (due dates), case hearings, the matter
`next_deadline`, and the standalone `deadlines` table. Scoped to matters
the current user is a member of so users only see events that belong to
their workspace.

`only_mine=1` narrows further to events where the user is the assignee /
lead — useful for the agenda toggle in the Calendar view.
"""
from __future__ import annotations

import sqlite3
from typing import Optional

from fastapi import APIRouter, Depends

from .cases_acl import current_user_text_id
from .database import get_db


router = APIRouter(prefix="/api/calendar", tags=["calendar"])


@router.get("/events")
def list_events(
    from_: Optional[str] = None,
    to: Optional[str] = None,
    only_mine: int = 0,
    user_text_id: str = Depends(current_user_text_id),
    conn: sqlite3.Connection = Depends(get_db),
) -> list[dict]:
    """Tasks + hearings + matter.next_deadline, scoped to the user's cases.

    Returns: list of `{id, kind, date, title, case_id, case_code, case_title,
    assignee?, risk?}` sorted by date.

    Date filters are applied as `WHERE date BETWEEN ? AND ?` when both
    endpoints are present, else no temporal filter.
    """
    member_clause = (
        "EXISTS (SELECT 1 FROM case_members cm "
        "WHERE cm.case_id = m.id AND cm.user_id = ?)"
    )
    params_base: tuple = (user_text_id,)

    only_mine_task = "AND t.assignee = ?" if only_mine else ""
    only_mine_lead = "AND m.lead = ?" if only_mine else ""
    extra = (user_text_id,) if only_mine else ()

    date_filter_task = ""
    date_filter_hearing = ""
    date_filter_next = ""
    date_params: tuple = ()
    if from_ and to:
        date_filter_task = "AND t.due BETWEEN ? AND ?"
        date_filter_hearing = "AND h.date BETWEEN ? AND ?"
        date_filter_next = "AND m.next_deadline BETWEEN ? AND ?"
        date_params = (from_, to)

    # 1. Tasks
    rows = conn.execute(
        f"""
        SELECT t.id, 'task' AS kind, t.due AS date, t.title,
               m.id AS case_id, m.code AS case_code, m.title AS case_title,
               t.assignee, t.priority
        FROM tasks t
        JOIN matters m ON m.code = t.matter
        WHERE {member_clause} AND t.due IS NOT NULL {only_mine_task}
        {date_filter_task}
        """,
        params_base + extra + date_params,
    ).fetchall()
    out = [
        {
            "id": r[0], "kind": r[1], "date": r[2], "title": r[3],
            "case_id": r[4], "case_code": r[5], "case_title": r[6],
            "assignee": r[7], "priority": r[8],
        }
        for r in rows
    ]

    # 2. Hearings
    rows = conn.execute(
        f"""
        SELECT h.id, 'hearing' AS kind, h.date, COALESCE(h.court, 'Засідання') AS title,
               m.id AS case_id, m.code AS case_code, m.title AS case_title
        FROM case_hearings h
        JOIN matters m ON m.id = h.case_id
        WHERE {member_clause} {date_filter_hearing}
        """,
        params_base + date_params,
    ).fetchall()
    out.extend([
        {
            "id": r[0], "kind": r[1], "date": r[2], "title": r[3],
            "case_id": r[4], "case_code": r[5], "case_title": r[6],
        }
        for r in rows
    ])

    # 3. Matter next_deadline (treated as a procedural deadline)
    rows = conn.execute(
        f"""
        SELECT m.id || ':next' AS id, 'deadline' AS kind,
               m.next_deadline AS date,
               COALESCE(m.next_label, 'Найближчий строк') AS title,
               m.id AS case_id, m.code AS case_code, m.title AS case_title
        FROM matters m
        WHERE {member_clause} AND m.next_deadline IS NOT NULL
        {only_mine_lead}
        {date_filter_next}
        """,
        params_base + extra + date_params,
    ).fetchall()
    out.extend([
        {
            "id": r[0], "kind": r[1], "date": r[2], "title": r[3],
            "case_id": r[4], "case_code": r[5], "case_title": r[6],
        }
        for r in rows
    ])

    out.sort(key=lambda e: e.get("date") or "")
    return out
