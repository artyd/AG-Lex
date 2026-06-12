"""Phase 2.4 — custom router for /api/matters with row-level access control.

Replaces the generic CRUD router built by `build_router(MATTERS)`. Every
endpoint here goes through one of two dependencies:

- `current_user_text_id` — resolves the TEXT user id (`u1, u2, …`) the rest
  of the domain uses.
- `require_member("case_id")` — 403s when the authenticated user isn't in
  `case_members` for the case in the URL.

PATCH is field-level: each changed column writes a row to `activity_log` so
the matter timeline is the audit trail. Child endpoints
(`POST /api/matters/{id}/{notes|hearings|parties|tasks|time-entries}`) write
the child + an `activity_log` row + (Phase 3) broadcast to other members.

Code generation: `{TYPE_PREFIX}-{YEAR}-{NN}` where the NN bumps over the max
NN already taken by that prefix+year. SQLite `UNIQUE` on `matters.code`
plus a retry loop guards the race when two clients create matters of the
same type in the same second.
"""
from __future__ import annotations

import datetime
import json
import sqlite3
import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from .auth import current_user
from .cases_acl import (
    add_member as acl_add_member,
    current_user_text_id,
    list_member_ids,
    log_field_change,
    mark_case_notifications_read,
    remove_member as acl_remove_member,
    resolve_user_text_id,
)
from .database import get_db
from .realtime import schedule_broadcast, schedule_notify


router = APIRouter(prefix="/api/matters", tags=["matters"])


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def _now() -> str:
    return datetime.datetime.now(tz=datetime.timezone.utc).isoformat()


TYPE_PREFIX = {
    "corporate": "COR",
    "contract": "DOG",
    "ip": "IPS",
    "litigation": "LIT",
    "labor": "LAB",
    "family": "FAM",
    "inheritance": "HER",
    "other": "GEN",
    # legacy Ukrainian-text types from seed data — keep generating sensible
    # codes even if the frontend forgets to switch.
    "Корпоративне": "COR",
    "Договірне": "DOG",
    "IP / IT": "IPS",
    "Судовий спір": "LIT",
}


def _generate_code(conn: sqlite3.Connection, matter_type: str) -> str:
    prefix = TYPE_PREFIX.get(matter_type, "GEN")
    year = datetime.date.today().year
    row = conn.execute(
        "SELECT code FROM matters WHERE code LIKE ? ORDER BY code DESC LIMIT 1",
        (f"{prefix}-{year}-%",),
    ).fetchone()
    last = 0
    if row:
        try:
            last = int(row[0].split("-")[-1])
        except (ValueError, IndexError):
            last = 0
    return f"{prefix}-{year}-{str(last + 1).zfill(2)}"


# Columns the PATCH endpoint can touch. Anything else in the body is silently
# dropped — frontend ships rich objects, we keep only what we own.
PATCHABLE_COLUMNS = {
    "title", "client", "type", "status", "lead", "priority",
    "summary", "description", "opponent", "court", "judge",
    "next_deadline", "next_label", "outcome", "closed_at",
    "docs", "open_tasks", "hours",
}

# Wire→DB key translation (matches MATTERS.column_aliases but local to this
# module so we don't import the Entity machinery).
_WIRE_TO_DB = {
    "openTasks": "open_tasks",
    "nextDeadline": "next_deadline",
    "nextLabel": "next_label",
    "startedAt": "started_at",
    "closedAt": "closed_at",
    "updatedAt": "updated_at",
}

# Wire shape — what the frontend sees. PATCH bodies use the camelCase shape.
_DB_TO_WIRE = {v: k for k, v in _WIRE_TO_DB.items()}


def _row_to_card(row: sqlite3.Row | tuple) -> dict:
    """Trim shape for the list endpoint: just what MatterCard renders."""
    keys = (
        "id", "code", "title", "client", "type", "status", "priority",
        "lead", "docs", "open_tasks", "hours", "color",
        "next_deadline", "next_label", "updated_at",
    )
    d = {k: row[i] for i, k in enumerate(keys)}
    return {_DB_TO_WIRE.get(k, k): v for k, v in d.items()}


# ---------------------------------------------------------------------------
# request models
# ---------------------------------------------------------------------------

class MemberRef(BaseModel):
    user_id: str = Field(..., min_length=1, max_length=64)
    role_in_case: str = Field(default="collaborator", max_length=32)


class CaseCreate(BaseModel):
    title: str = Field(..., min_length=1, max_length=240)
    client: str = Field(..., min_length=1, max_length=240)
    type: str = Field(default="other", max_length=64)
    lead: Optional[str] = None
    priority: Optional[str] = Field(default="med", max_length=16)
    status: Optional[str] = Field(default="new", max_length=32)
    description: Optional[str] = None
    summary: Optional[str] = None
    next_deadline: Optional[str] = Field(default=None, alias="nextDeadline")
    next_label: Optional[str] = Field(default=None, alias="nextLabel")
    started_at: Optional[str] = Field(default=None, alias="startedAt")
    team: list[str] = Field(default_factory=list)

    model_config = {"populate_by_name": True}


class CasePatch(BaseModel):
    # Permissive: PATCH accepts any subset of patchable columns. Validated
    # at the route level against PATCHABLE_COLUMNS.
    title: Optional[str] = None
    client: Optional[str] = None
    type: Optional[str] = None
    status: Optional[str] = None
    lead: Optional[str] = None
    priority: Optional[str] = None
    summary: Optional[str] = None
    description: Optional[str] = None
    opponent: Optional[str] = None
    court: Optional[str] = None
    judge: Optional[str] = None
    outcome: Optional[str] = None
    next_deadline: Optional[str] = Field(default=None, alias="nextDeadline")
    next_label: Optional[str] = Field(default=None, alias="nextLabel")
    closed_at: Optional[str] = Field(default=None, alias="closedAt")
    docs: Optional[int] = None
    open_tasks: Optional[int] = Field(default=None, alias="openTasks")
    hours: Optional[float] = None

    model_config = {"populate_by_name": True}


class NoteCreate(BaseModel):
    text: str = Field(..., min_length=1, max_length=4000)


class HearingCreate(BaseModel):
    date: str = Field(..., min_length=4, max_length=20)
    court: Optional[str] = None
    judge: Optional[str] = None
    location: Optional[str] = None
    outcome: Optional[str] = None
    notes: Optional[str] = None


class PartyCreate(BaseModel):
    role: str = Field(..., max_length=32)
    name: str = Field(..., min_length=1, max_length=240)
    contact: Optional[str] = None
    notes: Optional[str] = None


class TaskCreate(BaseModel):
    title: str = Field(..., min_length=1, max_length=400)
    assignee: Optional[str] = None
    due: Optional[str] = None
    priority: Optional[str] = "med"
    col: Optional[str] = "todo"


class TimeEntryCreate(BaseModel):
    date: Optional[str] = None
    who: Optional[str] = None
    descr: Optional[str] = Field(default=None, alias="desc")
    hours: float = Field(..., ge=0)
    rate: float = Field(default=0, ge=0)
    billable: int = 1

    model_config = {"populate_by_name": True}


# ---------------------------------------------------------------------------
# list & detail
# ---------------------------------------------------------------------------

def _require_member(
    case_id: str,
    conn: sqlite3.Connection = Depends(get_db),
    user_text_id: str = Depends(current_user_text_id),
) -> str:
    """Inline membership check returning the user_text_id so handlers
    don't have to declare both dependencies."""
    is_m = conn.execute(
        "SELECT 1 FROM case_members WHERE case_id = ? AND user_id = ?",
        (case_id, user_text_id),
    ).fetchone()
    if not is_m:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Not a member of this case.",
        )
    return user_text_id


@router.get("")
def list_matters(
    user: dict = Depends(current_user),
    conn: sqlite3.Connection = Depends(get_db),
) -> list[dict]:
    """Only matters where the current user is in `case_members`."""
    user_text_id = resolve_user_text_id(conn, user["id"])
    rows = conn.execute(
        """
        SELECT m.id, m.code, m.title, m.client, m.type, m.status, m.priority,
               m.lead, m.docs, m.open_tasks, m.hours, m.color,
               m.next_deadline, m.next_label, m.updated_at
        FROM matters m
        JOIN case_members cm ON cm.case_id = m.id
        WHERE cm.user_id = ?
        ORDER BY COALESCE(m.updated_at, m.started_at) DESC
        """,
        (user_text_id,),
    ).fetchall()
    return [_row_to_card(r) for r in rows]


def _hydrate_case(conn: sqlite3.Connection, case_id: str) -> dict | None:
    """Fully hydrated case: row + members + parties + notes + hearings +
    activity_log timeline."""
    row = conn.execute(
        """
        SELECT id, code, title, client, type, status, lead, docs, open_tasks,
               hours, color, summary, priority, opponent, court, judge,
               outcome, next_deadline, next_label, description, started_at,
               closed_at, updated_at
        FROM matters WHERE id = ?
        """,
        (case_id,),
    ).fetchone()
    if not row:
        return None
    keys = (
        "id", "code", "title", "client", "type", "status", "lead", "docs",
        "open_tasks", "hours", "color", "summary", "priority", "opponent",
        "court", "judge", "outcome", "next_deadline", "next_label",
        "description", "started_at", "closed_at", "updated_at",
    )
    case = {k: row[i] for i, k in enumerate(keys)}
    # Translate to wire shape
    case = {_DB_TO_WIRE.get(k, k): v for k, v in case.items()}

    members = [
        {
            "user_id": r[0],
            "role_in_case": r[1],
            "name": r[2],
            "email": r[3],
            "added_at": r[4],
        }
        for r in conn.execute(
            """
            SELECT cm.user_id, cm.role_in_case, u.name, u.email, cm.added_at
            FROM case_members cm
            LEFT JOIN users u ON u.legacy_id = cm.user_id
            WHERE cm.case_id = ?
            ORDER BY cm.added_at
            """,
            (case_id,),
        ).fetchall()
    ]

    parties = [
        {"id": r[0], "role": r[1], "name": r[2], "contact": r[3], "notes": r[4]}
        for r in conn.execute(
            "SELECT id, role, name, contact, notes FROM case_parties WHERE case_id = ?",
            (case_id,),
        ).fetchall()
    ]

    notes = [
        {"id": r[0], "author_id": r[1], "text": r[2], "created_at": r[3]}
        for r in conn.execute(
            "SELECT id, author_id, text, created_at FROM case_notes "
            "WHERE case_id = ? ORDER BY created_at DESC LIMIT 50",
            (case_id,),
        ).fetchall()
    ]

    hearings = [
        {
            "id": r[0], "date": r[1], "court": r[2], "judge": r[3],
            "location": r[4], "outcome": r[5], "notes": r[6],
            "created_at": r[7],
        }
        for r in conn.execute(
            "SELECT id, date, court, judge, location, outcome, notes, created_at "
            "FROM case_hearings WHERE case_id = ? ORDER BY date",
            (case_id,),
        ).fetchall()
    ]

    timeline = [
        {
            "id": r[0], "user_id": r[1], "action": r[2], "field": r[3],
            "old_value": r[4], "new_value": r[5], "created_at": r[6],
        }
        for r in conn.execute(
            "SELECT id, user_id, action, field, old_value, new_value, created_at "
            "FROM activity_log WHERE case_id = ? ORDER BY created_at DESC LIMIT 100",
            (case_id,),
        ).fetchall()
    ]

    case["members"] = members
    case["parties"] = parties
    case["notes"] = notes
    case["hearings"] = hearings
    case["timeline"] = timeline
    return case


@router.get("/{case_id}")
def get_matter(
    case_id: str,
    user_text_id: str = Depends(_require_member),
    conn: sqlite3.Connection = Depends(get_db),
) -> dict:
    case = _hydrate_case(conn, case_id)
    if not case:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Case not found.")
    # Side effect: opening the case clears all unread notifications about it.
    mark_case_notifications_read(conn, case_id=case_id, user_text_id=user_text_id)
    conn.commit()
    return case


# ---------------------------------------------------------------------------
# create
# ---------------------------------------------------------------------------

@router.post("", status_code=status.HTTP_201_CREATED)
def create_matter(
    body: CaseCreate,
    user: dict = Depends(current_user),
    conn: sqlite3.Connection = Depends(get_db),
) -> dict:
    user_text_id = resolve_user_text_id(conn, user["id"])
    # Code generation with retry-on-race. SQLite UNIQUE on matters.code can
    # fire if two POSTs land in the same second; loop bumps the suffix.
    case_id = "m-" + uuid.uuid4().hex[:8]
    last_err: Exception | None = None
    for _ in range(5):
        code = _generate_code(conn, body.type)
        try:
            conn.execute(
                """
                INSERT INTO matters (id, code, title, client, type, status, lead,
                                     docs, open_tasks, hours, color, priority,
                                     description, summary, next_deadline,
                                     next_label, started_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    case_id, code, body.title, body.client, body.type,
                    body.status or "new", body.lead or user_text_id,
                    body.priority or "med", body.description, body.summary,
                    body.next_deadline, body.next_label,
                    body.started_at or datetime.date.today().isoformat(),
                    _now(),
                ),
            )
            break
        except sqlite3.IntegrityError as e:
            last_err = e
            continue
    else:
        raise HTTPException(status.HTTP_409_CONFLICT, f"Could not allocate matter code: {last_err}")

    # Membership: creator (as lead) + every team member as collaborator. The
    # add_member helper writes activity_log + queues notifications (except
    # for the creator themselves).
    acl_add_member(conn, case_id=case_id, user_text_id=user_text_id,
                   added_by_text_id=user_text_id, role_in_case="lead")
    notifications: list[dict] = []
    for member_text_id in dict.fromkeys(body.team):  # dedupe, preserve order
        if member_text_id == user_text_id:
            continue
        notif = acl_add_member(
            conn, case_id=case_id, user_text_id=member_text_id,
            added_by_text_id=user_text_id, role_in_case="collaborator",
        )
        if notif is not None:
            notifications.append(notif)
    # "case.created" log row for the matter timeline.
    log_id = uuid.uuid4().hex
    conn.execute(
        "INSERT INTO activity_log (id, case_id, user_id, action, field, "
        "old_value, new_value, created_at) "
        "VALUES (?, ?, ?, 'case.created', NULL, NULL, ?, ?)",
        (log_id, case_id, user_text_id, body.title, _now()),
    )
    conn.commit()

    # Realtime fan-out: every member sees the new case appear in their list;
    # the added collaborators also get a `notification.new` (the helper queued
    # a notifications row already).
    schedule_broadcast(conn, case_id=case_id, type_="case.created",
                       actor_id=user_text_id,
                       data={"title": body.title, "code": code})
    for notif in notifications:
        schedule_notify(
            user_text_id=notif["user_id"], type_="notification.new",
            case_id=case_id, data=notif,
        )
    return _hydrate_case(conn, case_id)


# ---------------------------------------------------------------------------
# patch
# ---------------------------------------------------------------------------

@router.patch("/{case_id}")
def patch_matter(
    case_id: str,
    body: CasePatch,
    user_text_id: str = Depends(_require_member),
    conn: sqlite3.Connection = Depends(get_db),
) -> dict:
    # Collect only set fields (PATCH semantics — only what the client sent).
    patch_dict = body.model_dump(exclude_unset=True, by_alias=False)

    # status → closed requires both outcome and closed_at in the same body.
    if patch_dict.get("status") == "closed":
        if not patch_dict.get("outcome") or not patch_dict.get("closed_at"):
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Closing a case requires `outcome` and `closed_at` in the same PATCH.",
            )

    # Load current row to compute the field-level diff.
    current = conn.execute(
        "SELECT id, title, client, type, status, lead, priority, summary, "
        "description, opponent, court, judge, outcome, next_deadline, "
        "next_label, closed_at, docs, open_tasks, hours FROM matters "
        "WHERE id = ?",
        (case_id,),
    ).fetchone()
    if not current:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Case not found.")
    cur_keys = (
        "id", "title", "client", "type", "status", "lead", "priority",
        "summary", "description", "opponent", "court", "judge", "outcome",
        "next_deadline", "next_label", "closed_at", "docs", "open_tasks",
        "hours",
    )
    cur_row = {k: current[i] for i, k in enumerate(cur_keys)}

    # Filter to columns we allow and have actually changed.
    changes: dict[str, tuple[object, object]] = {}
    for k, new_val in patch_dict.items():
        if k not in PATCHABLE_COLUMNS:
            continue
        old_val = cur_row.get(k)
        if (old_val or "") == (new_val or ""):
            continue
        changes[k] = (old_val, new_val)

    if not changes:
        return _hydrate_case(conn, case_id)

    # Single UPDATE for all changes + per-field activity_log rows.
    set_clause = ", ".join(f"{k} = ?" for k in changes) + ", updated_at = ?"
    params = tuple(new for _, new in changes.values()) + (_now(), case_id)
    conn.execute(f"UPDATE matters SET {set_clause} WHERE id = ?", params)
    for field, (old_val, new_val) in changes.items():
        log_field_change(
            conn, case_id=case_id, user_text_id=user_text_id,
            field=field,
            old_value=None if old_val is None else str(old_val),
            new_value=None if new_val is None else str(new_val),
        )
    conn.commit()
    # Broadcast the diff so every open detail tab updates without reload.
    schedule_broadcast(conn, case_id=case_id, type_="case.updated",
                       actor_id=user_text_id,
                       data={"fields": {k: v[1] for k, v in changes.items()}})
    return _hydrate_case(conn, case_id)


# ---------------------------------------------------------------------------
# members
# ---------------------------------------------------------------------------

@router.post("/{case_id}/members", status_code=status.HTTP_201_CREATED)
def add_member_route(
    case_id: str,
    body: MemberRef,
    user_text_id: str = Depends(_require_member),
    conn: sqlite3.Connection = Depends(get_db),
) -> dict:
    notif = acl_add_member(
        conn, case_id=case_id, user_text_id=body.user_id,
        added_by_text_id=user_text_id, role_in_case=body.role_in_case,
    )
    conn.commit()
    schedule_broadcast(conn, case_id=case_id, type_="member.added",
                       actor_id=user_text_id,
                       data={"user_id": body.user_id,
                             "role_in_case": body.role_in_case})
    if notif is not None:
        schedule_notify(user_text_id=notif["user_id"], type_="notification.new",
                        case_id=case_id, data=notif)
    return {"ok": True, "user_id": body.user_id, "notification": notif}


@router.delete("/{case_id}/members/{member_user_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_member_route(
    case_id: str,
    member_user_id: str,
    user_text_id: str = Depends(_require_member),
    conn: sqlite3.Connection = Depends(get_db),
) -> None:
    acl_remove_member(
        conn, case_id=case_id, user_text_id=member_user_id,
        removed_by_text_id=user_text_id,
    )
    conn.commit()
    # Broadcast BEFORE the user actually drops off the room — they should
    # see a "you were removed" event in their open tab. Members list is
    # looked up at broadcast time and naturally excludes them after commit.
    schedule_broadcast(conn, case_id=case_id, type_="member.removed",
                       actor_id=user_text_id,
                       data={"user_id": member_user_id})
    schedule_notify(user_text_id=member_user_id, type_="member.removed",
                    case_id=case_id,
                    data={"by": user_text_id})


# ---------------------------------------------------------------------------
# child rows: notes / hearings / parties / tasks / time entries
# ---------------------------------------------------------------------------

@router.post("/{case_id}/notes", status_code=status.HTTP_201_CREATED)
def add_note(
    case_id: str,
    body: NoteCreate,
    user_text_id: str = Depends(_require_member),
    conn: sqlite3.Connection = Depends(get_db),
) -> dict:
    note_id = uuid.uuid4().hex
    ts = _now()
    conn.execute(
        "INSERT INTO case_notes (id, case_id, author_id, text, created_at) "
        "VALUES (?, ?, ?, ?, ?)",
        (note_id, case_id, user_text_id, body.text, ts),
    )
    log_field_change(conn, case_id=case_id, user_text_id=user_text_id,
                     field="note", old_value=None, new_value=body.text[:120])
    conn.commit()
    note_row = {"id": note_id, "case_id": case_id, "author_id": user_text_id,
                "text": body.text, "created_at": ts}
    schedule_broadcast(conn, case_id=case_id, type_="note.added",
                       actor_id=user_text_id, data=note_row)
    return note_row


@router.post("/{case_id}/hearings", status_code=status.HTTP_201_CREATED)
def add_hearing(
    case_id: str,
    body: HearingCreate,
    user_text_id: str = Depends(_require_member),
    conn: sqlite3.Connection = Depends(get_db),
) -> dict:
    hid = uuid.uuid4().hex
    ts = _now()
    conn.execute(
        "INSERT INTO case_hearings (id, case_id, date, court, judge, "
        "location, outcome, notes, created_at, created_by) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (hid, case_id, body.date, body.court, body.judge, body.location,
         body.outcome, body.notes, ts, user_text_id),
    )
    log_field_change(conn, case_id=case_id, user_text_id=user_text_id,
                     field="hearing", old_value=None,
                     new_value=f"{body.date}: {body.court or ''}".strip())
    conn.commit()
    row = {"id": hid, "case_id": case_id, **body.model_dump(),
           "created_at": ts, "created_by": user_text_id}
    schedule_broadcast(conn, case_id=case_id, type_="hearing.added",
                       actor_id=user_text_id, data=row)
    return row


@router.post("/{case_id}/parties", status_code=status.HTTP_201_CREATED)
def add_party(
    case_id: str,
    body: PartyCreate,
    user_text_id: str = Depends(_require_member),
    conn: sqlite3.Connection = Depends(get_db),
) -> dict:
    pid = uuid.uuid4().hex
    conn.execute(
        "INSERT INTO case_parties (id, case_id, role, name, contact, notes) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (pid, case_id, body.role, body.name, body.contact, body.notes),
    )
    log_field_change(conn, case_id=case_id, user_text_id=user_text_id,
                     field="party", old_value=None,
                     new_value=f"{body.role}: {body.name}")
    conn.commit()
    row = {"id": pid, "case_id": case_id, **body.model_dump()}
    schedule_broadcast(conn, case_id=case_id, type_="party.added",
                       actor_id=user_text_id, data=row)
    return row


@router.post("/{case_id}/tasks", status_code=status.HTTP_201_CREATED)
def add_task(
    case_id: str,
    body: TaskCreate,
    user_text_id: str = Depends(_require_member),
    conn: sqlite3.Connection = Depends(get_db),
) -> dict:
    """Add a task linked to this case. Reuses the existing `tasks` table —
    the `matter` column holds the matter code (legacy), and the id prefix
    `tk-` lets the existing tasks router find this row too."""
    code_row = conn.execute(
        "SELECT code FROM matters WHERE id = ?", (case_id,)
    ).fetchone()
    if not code_row:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Case not found.")
    tid = "tk-" + uuid.uuid4().hex[:8]
    conn.execute(
        "INSERT INTO tasks (id, title, matter, assignee, due, priority, col) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (tid, body.title, code_row[0], body.assignee, body.due,
         body.priority or "med", body.col or "todo"),
    )
    log_field_change(conn, case_id=case_id, user_text_id=user_text_id,
                     field="task", old_value=None, new_value=body.title[:120])
    conn.commit()
    row = {"id": tid, "case_id": case_id, "matter": code_row[0],
           **body.model_dump()}
    schedule_broadcast(conn, case_id=case_id, type_="task.added",
                       actor_id=user_text_id, data=row)
    return row


@router.post("/{case_id}/time-entries", status_code=status.HTTP_201_CREATED)
def add_time_entry(
    case_id: str,
    body: TimeEntryCreate,
    user_text_id: str = Depends(_require_member),
    conn: sqlite3.Connection = Depends(get_db),
) -> dict:
    code_row = conn.execute(
        "SELECT code FROM matters WHERE id = ?", (case_id,)
    ).fetchone()
    if not code_row:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Case not found.")
    teid = "te-" + uuid.uuid4().hex[:8]
    conn.execute(
        "INSERT INTO time_entries (id, date, matter, who, descr, hours, "
        "rate, billable) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (teid, body.date or datetime.date.today().isoformat(), code_row[0],
         body.who or user_text_id, body.descr, body.hours, body.rate,
         body.billable),
    )
    log_field_change(conn, case_id=case_id, user_text_id=user_text_id,
                     field="time", old_value=None,
                     new_value=f"{body.hours}h: {body.descr or ''}"[:120])
    conn.commit()
    row = {"id": teid, "matter": code_row[0], **body.model_dump()}
    schedule_broadcast(conn, case_id=case_id, type_="time.added",
                       actor_id=user_text_id, data=row)
    return row
