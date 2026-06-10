"""Audit log for RBAC + team-management actions (Phase 2.3, spec §5.3).

Append-only. Every role change, permission toggle, invite, or removal lands
here with the actor's user id + name, the canonical action code, a free-form
target string for display, and the timestamp. The Team UI tail-reads this for
the «Аудит-лог» tab.

`actor_name` is denormalized so the log survives a user being deleted.
"""
from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone


AUDIT_SCHEMA = """
CREATE TABLE IF NOT EXISTS audit (
    id          INTEGER PRIMARY KEY,
    ts          TEXT NOT NULL,
    actor_id    INTEGER,
    actor_name  TEXT NOT NULL,
    action      TEXT NOT NULL,
    target      TEXT NOT NULL DEFAULT '',
    meta        TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit(ts);
"""


# Canonical action codes. UI translates to labels via i18n (Ukrainian strings
# already live in src/data/i18n.js under actRole/actInvite/actRemove/etc.).
ACTION_ROLE_CHANGE = "role_change"
ACTION_INVITE = "invite"
ACTION_REMOVE = "remove"
ACTION_PERM_ON = "perm_on"
ACTION_PERM_OFF = "perm_off"
ACTION_PERM_RESET = "perm_reset"


def init_audit_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(AUDIT_SCHEMA)
    conn.commit()


def log(
    conn: sqlite3.Connection,
    *,
    actor: dict | None,
    action: str,
    target: str = "",
    meta: dict | None = None,
) -> dict:
    """Append one audit row. Returns the inserted row as a dict."""
    ts = datetime.now(tz=timezone.utc).isoformat()
    actor_id = actor.get("id") if actor else None
    actor_name = (actor or {}).get("name") or "Невідомий"
    meta_json = json.dumps(meta, ensure_ascii=False) if meta else None
    cur = conn.execute(
        "INSERT INTO audit (ts, actor_id, actor_name, action, target, meta) VALUES (?, ?, ?, ?, ?, ?)",
        (ts, actor_id, actor_name, action, target, meta_json),
    )
    conn.commit()
    return {
        "id": cur.lastrowid,
        "ts": ts,
        "actor_id": actor_id,
        "actor_name": actor_name,
        "action": action,
        "target": target,
        "meta": meta or {},
    }


def list_audit(conn: sqlite3.Connection, *, limit: int = 200) -> list[dict]:
    """Return audit rows newest first, capped at `limit`."""
    rows = conn.execute(
        "SELECT id, ts, actor_id, actor_name, action, target, meta "
        "FROM audit ORDER BY id DESC LIMIT ?",
        (limit,),
    ).fetchall()
    out = []
    for r in rows:
        meta = {}
        if r[6]:
            try:
                meta = json.loads(r[6])
            except json.JSONDecodeError:
                pass
        out.append({
            "id": r[0], "ts": r[1], "actor_id": r[2], "actor_name": r[3],
            "action": r[4], "target": r[5], "meta": meta,
        })
    return out
