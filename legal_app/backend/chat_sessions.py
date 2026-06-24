"""AI Lawyer chat — session + message persistence.

Sessions are scoped per user (FK to users.id). Messages cascade on session
delete (handled by SQLite via `ON DELETE CASCADE` — `get_connection`
guarantees `PRAGMA foreign_keys = ON`).

All endpoints are gated by `Depends(current_user)`; cross-user probing
returns 404 (NOT 403) so a hostile client can't enumerate IDs.

Title auto-derivation lives here (used by the augmented
`/api/lawyer-chat` to label a session from its first user message).
"""
from __future__ import annotations

import sqlite3
import uuid
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, Field

from .auth import current_user
from .database import get_db


router = APIRouter(prefix="/api/chat/sessions", tags=["chat"])


DEFAULT_TITLE = "Новий чат"


def derive_title(text: str, limit: int = 50) -> str:
    """First 50 chars of a user message, cut at the nearest word boundary.

    Used on the first turn of a new session to replace the default title.
    Whitespace is collapsed first so multi-line questions still produce a
    clean one-liner. Trailing punctuation is stripped before adding `…`.
    """
    collapsed = " ".join((text or "").split())
    if len(collapsed) <= limit:
        return collapsed or DEFAULT_TITLE
    cut = collapsed[:limit]
    space = cut.rfind(" ")
    # Only honour the word boundary if it's close to the end — otherwise we
    # truncate aggressively for one long word.
    if space >= limit - 10:
        cut = cut[:space]
    cut = cut.rstrip(" ,.;:—-")
    if not cut:
        return collapsed[:limit] + "…"
    return cut + "…"


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class ChatSessionOut(BaseModel):
    id: str
    title: str
    updated_at: str


class ChatSessionCreateOut(BaseModel):
    id: str
    title: str


class ChatSessionPatchIn(BaseModel):
    title: str = Field(..., min_length=1, max_length=200)


class ChatMessageOut(BaseModel):
    role: Literal["user", "assistant"]
    content: str
    created_at: str


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def assert_owns_session(conn: sqlite3.Connection, session_id: str, user_id: int) -> dict:
    """Return the session row dict or raise 404 if the user doesn't own it.

    Always 404 (NOT 403) so hostile clients can't distinguish "session
    exists but belongs to someone else" from "session never existed".
    Exported because `/api/lawyer-chat` also needs ownership-checked access
    when persisting messages into an existing session.
    """
    row = conn.execute(
        "SELECT id, title, created_at, updated_at "
        "FROM chat_sessions WHERE id = ? AND user_id = ?",
        (session_id, user_id),
    ).fetchone()
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Session not found")
    return {"id": row[0], "title": row[1], "created_at": row[2], "updated_at": row[3]}


def load_history(conn: sqlite3.Connection, session_id: str, *, limit: int) -> list[dict]:
    """Oldest-first list of {role, text} for `lawyer_chat._format_history`.

    The caller passes the desired window (`MAX_HISTORY_TURNS * 2`); we read
    the most-recent N rows and flip them back to chronological order.
    """
    rows = conn.execute(
        "SELECT role, content FROM chat_messages "
        "WHERE session_id = ? ORDER BY id DESC LIMIT ?",
        (session_id, limit),
    ).fetchall()
    rows.reverse()
    return [{"role": r[0], "text": r[1]} for r in rows]


def persist_turn(
    conn: sqlite3.Connection,
    session_id: str,
    user_message: str,
    assistant_message: str,
) -> str:
    """Insert both messages, bump updated_at, auto-title if still default.

    Returns the (possibly updated) title so the FE can refresh the
    sidebar row label without a round-trip. Single transaction.
    """
    title_after = DEFAULT_TITLE
    try:
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO chat_messages (session_id, role, content) VALUES (?, 'user', ?)",
            (session_id, user_message),
        )
        cur.execute(
            "INSERT INTO chat_messages (session_id, role, content) VALUES (?, 'assistant', ?)",
            (session_id, assistant_message),
        )
        new_title = derive_title(user_message)
        cur.execute(
            "UPDATE chat_sessions "
            "SET updated_at = datetime('now'), "
            "    title = CASE WHEN title = ? THEN ? ELSE title END "
            "WHERE id = ?",
            (DEFAULT_TITLE, new_title, session_id),
        )
        conn.commit()
        row = cur.execute(
            "SELECT title FROM chat_sessions WHERE id = ?", (session_id,),
        ).fetchone()
        if row is not None:
            title_after = row[0]
    except Exception:
        conn.rollback()
        raise
    return title_after


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("", response_model=list[ChatSessionOut])
def list_sessions(
    user: dict = Depends(current_user),
    conn: sqlite3.Connection = Depends(get_db),
) -> list[dict]:
    rows = conn.execute(
        "SELECT id, title, updated_at FROM chat_sessions "
        "WHERE user_id = ? ORDER BY updated_at DESC",
        (user["id"],),
    ).fetchall()
    return [{"id": r[0], "title": r[1], "updated_at": r[2]} for r in rows]


@router.post("", response_model=ChatSessionCreateOut, status_code=201)
def create_session(
    user: dict = Depends(current_user),
    conn: sqlite3.Connection = Depends(get_db),
) -> dict:
    new_id = uuid.uuid4().hex
    conn.execute(
        "INSERT INTO chat_sessions (id, user_id, title) VALUES (?, ?, ?)",
        (new_id, user["id"], DEFAULT_TITLE),
    )
    conn.commit()
    return {"id": new_id, "title": DEFAULT_TITLE}


@router.get("/{session_id}/messages", response_model=list[ChatMessageOut])
def list_messages(
    session_id: str,
    user: dict = Depends(current_user),
    conn: sqlite3.Connection = Depends(get_db),
) -> list[dict]:
    assert_owns_session(conn, session_id, user["id"])
    rows = conn.execute(
        "SELECT role, content, created_at FROM chat_messages "
        "WHERE session_id = ? ORDER BY id ASC",
        (session_id,),
    ).fetchall()
    return [{"role": r[0], "content": r[1], "created_at": r[2]} for r in rows]


@router.patch("/{session_id}", response_model=ChatSessionCreateOut)
def rename_session(
    session_id: str,
    body: ChatSessionPatchIn,
    user: dict = Depends(current_user),
    conn: sqlite3.Connection = Depends(get_db),
) -> dict:
    assert_owns_session(conn, session_id, user["id"])
    conn.execute(
        "UPDATE chat_sessions SET title = ?, updated_at = datetime('now') "
        "WHERE id = ?",
        (body.title, session_id),
    )
    conn.commit()
    return {"id": session_id, "title": body.title}


@router.delete("/{session_id}", status_code=204)
def delete_session(
    session_id: str,
    user: dict = Depends(current_user),
    conn: sqlite3.Connection = Depends(get_db),
) -> Response:
    assert_owns_session(conn, session_id, user["id"])
    conn.execute("DELETE FROM chat_sessions WHERE id = ?", (session_id,))
    conn.commit()
    return Response(status_code=204)
