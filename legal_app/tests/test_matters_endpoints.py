"""Phase 2.4 — integration tests for /api/matters with realtime ACL.

Two users (`alice`, `bob`) over the in-memory TestClient. Verifies:
- alice creates a matter → her GET /api/matters lists it; bob's doesn't.
- bob's GET /api/matters/{id} 403s.
- alice adds bob; bob now sees it AND has an unread notification.
- bob opens the case → notification clears.
- PATCH writes activity_log entries per changed field.
- status='closed' without outcome → 422; with outcome → succeeds + banner data lands.
- POST child endpoints (note, hearing) work and show up in subsequent GET.
- Calendar endpoint surfaces tasks + hearings scoped to the user.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from backend.database import get_connection, get_db, init_user_schema
from backend.main import app
from backend.models import init_entity_schema, migrate_matters, migrate_users
from backend.rbac import init_permissions_schema, seed_default_permissions


@pytest.fixture
def db_conn():
    conn = get_connection(":memory:", check_same_thread=False)
    init_user_schema(conn)
    init_entity_schema(conn)
    init_permissions_schema(conn)
    seed_default_permissions(conn)
    migrate_users(conn)
    migrate_matters(conn)
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


@pytest.fixture
def alice(client):
    r = client.post("/api/auth/register", json={
        "name": "Alice", "email": "alice@aglex.ua",
        "password": "supersecret", "role": "partner",
    })
    assert r.status_code == 201, r.text
    return {
        "auth": {"Authorization": f"Bearer {r.json()['access_token']}"},
        "id": r.json()["user"]["id"],
        "legacy_id": f"u{r.json()['user']['id']}",
    }


@pytest.fixture
def bob(client):
    r = client.post("/api/auth/register", json={
        "name": "Bob", "email": "bob@aglex.ua",
        "password": "supersecret", "role": "lawyer",
    })
    assert r.status_code == 201, r.text
    return {
        "auth": {"Authorization": f"Bearer {r.json()['access_token']}"},
        "id": r.json()["user"]["id"],
        "legacy_id": f"u{r.json()['user']['id']}",
    }


def _force_legacy(db_conn, user_id: int, legacy: str) -> None:
    """Force a known legacy_id so test assertions on member ids are stable.
    The auto-fabrication still works without this — we just want predictable
    ids for the assertions below."""
    db_conn.execute(
        "UPDATE users SET legacy_id = ? WHERE id = ?",
        (legacy, user_id),
    )
    db_conn.commit()


def test_alice_creates_matter_bob_cant_see_it(client, alice, bob, db_conn):
    _force_legacy(db_conn, alice["id"], "ua")
    _force_legacy(db_conn, bob["id"], "ub")
    r = client.post("/api/matters", json={
        "title": "Test corporate matter", "client": "Acme",
        "type": "corporate", "priority": "high",
    }, headers=alice["auth"])
    assert r.status_code == 201, r.text
    case = r.json()
    assert case["code"].startswith("COR-")
    case_id = case["id"]

    # Alice sees it.
    r = client.get("/api/matters", headers=alice["auth"])
    assert r.status_code == 200
    titles = [c["title"] for c in r.json()]
    assert "Test corporate matter" in titles

    # Bob doesn't.
    r = client.get("/api/matters", headers=bob["auth"])
    assert r.status_code == 200
    assert r.json() == []

    # And direct GET → 403.
    r = client.get(f"/api/matters/{case_id}", headers=bob["auth"])
    assert r.status_code == 403


def test_add_member_grants_visibility_and_clears_on_open(client, alice, bob, db_conn):
    _force_legacy(db_conn, alice["id"], "ua")
    _force_legacy(db_conn, bob["id"], "ub")
    r = client.post("/api/matters", json={
        "title": "Joint case", "client": "Acme", "type": "contract",
    }, headers=alice["auth"])
    case_id = r.json()["id"]

    # Alice adds bob.
    r = client.post(f"/api/matters/{case_id}/members", json={
        "user_id": "ub", "role_in_case": "collaborator",
    }, headers=alice["auth"])
    assert r.status_code == 201

    # Bob can now read the case AND has an unread notification.
    r = client.get("/api/notifications?unread=1", headers=bob["auth"])
    assert r.status_code == 200
    notifs = r.json()
    assert any(n["case_id"] == case_id and n["type"] == "member.added" for n in notifs)

    r = client.get(f"/api/matters/{case_id}", headers=bob["auth"])
    assert r.status_code == 200

    # And after opening the case, those notifications are read.
    r = client.get("/api/notifications?unread=1", headers=bob["auth"])
    assert all(n["case_id"] != case_id for n in r.json())


def test_patch_records_field_level_activity_log(client, alice, db_conn):
    _force_legacy(db_conn, alice["id"], "ua")
    r = client.post("/api/matters", json={
        "title": "Patch me", "client": "Acme", "type": "contract",
    }, headers=alice["auth"])
    case_id = r.json()["id"]

    r = client.patch(f"/api/matters/{case_id}", json={
        "title": "Renamed", "priority": "high",
    }, headers=alice["auth"])
    assert r.status_code == 200
    assert r.json()["title"] == "Renamed"
    assert r.json()["priority"] == "high"

    # Check activity_log received two rows (one per changed field).
    rows = db_conn.execute(
        "SELECT field, old_value, new_value FROM activity_log "
        "WHERE case_id = ? AND action = 'case.updated' ORDER BY field",
        (case_id,),
    ).fetchall()
    fields = {r[0] for r in rows}
    assert fields == {"title", "priority"}


def test_close_requires_outcome_and_date(client, alice, db_conn):
    _force_legacy(db_conn, alice["id"], "ua")
    r = client.post("/api/matters", json={
        "title": "To close", "client": "Acme", "type": "litigation",
    }, headers=alice["auth"])
    case_id = r.json()["id"]

    r = client.patch(f"/api/matters/{case_id}", json={"status": "closed"},
                     headers=alice["auth"])
    assert r.status_code == 422

    r = client.patch(f"/api/matters/{case_id}", json={
        "status": "closed", "outcome": "won", "closedAt": "2026-07-01",
    }, headers=alice["auth"])
    assert r.status_code == 200
    assert r.json()["status"] == "closed"
    assert r.json()["outcome"] == "won"


def test_add_note_and_hearing_show_up(client, alice, db_conn):
    _force_legacy(db_conn, alice["id"], "ua")
    r = client.post("/api/matters", json={
        "title": "With children", "client": "Acme", "type": "litigation",
    }, headers=alice["auth"])
    case_id = r.json()["id"]

    r = client.post(f"/api/matters/{case_id}/notes",
                    json={"text": "Initial briefing notes"},
                    headers=alice["auth"])
    assert r.status_code == 201

    r = client.post(f"/api/matters/{case_id}/hearings", json={
        "date": "2026-07-15", "court": "Госп. суд м. Києва", "judge": "Іванов І.І.",
    }, headers=alice["auth"])
    assert r.status_code == 201

    r = client.get(f"/api/matters/{case_id}", headers=alice["auth"])
    assert r.status_code == 200
    body = r.json()
    assert len(body["notes"]) == 1
    assert body["notes"][0]["text"] == "Initial briefing notes"
    assert len(body["hearings"]) == 1
    assert body["hearings"][0]["date"] == "2026-07-15"


def test_calendar_lists_events_only_for_member(client, alice, bob, db_conn):
    _force_legacy(db_conn, alice["id"], "ua")
    _force_legacy(db_conn, bob["id"], "ub")
    r = client.post("/api/matters", json={
        "title": "Cal test", "client": "Acme", "type": "litigation",
        "nextDeadline": "2026-07-15", "nextLabel": "Подати позов",
    }, headers=alice["auth"])
    case_id = r.json()["id"]

    client.post(f"/api/matters/{case_id}/hearings", json={
        "date": "2026-07-20", "court": "Court A",
    }, headers=alice["auth"])

    # Alice sees both events.
    r = client.get("/api/calendar/events", headers=alice["auth"])
    assert r.status_code == 200
    kinds = sorted({e["kind"] for e in r.json()})
    assert "deadline" in kinds
    assert "hearing" in kinds

    # Bob sees nothing yet.
    r = client.get("/api/calendar/events", headers=bob["auth"])
    assert r.json() == []
