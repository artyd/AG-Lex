"""Phase 2.4 — row-level access control for Matters.

Verifies the realtime collaboration foundations:
- `case_members` + `users.legacy_id` migrations land cleanly.
- `cases_acl.add_member` writes membership + activity_log + notification.
- `is_member` flips correctly; non-members are excluded.
- `mark_case_notifications_read` clears unread on case open.

These tests target the helper layer directly — REST endpoint tests live in
test_matters_endpoints.py (Phase 2).
"""
from __future__ import annotations

import pytest

from backend.cases_acl import (
    add_member,
    is_member,
    list_member_ids,
    mark_case_notifications_read,
    remove_member,
    resolve_user_text_id,
)
from backend.database import get_connection, init_user_schema
from backend.models import init_entity_schema, migrate_matters, migrate_users


@pytest.fixture
def conn():
    c = get_connection(":memory:", check_same_thread=False)
    init_user_schema(c)
    init_entity_schema(c)
    migrate_users(c)
    migrate_matters(c)
    yield c
    c.close()


def _make_user(conn, email: str, legacy: str) -> int:
    cur = conn.execute(
        "INSERT INTO users (email, name, role, password_hash, created_at, legacy_id) "
        "VALUES (?, ?, 'lawyer', 'x', date('now'), ?)",
        (email, email.split("@")[0], legacy),
    )
    conn.commit()
    return cur.lastrowid


def _make_matter(conn, case_id: str) -> None:
    conn.execute(
        "INSERT INTO matters (id, code, title, client, status) "
        "VALUES (?, ?, 'Test', 'Acme', 'active')",
        (case_id, case_id.upper()),
    )
    conn.commit()


def test_resolve_user_text_id_uses_legacy(conn):
    uid = _make_user(conn, "a@x.io", "u42")
    assert resolve_user_text_id(conn, uid) == "u42"


def test_resolve_user_text_id_backfills_missing(conn):
    cur = conn.execute(
        "INSERT INTO users (email, name, role, password_hash, created_at) "
        "VALUES ('b@x.io', 'b', 'lawyer', 'x', date('now'))"
    )
    conn.commit()
    uid = cur.lastrowid
    # Initially NULL legacy_id is fabricated on first lookup.
    assert resolve_user_text_id(conn, uid) == f"u{uid}"
    # Persisted — second call doesn't re-fabricate.
    assert resolve_user_text_id(conn, uid) == f"u{uid}"


def test_add_member_marks_membership_and_notifies(conn):
    a_id = _make_user(conn, "alice@x.io", "ua")
    b_id = _make_user(conn, "bob@x.io", "ub")
    _make_matter(conn, "case-1")

    # alice creates the case and adds bob.
    add_member(conn, case_id="case-1", user_text_id="ua",
               added_by_text_id="ua", role_in_case="lead")
    notif = add_member(conn, case_id="case-1", user_text_id="ub",
                       added_by_text_id="ua", role_in_case="collaborator")
    conn.commit()

    assert is_member(conn, "case-1", "ua") is True
    assert is_member(conn, "case-1", "ub") is True
    assert set(list_member_ids(conn, "case-1")) == {"ua", "ub"}

    # bob was added by someone else → notification queued for bob, not alice.
    assert notif is not None
    assert notif["user_id"] == "ub"
    assert notif["type"] == "member.added"
    assert notif["case_id"] == "case-1"
    assert notif["is_read"] == 0

    # activity_log has one row per add.
    actions = [
        r[0] for r in conn.execute(
            "SELECT action FROM activity_log WHERE case_id = 'case-1' ORDER BY created_at"
        ).fetchall()
    ]
    assert actions.count("member.added") == 2


def test_add_member_is_idempotent(conn):
    a_id = _make_user(conn, "alice@x.io", "ua")
    _make_matter(conn, "case-2")
    add_member(conn, case_id="case-2", user_text_id="ua",
               added_by_text_id="ua", role_in_case="lead")
    second = add_member(conn, case_id="case-2", user_text_id="ua",
                        added_by_text_id="ua", role_in_case="lead")
    assert second is None  # silent no-op
    rows = conn.execute(
        "SELECT COUNT(*) FROM case_members WHERE case_id='case-2'"
    ).fetchone()[0]
    assert rows == 1


def test_remove_member_cleans_up(conn):
    _make_user(conn, "alice@x.io", "ua")
    _make_user(conn, "bob@x.io", "ub")
    _make_matter(conn, "case-3")
    add_member(conn, case_id="case-3", user_text_id="ua",
               added_by_text_id="ua", role_in_case="lead")
    add_member(conn, case_id="case-3", user_text_id="ub",
               added_by_text_id="ua", role_in_case="collaborator")
    conn.commit()

    removed = remove_member(conn, case_id="case-3", user_text_id="ub",
                            removed_by_text_id="ua")
    conn.commit()
    assert removed is True
    assert is_member(conn, "case-3", "ub") is False

    # activity_log records the removal.
    actions = [
        r[0] for r in conn.execute(
            "SELECT action FROM activity_log WHERE case_id='case-3'"
        ).fetchall()
    ]
    assert "member.removed" in actions


def test_mark_case_notifications_read(conn):
    _make_user(conn, "alice@x.io", "ua")
    _make_user(conn, "bob@x.io", "ub")
    _make_matter(conn, "case-4")
    add_member(conn, case_id="case-4", user_text_id="ua",
               added_by_text_id="ua", role_in_case="lead")
    add_member(conn, case_id="case-4", user_text_id="ub",
               added_by_text_id="ua", role_in_case="collaborator")
    conn.commit()

    unread_before = conn.execute(
        "SELECT COUNT(*) FROM notifications WHERE user_id='ub' AND is_read=0"
    ).fetchone()[0]
    assert unread_before == 1

    cleared = mark_case_notifications_read(conn, case_id="case-4", user_text_id="ub")
    conn.commit()
    assert cleared == 1

    unread_after = conn.execute(
        "SELECT COUNT(*) FROM notifications WHERE user_id='ub' AND is_read=0"
    ).fetchone()[0]
    assert unread_after == 0
