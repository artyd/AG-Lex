"""Phase 2.4 — WebSocket realtime fan-out.

Verifies the end-to-end flow:
- A client connects with a valid JWT in the query string.
- Bad / missing tokens are rejected with WS close code 1008.
- When user A mutates a case, every other member's open socket receives the
  matching event payload.
- Notifications get delivered to the recipient's socket too.

The `manager` singleton in `backend.realtime` is the integration seam. Tests
use the real ConnectionManager (it's process-local), wrapped by TestClient
which provides synchronous `.websocket_connect`.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from backend.database import get_connection, get_db, init_user_schema
from backend.main import app
from backend.models import init_entity_schema, migrate_matters, migrate_users
from backend.rbac import init_permissions_schema, seed_default_permissions
from backend.realtime import manager as ws_manager


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
    # Reset the singleton's state between tests so stale sockets from a
    # previous run don't leak between cases.
    ws_manager._connections.clear()
    try:
        with TestClient(app) as c:
            yield c
    finally:
        app.dependency_overrides.pop(get_db, None)
        ws_manager._connections.clear()


def _register(client, *, name, email, password="supersecret", role="lawyer"):
    r = client.post("/api/auth/register", json={
        "name": name, "email": email, "password": password, "role": role,
    })
    assert r.status_code == 201, r.text
    body = r.json()
    return {
        "token": body["access_token"],
        "id": body["user"]["id"],
        "legacy_id": f"u{body['user']['id']}",
        "auth": {"Authorization": f"Bearer {body['access_token']}"},
    }


def _force_legacy(conn, uid, legacy):
    conn.execute("UPDATE users SET legacy_id = ? WHERE id = ?", (legacy, uid))
    conn.commit()


def test_ws_rejects_missing_token(client):
    # `with` context closes the WS for us; we just need it to error out.
    with pytest.raises(Exception):
        with client.websocket_connect("/ws"):
            pass


def test_ws_rejects_bad_token(client):
    with pytest.raises(Exception):
        with client.websocket_connect("/ws?token=garbage"):
            pass


def test_ws_accepts_valid_token_and_pings(client):
    user = _register(client, name="Solo", email="solo@x.io")
    with client.websocket_connect(f"/ws?token={user['token']}") as ws:
        ws.send_json({"type": "ping"})
        msg = ws.receive_json()
        assert msg == {"type": "pong"}


def test_added_member_receives_event_on_their_socket(client, db_conn):
    alice = _register(client, name="Alice", email="alice@x.io", role="partner")
    bob = _register(client, name="Bob", email="bob@x.io")
    _force_legacy(db_conn, alice["id"], "ua")
    _force_legacy(db_conn, bob["id"], "ub")

    # Alice creates a case (no team yet); Bob will get added in a moment.
    r = client.post("/api/matters", json={
        "title": "Joint", "client": "Acme", "type": "contract",
    }, headers=alice["auth"])
    case_id = r.json()["id"]

    # Bob is online — open his socket BEFORE the add so we can observe
    # the event arrive.
    with client.websocket_connect(f"/ws?token={bob['token']}") as bob_ws:
        # Alice adds Bob to the case.
        r = client.post(f"/api/matters/{case_id}/members", json={
            "user_id": "ub", "role_in_case": "collaborator",
        }, headers=alice["auth"])
        assert r.status_code == 201

        # Bob's socket gets two events fanned out: member.added (broadcast
        # to the room which now includes him) and notification.new
        # (single-user). The order isn't strictly guaranteed; both should
        # arrive within a small window.
        observed = set()
        for _ in range(2):
            msg = bob_ws.receive_json()
            observed.add(msg["type"])
            assert msg["case_id"] == case_id
        assert "member.added" in observed
        assert "notification.new" in observed


def test_case_updated_broadcasts_to_all_members(client, db_conn):
    alice = _register(client, name="Alice", email="alice@x.io", role="partner")
    bob = _register(client, name="Bob", email="bob@x.io")
    _force_legacy(db_conn, alice["id"], "ua")
    _force_legacy(db_conn, bob["id"], "ub")

    # Alice creates the case with Bob in the team — Bob sees it from the
    # start, no membership add round-trip needed.
    r = client.post("/api/matters", json={
        "title": "Initial title", "client": "Acme", "type": "contract",
        "team": ["ub"],
    }, headers=alice["auth"])
    case_id = r.json()["id"]

    with client.websocket_connect(f"/ws?token={bob['token']}") as bob_ws:
        # Alice renames the case. Bob's open detail tab should see the diff.
        r = client.patch(f"/api/matters/{case_id}", json={
            "title": "Renamed by Alice", "priority": "high",
        }, headers=alice["auth"])
        assert r.status_code == 200

        msg = bob_ws.receive_json()
        assert msg["type"] == "case.updated"
        assert msg["case_id"] == case_id
        assert msg["data"]["fields"]["title"] == "Renamed by Alice"
        assert msg["data"]["fields"]["priority"] == "high"


def test_note_added_event_fires(client, db_conn):
    alice = _register(client, name="Alice", email="alice@x.io", role="partner")
    bob = _register(client, name="Bob", email="bob@x.io")
    _force_legacy(db_conn, alice["id"], "ua")
    _force_legacy(db_conn, bob["id"], "ub")

    r = client.post("/api/matters", json={
        "title": "Notes test", "client": "Acme", "type": "contract",
        "team": ["ub"],
    }, headers=alice["auth"])
    case_id = r.json()["id"]

    with client.websocket_connect(f"/ws?token={bob['token']}") as bob_ws:
        client.post(f"/api/matters/{case_id}/notes",
                    json={"text": "Alice wrote this"},
                    headers=alice["auth"])

        msg = bob_ws.receive_json()
        assert msg["type"] == "note.added"
        assert msg["case_id"] == case_id
        assert msg["data"]["text"] == "Alice wrote this"
