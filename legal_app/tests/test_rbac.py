"""Phase 2.3 tests: RBAC, team module, audit log, last-manage safeguard."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from backend import audit as audit_module
from backend.audit import init_audit_schema, list_audit
from backend.database import get_connection, get_db, init_user_schema
from backend.main import app
from backend.models import init_entity_schema, migrate_matters, migrate_users
from backend.rbac import (
    CAPABILITIES,
    DEFAULT_PERMISSIONS,
    ROLES,
    count_manage_users,
    get_permissions_matrix,
    has_capability,
    init_permissions_schema,
    seed_default_permissions,
)


# ---------------------------------------------------------------------------
# fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def db_conn():
    conn = get_connection(":memory:", check_same_thread=False)
    init_user_schema(conn)
    init_entity_schema(conn)  # invoices et al. — gated by billing in Phase 2.3
    init_permissions_schema(conn)
    init_audit_schema(conn)
    seed_default_permissions(conn)
    # Phase 2.4: team.list_members reads users.legacy_id, so this migration
    # has to be in place even for the rbac suite that doesn't otherwise
    # touch matters.
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


def _register(client, *, name, email, password, role) -> dict:
    r = client.post("/api/auth/register", json={
        "name": name, "email": email, "password": password, "role": role,
    })
    assert r.status_code == 201, r.text
    return r.json()


def _bearer(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


# ---------------------------------------------------------------------------
# Defaults sanity
# ---------------------------------------------------------------------------

def test_default_matrix_matches_spec(db_conn):
    matrix = get_permissions_matrix(db_conn)
    assert [r["key"] for r in matrix] == list(CAPABILITIES)
    by_key = {row["key"]: row for row in matrix}
    for capability, role_map in DEFAULT_PERMISSIONS:
        for role in ROLES:
            assert by_key[capability][role] == role_map[role], (
                f"{capability}.{role} drift from default"
            )


def test_has_capability_reads_matrix(db_conn):
    assert has_capability(db_conn, "partner", "ai")
    assert has_capability(db_conn, "partner", "manage")
    assert not has_capability(db_conn, "paralegal", "edit")
    assert not has_capability(db_conn, "admin", "ai")


def test_seed_default_permissions_is_idempotent(db_conn):
    seed_default_permissions(db_conn)
    n1 = db_conn.execute("SELECT COUNT(*) FROM permissions").fetchone()[0]
    seed_default_permissions(db_conn)
    n2 = db_conn.execute("SELECT COUNT(*) FROM permissions").fetchone()[0]
    assert n1 == n2


# ---------------------------------------------------------------------------
# /api/analyze gating by `ai`
# ---------------------------------------------------------------------------

def test_analyze_requires_ai_capability_returns_403(client, monkeypatch):
    """admin's default has ai=False — even a valid token gets 403."""
    from backend import main
    monkeypatch.setattr(main, "analyze", lambda **_: {
        "answer": "x", "used_articles": [], "warnings": [],
        "usage": {"input_tokens": 0, "output_tokens": 0,
                  "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0},
        "model": "x",
    })
    reg = _register(client, name="A", email="a@x.com", password="supersecret", role="admin")
    r = client.post("/api/analyze", json={"question": "Q?"}, headers=_bearer(reg["access_token"]))
    assert r.status_code == 403
    assert "ai" in r.json()["detail"].lower()


def test_analyze_allows_role_with_ai(client, monkeypatch):
    from backend import main
    monkeypatch.setattr(main, "analyze", lambda **_: {
        "answer": "За ст. 651", "used_articles": [], "warnings": [],
        "usage": {"input_tokens": 0, "output_tokens": 0,
                  "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0},
        "model": "x",
    })
    reg = _register(client, name="L", email="l@x.com", password="supersecret", role="lawyer")
    r = client.post("/api/analyze", json={"question": "Q?"}, headers=_bearer(reg["access_token"]))
    assert r.status_code == 200


# ---------------------------------------------------------------------------
# Team module — members
# ---------------------------------------------------------------------------

def test_list_members_works_for_any_authenticated_user(client):
    p = _register(client, name="Manager", email="boss@x.com", password="supersecret", role="partner")
    _register(client, name="Lawyer", email="lw@x.com", password="supersecret", role="lawyer")
    r = client.get("/api/team/members", headers=_bearer(p["access_token"]))
    assert r.status_code == 200
    emails = {u["email"] for u in r.json()}
    assert {"boss@x.com", "lw@x.com"} <= emails


def test_change_role_requires_manage(client):
    p = _register(client, name="Manager", email="boss@x.com", password="supersecret", role="partner")
    lw = _register(client, name="Lawyer", email="lw@x.com", password="supersecret", role="lawyer")
    # Lawyer (no manage) tries to promote themselves.
    r = client.patch(
        f"/api/team/members/{lw['user']['id']}",
        json={"role": "partner"},
        headers=_bearer(lw["access_token"]),
    )
    assert r.status_code == 403


def test_partner_changes_role_writes_audit(client, db_conn):
    p = _register(client, name="Manager", email="boss@x.com", password="supersecret", role="partner")
    lw = _register(client, name="Lawyer", email="lw@x.com", password="supersecret", role="lawyer")
    r = client.patch(
        f"/api/team/members/{lw['user']['id']}",
        json={"role": "senior"},
        headers=_bearer(p["access_token"]),
    )
    assert r.status_code == 200
    assert r.json()["role"] == "senior"

    log = list_audit(db_conn)
    role_changes = [e for e in log if e["action"] == audit_module.ACTION_ROLE_CHANGE]
    assert len(role_changes) == 1
    assert role_changes[0]["actor_name"] == "Manager"
    assert role_changes[0]["meta"]["from"] == "lawyer"
    assert role_changes[0]["meta"]["to"] == "senior"


def test_change_role_unknown_member_returns_404(client):
    p = _register(client, name="Manager", email="boss@x.com", password="supersecret", role="partner")
    r = client.patch(
        "/api/team/members/9999",
        json={"role": "lawyer"},
        headers=_bearer(p["access_token"]),
    )
    assert r.status_code == 404


def test_invite_creates_user_and_logs_audit(client, db_conn):
    p = _register(client, name="Manager", email="boss@x.com", password="supersecret", role="partner")
    r = client.post(
        "/api/team/members",
        json={"name": "Newcomer", "email": "new@x.com", "password": "supersecret", "role": "lawyer"},
        headers=_bearer(p["access_token"]),
    )
    assert r.status_code == 201
    assert r.json()["email"] == "new@x.com"
    # Audit captured the invite
    log = list_audit(db_conn)
    assert any(e["action"] == audit_module.ACTION_INVITE for e in log)


def test_invite_requires_manage(client):
    lw = _register(client, name="L", email="lw@x.com", password="supersecret", role="lawyer")
    r = client.post(
        "/api/team/members",
        json={"name": "X", "email": "x@x.com", "password": "supersecret", "role": "lawyer"},
        headers=_bearer(lw["access_token"]),
    )
    assert r.status_code == 403


def test_invite_duplicate_email_returns_409(client):
    p = _register(client, name="P", email="p@x.com", password="supersecret", role="partner")
    r = client.post(
        "/api/team/members",
        json={"name": "Dup", "email": "p@x.com", "password": "supersecret", "role": "lawyer"},
        headers=_bearer(p["access_token"]),
    )
    assert r.status_code == 409


def test_remove_member_writes_audit(client, db_conn):
    p = _register(client, name="P", email="p@x.com", password="supersecret", role="partner")
    p2 = _register(client, name="P2", email="p2@x.com", password="supersecret", role="partner")
    r = client.delete(
        f"/api/team/members/{p2['user']['id']}",
        headers=_bearer(p["access_token"]),
    )
    assert r.status_code == 204
    log = list_audit(db_conn)
    assert any(e["action"] == audit_module.ACTION_REMOVE for e in log)


def test_remove_self_is_blocked(client):
    p = _register(client, name="P", email="p@x.com", password="supersecret", role="partner")
    r = client.delete(
        f"/api/team/members/{p['user']['id']}",
        headers=_bearer(p["access_token"]),
    )
    assert r.status_code == 400


# ---------------------------------------------------------------------------
# Last-manage safeguard
# ---------------------------------------------------------------------------

def test_count_manage_users_tracks_users_with_manage_role(db_conn, client):
    # Empty DB: nobody yet
    assert count_manage_users(db_conn) == 0

    _register(client, name="P", email="p@x.com", password="supersecret", role="partner")
    assert count_manage_users(db_conn) == 1

    _register(client, name="L", email="lw@x.com", password="supersecret", role="lawyer")
    assert count_manage_users(db_conn) == 1


def test_demoting_last_manager_is_blocked(client):
    p = _register(client, name="P", email="p@x.com", password="supersecret", role="partner")
    # P is the only user — and the only one with `manage`. Demote attempt → 409.
    r = client.patch(
        f"/api/team/members/{p['user']['id']}",
        json={"role": "lawyer"},
        headers=_bearer(p["access_token"]),
    )
    assert r.status_code == 409
    assert "manage" in r.json()["detail"].lower()


def test_demoting_one_of_multiple_managers_is_allowed(client):
    p1 = _register(client, name="P1", email="p1@x.com", password="supersecret", role="partner")
    p2 = _register(client, name="P2", email="p2@x.com", password="supersecret", role="partner")
    r = client.patch(
        f"/api/team/members/{p2['user']['id']}",
        json={"role": "lawyer"},
        headers=_bearer(p1["access_token"]),
    )
    assert r.status_code == 200


def test_disabling_manage_for_only_role_with_users_is_blocked(client):
    p = _register(client, name="P", email="p@x.com", password="supersecret", role="partner")
    # Try to turn off manage for partner — would zero out manage holders.
    r = client.patch(
        "/api/team/permissions",
        json={"capability": "manage", "role": "partner", "allowed": False},
        headers=_bearer(p["access_token"]),
    )
    assert r.status_code == 409


def test_toggling_a_safe_permission_is_allowed_and_audited(client, db_conn):
    p = _register(client, name="P", email="p@x.com", password="supersecret", role="partner")
    r = client.patch(
        "/api/team/permissions",
        json={"capability": "ai", "role": "admin", "allowed": True},
        headers=_bearer(p["access_token"]),
    )
    assert r.status_code == 200
    assert has_capability(db_conn, "admin", "ai")
    log = list_audit(db_conn)
    assert any(e["action"] == audit_module.ACTION_PERM_ON for e in log)


def test_permission_toggle_requires_manage(client):
    _register(client, name="P", email="p@x.com", password="supersecret", role="partner")
    lw = _register(client, name="L", email="lw@x.com", password="supersecret", role="lawyer")
    r = client.patch(
        "/api/team/permissions",
        json={"capability": "ai", "role": "admin", "allowed": True},
        headers=_bearer(lw["access_token"]),
    )
    assert r.status_code == 403


# ---------------------------------------------------------------------------
# Permission reset
# ---------------------------------------------------------------------------

def test_reset_permissions_restores_defaults_and_audits(client, db_conn):
    p = _register(client, name="P", email="p@x.com", password="supersecret", role="partner")

    # Flip ai for admin first.
    client.patch(
        "/api/team/permissions",
        json={"capability": "ai", "role": "admin", "allowed": True},
        headers=_bearer(p["access_token"]),
    )
    assert has_capability(db_conn, "admin", "ai")

    r = client.post("/api/team/permissions/reset", headers=_bearer(p["access_token"]))
    assert r.status_code == 200
    assert not has_capability(db_conn, "admin", "ai")

    log = list_audit(db_conn)
    assert any(e["action"] == audit_module.ACTION_PERM_RESET for e in log)


def test_reset_permissions_requires_manage(client):
    _register(client, name="P", email="p@x.com", password="supersecret", role="partner")
    lw = _register(client, name="L", email="lw@x.com", password="supersecret", role="lawyer")
    r = client.post("/api/team/permissions/reset", headers=_bearer(lw["access_token"]))
    assert r.status_code == 403


# ---------------------------------------------------------------------------
# Audit endpoint
# ---------------------------------------------------------------------------

def test_audit_endpoint_requires_manage(client):
    _register(client, name="P", email="p@x.com", password="supersecret", role="partner")
    lw = _register(client, name="L", email="lw@x.com", password="supersecret", role="lawyer")
    r = client.get("/api/team/audit", headers=_bearer(lw["access_token"]))
    assert r.status_code == 403


def test_audit_endpoint_returns_log_newest_first(client):
    p = _register(client, name="P", email="p@x.com", password="supersecret", role="partner")
    # Generate two audit entries
    client.post(
        "/api/team/members",
        json={"name": "N1", "email": "n1@x.com", "password": "supersecret", "role": "lawyer"},
        headers=_bearer(p["access_token"]),
    )
    client.post(
        "/api/team/members",
        json={"name": "N2", "email": "n2@x.com", "password": "supersecret", "role": "lawyer"},
        headers=_bearer(p["access_token"]),
    )
    r = client.get("/api/team/audit", headers=_bearer(p["access_token"]))
    assert r.status_code == 200
    log = r.json()
    assert len(log) >= 2
    # Newest first
    assert log[0]["id"] > log[1]["id"]


# ---------------------------------------------------------------------------
# Invoices gating (Phase 2.2 entity now requires `billing`)
# ---------------------------------------------------------------------------

def test_invoices_list_requires_billing(client):
    lw = _register(client, name="L", email="lw@x.com", password="supersecret", role="lawyer")
    r = client.get("/api/invoices", headers=_bearer(lw["access_token"]))
    assert r.status_code == 403


def test_invoices_list_allowed_for_partner(client):
    p = _register(client, name="P", email="p@x.com", password="supersecret", role="partner")
    r = client.get("/api/invoices", headers=_bearer(p["access_token"]))
    assert r.status_code == 200
