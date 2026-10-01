"""REGISTRATION_MODE=closed — self-signup can't mint accounts (esp. partners)."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from backend.config import get_settings
from backend.database import get_connection, get_db, init_user_schema
from backend.main import app
from backend.audit import init_audit_schema
from backend.rbac import init_permissions_schema, seed_default_permissions


@pytest.fixture
def client(monkeypatch):
    conn = get_connection(":memory:", check_same_thread=False)
    init_user_schema(conn)
    init_permissions_schema(conn)
    seed_default_permissions(conn)
    init_audit_schema(conn)
    monkeypatch.setattr(get_settings(), "REGISTRATION_MODE", "closed")

    def _override():
        yield conn
    app.dependency_overrides[get_db] = _override
    try:
        with TestClient(app) as c:
            yield c
    finally:
        app.dependency_overrides.pop(get_db, None)
        conn.close()


def _reg(client, email, role, headers=None):
    return client.post("/api/auth/register", headers=headers or {}, json={
        "name": "X", "email": email, "password": "supersecret", "role": role,
    })


def test_first_user_bootstraps_then_registration_closes(client):
    first = _reg(client, "admin@aglex.ua", "admin")
    assert first.status_code == 201
    r = _reg(client, "mallory@evil.io", "partner")
    assert r.status_code == 403
    assert "закрита" in r.json()["detail"]


def test_manage_capability_can_register(client):
    admin = _reg(client, "admin@aglex.ua", "admin").json()
    auth = {"Authorization": f"Bearer {admin['access_token']}"}
    assert _reg(client, "new@aglex.ua", "lawyer", auth).status_code == 201


def test_non_manage_user_cannot_register(client):
    _reg(client, "admin@aglex.ua", "admin")
    # a lawyer (no `manage`) is created by the admin…
    admin_tok = client.post("/api/auth/login", json={"email": "admin@aglex.ua", "password": "supersecret"}).json()
    _reg(client, "law@aglex.ua", "lawyer", {"Authorization": f"Bearer {admin_tok['access_token']}"})
    law_tok = client.post("/api/auth/login", json={"email": "law@aglex.ua", "password": "supersecret"}).json()
    # …and cannot mint a partner.
    r = _reg(client, "p@aglex.ua", "partner", {"Authorization": f"Bearer {law_tok['access_token']}"})
    assert r.status_code == 403


def test_login_unknown_email_same_error(client):
    _reg(client, "admin@aglex.ua", "admin")
    a = client.post("/api/auth/login", json={"email": "nobody@aglex.ua", "password": "x"})
    b = client.post("/api/auth/login", json={"email": "admin@aglex.ua", "password": "wrong"})
    assert a.status_code == b.status_code == 401
    assert a.json() == b.json()


def test_manage_register_is_audited(client):
    admin = _reg(client, "admin@aglex.ua", "admin").json()
    _reg(client, "new@aglex.ua", "partner", {"Authorization": f"Bearer {admin['access_token']}"})
    from backend.database import get_db as _g
    conn = next(app.dependency_overrides[_g]())
    rows = conn.execute("SELECT action, target FROM audit").fetchall()
    assert ("invite", "new@aglex.ua") in rows


def test_demo_account_blocked_when_disabled(client, monkeypatch):
    from backend.auth import TEST_USER_EMAIL, TEST_USER_PASSWORD, seed_test_user
    from backend.database import get_db as _g
    conn = next(app.dependency_overrides[_g]())
    seed_test_user(conn)  # enabled (conftest) → row exists, token works
    tok = client.post("/api/auth/login", json={"email": TEST_USER_EMAIL, "password": TEST_USER_PASSWORD})
    assert tok.status_code == 200
    auth = {"Authorization": f"Bearer {tok.json()['access_token']}"}
    assert client.get("/api/auth/me", headers=auth).status_code == 200

    monkeypatch.setattr(get_settings(), "DEMO_LOGIN_ENABLED", False)
    # login refused, and the already-issued long-lived JWT stops working too
    assert client.post("/api/auth/login", json={"email": TEST_USER_EMAIL, "password": TEST_USER_PASSWORD}).status_code == 401
    assert client.get("/api/auth/me", headers=auth).status_code == 401
    # …so it can't be used to mint new staff either
    assert _reg(client, "evil@x.io", "partner", auth).status_code == 403
