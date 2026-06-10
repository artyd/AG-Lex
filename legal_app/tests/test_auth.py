"""Phase 2.1 tests: registration, login, /me, JWT handling.

Each test gets a fresh in-memory SQLite via the `get_db` dependency override,
so users from one test never leak into the next. The TestClient triggers the
FastAPI lifespan (which seeds `test@aglex.ua` against the *production* DB);
the dependency override is per-request, so the actual auth routes only ever
see the test DB.
"""
from __future__ import annotations

import sqlite3
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from jose import jwt

from backend import auth as auth_module
from backend.config import get_settings
from backend.database import get_connection, get_db, init_user_schema
from backend.main import app


# ---------------------------------------------------------------------------
# fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def test_conn():
    # check_same_thread=False so the one in-memory conn can serve multiple
    # TestClient requests, which the harness may dispatch on different threads.
    conn = get_connection(":memory:", check_same_thread=False)
    init_user_schema(conn)
    yield conn
    conn.close()


@pytest.fixture
def client(test_conn):
    def _override():
        yield test_conn
    app.dependency_overrides[get_db] = _override
    try:
        with TestClient(app) as c:
            yield c
    finally:
        app.dependency_overrides.pop(get_db, None)


def _register(client, **overrides) -> dict:
    body = {
        "name": "Іван Петренко",
        "email": "ivan@example.com",
        "password": "supersecret",
        "role": "lawyer",
        **overrides,
    }
    r = client.post("/api/auth/register", json=body)
    return r


# ---------------------------------------------------------------------------
# password + JWT unit tests (no HTTP)
# ---------------------------------------------------------------------------

def test_hash_and_verify_password_roundtrip():
    h = auth_module.hash_password("supersecret")
    assert h != "supersecret"
    assert auth_module.verify_password("supersecret", h)
    assert not auth_module.verify_password("wrong", h)
    assert not auth_module.verify_password("supersecret", "not-a-real-hash")


def test_create_and_decode_token_roundtrip():
    token = auth_module.create_access_token(user_id=42, role="partner")
    payload = auth_module.decode_token(token)
    assert payload["sub"] == "42"
    assert payload["role"] == "partner"
    assert payload["exp"] > payload["iat"]


def test_decode_token_rejects_bad_signature():
    bad = jwt.encode({"sub": "1", "role": "partner", "exp": 99999999999}, "wrong-secret", algorithm="HS256")
    with pytest.raises(Exception):
        auth_module.decode_token(bad)


# ---------------------------------------------------------------------------
# /api/auth/register
# ---------------------------------------------------------------------------

def test_register_returns_token_and_user(client):
    r = _register(client)
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["token_type"] == "bearer"
    assert body["access_token"]
    assert body["user"]["email"] == "ivan@example.com"
    assert body["user"]["name"] == "Іван Петренко"
    assert body["user"]["role"] == "lawyer"
    assert "id" in body["user"]
    assert "created_at" in body["user"]


def test_register_normalises_email_to_lowercase(client):
    r = _register(client, email="IVAN@Example.COM")
    assert r.status_code == 201
    assert r.json()["user"]["email"] == "ivan@example.com"


def test_register_duplicate_email_returns_409(client):
    _register(client)
    r = _register(client)
    assert r.status_code == 409
    assert "already" in r.json()["detail"].lower()


def test_register_rejects_short_password(client):
    r = _register(client, password="short")
    assert r.status_code == 422


def test_register_rejects_invalid_email(client):
    r = _register(client, email="not-an-email")
    assert r.status_code == 422


def test_register_rejects_unknown_role(client):
    r = _register(client, role="dictator")
    assert r.status_code == 422


# ---------------------------------------------------------------------------
# /api/auth/login
# ---------------------------------------------------------------------------

def test_login_with_correct_credentials_returns_token(client):
    _register(client)
    r = client.post("/api/auth/login", json={"email": "ivan@example.com", "password": "supersecret"})
    assert r.status_code == 200
    assert r.json()["access_token"]
    assert r.json()["user"]["email"] == "ivan@example.com"


def test_login_with_wrong_password_returns_401(client):
    _register(client)
    r = client.post("/api/auth/login", json={"email": "ivan@example.com", "password": "wrong"})
    assert r.status_code == 401


def test_login_with_unknown_email_returns_401(client):
    r = client.post("/api/auth/login", json={"email": "nobody@example.com", "password": "supersecret"})
    assert r.status_code == 401


def test_login_email_is_case_insensitive(client):
    _register(client)
    r = client.post("/api/auth/login", json={"email": "IVAN@EXAMPLE.COM", "password": "supersecret"})
    assert r.status_code == 200


# ---------------------------------------------------------------------------
# /api/auth/me
# ---------------------------------------------------------------------------

def test_me_with_valid_token_returns_user(client):
    reg = _register(client).json()
    token = reg["access_token"]
    r = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200
    assert r.json()["email"] == "ivan@example.com"


def test_me_without_token_returns_401(client):
    r = client.get("/api/auth/me")
    assert r.status_code == 401


def test_me_with_garbage_token_returns_401(client):
    r = client.get("/api/auth/me", headers={"Authorization": "Bearer not.a.real.token"})
    assert r.status_code == 401


def test_me_with_token_signed_by_other_secret_returns_401(client):
    bad = jwt.encode(
        {"sub": "1", "role": "partner",
         "exp": int((datetime.now(tz=timezone.utc) + timedelta(hours=1)).timestamp())},
        "different-secret",
        algorithm="HS256",
    )
    r = client.get("/api/auth/me", headers={"Authorization": f"Bearer {bad}"})
    assert r.status_code == 401


def test_me_with_expired_token_returns_401(client):
    # Sign a token that expired an hour ago using the *real* secret.
    secret = get_settings().JWT_SECRET
    expired = jwt.encode(
        {"sub": "1", "role": "partner",
         "exp": int((datetime.now(tz=timezone.utc) - timedelta(hours=1)).timestamp())},
        secret, algorithm="HS256",
    )
    r = client.get("/api/auth/me", headers={"Authorization": f"Bearer {expired}"})
    assert r.status_code == 401


def test_me_with_valid_signature_but_unknown_user_returns_401(client, test_conn):
    # Sign a token for user id 99999 that doesn't exist in the test DB.
    token = auth_module.create_access_token(user_id=99999, role="partner")
    r = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 401


# ---------------------------------------------------------------------------
# seed_test_user
# ---------------------------------------------------------------------------

def test_seed_test_user_creates_demo_account(test_conn):
    auth_module.seed_test_user(test_conn)
    user = auth_module.get_user_by_email(test_conn, auth_module.TEST_USER_EMAIL)
    assert user is not None
    assert user["role"] == "partner"
    assert auth_module.verify_password(auth_module.TEST_USER_PASSWORD, user["password_hash"])


def test_seed_test_user_is_idempotent(test_conn):
    auth_module.seed_test_user(test_conn)
    auth_module.seed_test_user(test_conn)  # second call must not raise
    count = test_conn.execute("SELECT COUNT(*) FROM users WHERE email = ?",
                              (auth_module.TEST_USER_EMAIL,)).fetchone()[0]
    assert count == 1


def test_test_account_can_login_after_seed(client, test_conn):
    auth_module.seed_test_user(test_conn)
    r = client.post("/api/auth/login", json={
        "email": auth_module.TEST_USER_EMAIL,
        "password": auth_module.TEST_USER_PASSWORD,
    })
    assert r.status_code == 200
    assert r.json()["user"]["role"] == "partner"
