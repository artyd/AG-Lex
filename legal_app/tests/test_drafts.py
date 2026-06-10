"""Fix 1 tests: personal vs team scoping on /api/drafts.

The new router lives in `backend/drafts.py`. Scoping rules under test:

  - Author always sees their personal drafts.
  - Other users do NOT see another user's personal draft (404, not 403, to
    avoid leaking existence).
  - Shared drafts are visible to all authenticated users.
  - Only the author OR a user with `manage` can edit / delete / share.
  - The Phase 3.3 legacy backfill: pre-existing rows with NULL `user_id`
    become `is_shared = 1`.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from backend.database import (
    get_connection,
    get_db,
    init_schema,
    init_user_schema,
)
from backend.main import app
from backend.models import init_entity_schema, migrate_drafts
from backend.rbac import init_permissions_schema, seed_default_permissions


# ---------------------------------------------------------------------------
# fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def db_conn():
    conn = get_connection(":memory:", check_same_thread=False)
    init_schema(conn)
    init_user_schema(conn)
    init_entity_schema(conn)
    init_permissions_schema(conn)
    seed_default_permissions(conn)
    migrate_drafts(conn)
    yield conn
    conn.close()


@pytest.fixture
def client(db_conn):
    def _override():
        yield db_conn
    app.dependency_overrides[get_db] = _override
    try:
        with TestClient(app) as c:
            yield c
    finally:
        app.dependency_overrides.pop(get_db, None)


def _register(client, *, name, email, role="partner"):
    r = client.post("/api/auth/register", json={
        "name": name, "email": email, "password": "supersecret", "role": role,
    })
    assert r.status_code == 201, r.text
    body = r.json()
    return {
        "headers": {"Authorization": f"Bearer {body['access_token']}"},
        "user": body["user"],
    }


def _create_draft(client, headers, **overrides):
    payload = {
        "typeId": "services",
        "name": "Test draft",
        "party": "Test party",
        "documentMarkdown": "# Test\n",
        "params": {"partyA": "X", "partyB": "Y"},
        "options": {"penalty": True},
        "createdAt": "2026-06-10T10:00:00",
        **overrides,
    }
    r = client.post("/api/drafts", json=payload, headers=headers)
    assert r.status_code == 201, r.text
    return r.json()


# ---------------------------------------------------------------------------
# Schema migration
# ---------------------------------------------------------------------------

def test_migrate_drafts_adds_columns_on_legacy_table():
    conn = get_connection(":memory:", check_same_thread=False)
    init_user_schema(conn)
    # Simulate the pre-Fix-1 schema.
    conn.executescript("""
        CREATE TABLE drafts (
            id TEXT PRIMARY KEY, type_id TEXT, name TEXT, party TEXT,
            document_markdown TEXT, params TEXT, options TEXT,
            created_at TEXT
        );
    """)
    conn.execute(
        "INSERT INTO drafts (id, type_id, name, document_markdown, created_at) "
        "VALUES (?, ?, ?, ?, ?)",
        ("dr-legacy", "services", "Legacy draft", "# legacy", "2026-01-01T00:00"),
    )
    conn.commit()

    migrate_drafts(conn)

    cols = {row[1] for row in conn.execute("PRAGMA table_info(drafts)").fetchall()}
    assert "user_id" in cols
    assert "is_shared" in cols
    row = conn.execute(
        "SELECT user_id, is_shared FROM drafts WHERE id = 'dr-legacy'"
    ).fetchone()
    assert row[0] is None
    assert row[1] == 1, "Legacy rows with NULL user_id must become team-shared"
    conn.close()


def test_migrate_drafts_is_idempotent(db_conn):
    # Run migrate again; nothing should change.
    cols_before = {row[1] for row in db_conn.execute("PRAGMA table_info(drafts)").fetchall()}
    migrate_drafts(db_conn)
    cols_after = {row[1] for row in db_conn.execute("PRAGMA table_info(drafts)").fetchall()}
    assert cols_before == cols_after


# ---------------------------------------------------------------------------
# Create: user_id is set from token, never from body
# ---------------------------------------------------------------------------

def test_create_stamps_user_id_from_token(client):
    partner = _register(client, name="Marina", email="m@x.com")
    created = _create_draft(client, partner["headers"])
    assert created["userId"] == partner["user"]["id"]
    assert created["isShared"] is False
    assert created["authorName"] == "Marina"


def test_create_ignores_user_id_in_body(client):
    """Even if a client tries to set userId, the server overrides from token."""
    partner = _register(client, name="Marina", email="m@x.com")
    other = _register(client, name="Bohdan", email="b@x.com")
    # Pydantic strips unknown fields → POST should ignore the userId override.
    r = client.post(
        "/api/drafts",
        json={
            "typeId": "services", "name": "x", "documentMarkdown": "x",
            "createdAt": "2026-06-10",
            "userId": other["user"]["id"],  # malicious
        },
        headers=partner["headers"],
    )
    assert r.status_code == 201
    assert r.json()["userId"] == partner["user"]["id"]


# ---------------------------------------------------------------------------
# List scoping
# ---------------------------------------------------------------------------

def test_list_returns_only_my_personal_drafts(client):
    partner = _register(client, name="Marina", email="m@x.com")
    other = _register(client, name="Bohdan", email="b@x.com")

    _create_draft(client, partner["headers"], name="Mine")
    _create_draft(client, other["headers"], name="Other")

    r = client.get("/api/drafts", headers=partner["headers"])
    assert r.status_code == 200
    names = [d["name"] for d in r.json()]
    assert names == ["Mine"]


def test_list_shows_team_shared_drafts_to_everyone(client):
    partner = _register(client, name="Marina", email="m@x.com")
    other = _register(client, name="Bohdan", email="b@x.com")

    mine = _create_draft(client, partner["headers"], name="Soon-to-be-shared")

    # Other user shouldn't see it yet.
    assert [d["name"] for d in client.get("/api/drafts", headers=other["headers"]).json()] == []

    # Share it.
    r = client.patch(f"/api/drafts/{mine['id']}/share", headers=partner["headers"])
    assert r.status_code == 200
    assert r.json()["isShared"] is True

    # Now the other user sees it.
    visible = client.get("/api/drafts", headers=other["headers"]).json()
    assert [d["name"] for d in visible] == ["Soon-to-be-shared"]
    # And the authorName is populated for them.
    assert visible[0]["authorName"] == "Marina"
    assert visible[0]["userId"] == partner["user"]["id"]


# ---------------------------------------------------------------------------
# GET single — 404 hides existence of others' personal drafts
# ---------------------------------------------------------------------------

def test_get_others_personal_draft_returns_404_not_403(client):
    partner = _register(client, name="Marina", email="m@x.com")
    other = _register(client, name="Bohdan", email="b@x.com")
    private = _create_draft(client, partner["headers"], name="Private")

    r = client.get(f"/api/drafts/{private['id']}", headers=other["headers"])
    assert r.status_code == 404, "404 (not 403) avoids leaking the row's existence"


def test_get_my_own_personal_draft_works(client):
    partner = _register(client, name="Marina", email="m@x.com")
    private = _create_draft(client, partner["headers"], name="Mine")
    r = client.get(f"/api/drafts/{private['id']}", headers=partner["headers"])
    assert r.status_code == 200
    assert r.json()["name"] == "Mine"


def test_get_shared_draft_works_for_other_user(client):
    partner = _register(client, name="Marina", email="m@x.com")
    other = _register(client, name="Bohdan", email="b@x.com")
    shared = _create_draft(client, partner["headers"], name="Shared")
    client.patch(f"/api/drafts/{shared['id']}/share", headers=partner["headers"])

    r = client.get(f"/api/drafts/{shared['id']}", headers=other["headers"])
    assert r.status_code == 200
    assert r.json()["authorName"] == "Marina"


# ---------------------------------------------------------------------------
# Share — author or `manage`
# ---------------------------------------------------------------------------

def test_share_endpoint_toggles_back_and_forth(client):
    partner = _register(client, name="Marina", email="m@x.com")
    d = _create_draft(client, partner["headers"])
    r1 = client.patch(f"/api/drafts/{d['id']}/share", headers=partner["headers"])
    assert r1.status_code == 200 and r1.json()["isShared"] is True
    r2 = client.patch(f"/api/drafts/{d['id']}/share", headers=partner["headers"])
    assert r2.status_code == 200 and r2.json()["isShared"] is False


def test_share_requires_owner_or_manage_role(client):
    partner = _register(client, name="Marina", email="m@x.com")
    # Lawyer defaults don't have `manage`.
    lawyer = _register(client, name="Bohdan", email="b@x.com", role="lawyer")
    mine = _create_draft(client, partner["headers"])

    # Lawyer trying to share someone else's draft — 403.
    r = client.patch(f"/api/drafts/{mine['id']}/share", headers=lawyer["headers"])
    assert r.status_code == 403


def test_manage_user_can_share_someone_elses_draft(client):
    p1 = _register(client, name="Marina", email="m@x.com")        # has manage
    p2 = _register(client, name="Bohdan", email="b@x.com", role="lawyer")  # no manage
    p3 = _register(client, name="Olena", email="o@x.com")          # has manage

    draft_of_p2 = _create_draft(client, p2["headers"], name="Lawyer draft")
    r = client.patch(f"/api/drafts/{draft_of_p2['id']}/share", headers=p3["headers"])
    assert r.status_code == 200
    assert r.json()["isShared"] is True


# ---------------------------------------------------------------------------
# Patch + delete: same auth rules
# ---------------------------------------------------------------------------

def test_patch_others_personal_draft_returns_403(client):
    partner = _register(client, name="Marina", email="m@x.com")
    # Share it so the second user can SEE it (404 path otherwise).
    d = _create_draft(client, partner["headers"], name="V1")
    client.patch(f"/api/drafts/{d['id']}/share", headers=partner["headers"])

    lawyer = _register(client, name="Bohdan", email="b@x.com", role="lawyer")
    r = client.patch(
        f"/api/drafts/{d['id']}",
        json={"name": "Renamed by lawyer"},
        headers=lawyer["headers"],
    )
    assert r.status_code == 403


def test_author_can_patch_own_draft(client):
    partner = _register(client, name="Marina", email="m@x.com")
    d = _create_draft(client, partner["headers"], name="V1")
    r = client.patch(
        f"/api/drafts/{d['id']}",
        json={"name": "V2"},
        headers=partner["headers"],
    )
    assert r.status_code == 200
    assert r.json()["name"] == "V2"


def test_delete_others_personal_draft_returns_403_when_visible(client):
    partner = _register(client, name="Marina", email="m@x.com")
    d = _create_draft(client, partner["headers"])
    client.patch(f"/api/drafts/{d['id']}/share", headers=partner["headers"])  # share so visible

    lawyer = _register(client, name="Bohdan", email="b@x.com", role="lawyer")
    r = client.delete(f"/api/drafts/{d['id']}", headers=lawyer["headers"])
    assert r.status_code == 403


# ---------------------------------------------------------------------------
# Cross-cutting
# ---------------------------------------------------------------------------

def test_drafts_list_requires_auth(client):
    r = client.get("/api/drafts")
    assert r.status_code == 401


def test_create_requires_auth(client):
    r = client.post("/api/drafts", json={
        "typeId": "services", "name": "x", "documentMarkdown": "x",
    })
    assert r.status_code == 401
