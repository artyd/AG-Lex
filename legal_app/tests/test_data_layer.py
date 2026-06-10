"""Phase 2.2 tests: workspace entity CRUD + auth gating + seed.

We pick `matters` as the representative entity for full CRUD coverage (its
shape exercises the camelCase ↔ snake_case alias and the integer/float
mix). All other entities get a single GET-list smoke that proves the route
is mounted, returns JSON, and refuses unauthenticated requests.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from backend import auth as auth_module
from backend.crud import ALL_ENTITIES
from backend.database import get_connection, get_db, init_user_schema
from backend.main import app
from backend.models import init_entity_schema
from backend.rbac import init_permissions_schema, seed_default_permissions
from scripts.seed_demo import seed_all


# ---------------------------------------------------------------------------
# fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def db_conn():
    conn = get_connection(":memory:", check_same_thread=False)
    init_user_schema(conn)
    init_entity_schema(conn)
    # Phase 2.3: routes (e.g. /api/invoices via require("billing")) need the
    # permissions matrix populated or every gated request returns 403.
    init_permissions_schema(conn)
    seed_default_permissions(conn)
    yield conn
    conn.close()


@pytest.fixture
def seeded_conn(db_conn):
    seed_all(db_conn)
    return db_conn


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
def seeded_client(seeded_conn):
    def _override():
        yield seeded_conn
    app.dependency_overrides[get_db] = _override
    try:
        with TestClient(app) as c:
            yield c
    finally:
        app.dependency_overrides.pop(get_db, None)


@pytest.fixture
def auth_headers(client, db_conn):
    # Register a fresh user against the same in-memory DB the routes use.
    r = client.post("/api/auth/register", json={
        "name": "Test", "email": "alice@example.com",
        "password": "supersecret", "role": "partner",
    })
    assert r.status_code == 201
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


@pytest.fixture
def seeded_auth_headers(seeded_client):
    r = seeded_client.post("/api/auth/register", json={
        "name": "Test", "email": "alice@example.com",
        "password": "supersecret", "role": "partner",
    })
    assert r.status_code == 201
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


# ---------------------------------------------------------------------------
# Seed sanity — every Phase 2.2 table gets non-empty rows.
# ---------------------------------------------------------------------------

# `drafts` is intentionally user-created (Phase 3.3), not seeded with demo data.
_SEEDED_ENTITIES = tuple(e for e in ALL_ENTITIES if e.table != "drafts")


@pytest.mark.parametrize("entity", _SEEDED_ENTITIES, ids=lambda e: e.table)
def test_seed_populates_every_table(seeded_conn, entity):
    n = seeded_conn.execute(f"SELECT COUNT(*) FROM {entity.table}").fetchone()[0]
    assert n > 0, f"seed_all left {entity.table} empty"


def test_seed_is_idempotent(db_conn):
    seed_all(db_conn)
    counts1 = {e.table: db_conn.execute(f"SELECT COUNT(*) FROM {e.table}").fetchone()[0] for e in ALL_ENTITIES}
    seed_all(db_conn)
    counts2 = {e.table: db_conn.execute(f"SELECT COUNT(*) FROM {e.table}").fetchone()[0] for e in ALL_ENTITIES}
    assert counts1 == counts2, "Re-seeding inflated row counts"


# ---------------------------------------------------------------------------
# Auth gating — every entity route refuses unauthenticated requests.
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("entity", ALL_ENTITIES, ids=lambda e: e.table)
def test_list_requires_auth(client, entity):
    path = f"/api/{entity.table.replace('_', '-')}"
    r = client.get(path)
    assert r.status_code == 401, f"{path} should be auth-gated, got {r.status_code}"


@pytest.mark.parametrize("entity", ALL_ENTITIES, ids=lambda e: e.table)
def test_list_returns_json_array_with_auth(seeded_client, seeded_auth_headers, entity):
    path = f"/api/{entity.table.replace('_', '-')}"
    r = seeded_client.get(path, headers=seeded_auth_headers)
    assert r.status_code == 200, f"{path}: {r.text}"
    body = r.json()
    assert isinstance(body, list)
    # drafts starts empty by design (Phase 3.3 — user-created);
    # every other entity must carry demo seed rows.
    if entity.table != "drafts":
        assert body, f"{path} returned empty list despite seed"


# ---------------------------------------------------------------------------
# matters — full CRUD coverage.
# ---------------------------------------------------------------------------

def test_matters_list_shape(seeded_client, seeded_auth_headers):
    r = seeded_client.get("/api/matters", headers=seeded_auth_headers)
    assert r.status_code == 200
    rows = r.json()
    sample = next(m for m in rows if m["id"] == "m1")
    # camelCase alias survives the wire round-trip
    assert sample["openTasks"] == 3
    assert "open_tasks" not in sample
    assert sample["code"] == "SEV-2026-04"
    assert sample["color"] == 290


def test_matters_get_by_id(seeded_client, seeded_auth_headers):
    r = seeded_client.get("/api/matters/m1", headers=seeded_auth_headers)
    assert r.status_code == 200
    assert r.json()["title"] == "Супровід ТОВ «Северин»"


def test_matters_get_unknown_returns_404(seeded_client, seeded_auth_headers):
    r = seeded_client.get("/api/matters/does-not-exist", headers=seeded_auth_headers)
    assert r.status_code == 404


def test_matters_create_and_read_back(client, auth_headers):
    r = client.post("/api/matters", json={
        "id": "m-new",
        "code": "NEW-2026-99",
        "title": "Нова справа",
        "client": "Клієнт Х",
        "type": "Корпоративне",
        "status": "active",
        "openTasks": 2,
        "hours": 0,
    }, headers=auth_headers)
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["id"] == "m-new"
    assert body["openTasks"] == 2

    # Round-trip via GET
    r2 = client.get("/api/matters/m-new", headers=auth_headers)
    assert r2.status_code == 200
    assert r2.json()["title"] == "Нова справа"


def test_matters_create_auto_generates_id_when_omitted(client, auth_headers):
    r = client.post("/api/matters", json={
        "code": "AUTO-2026-01",
        "title": "Auto-id matter",
        "client": "X",
    }, headers=auth_headers)
    assert r.status_code == 201
    body = r.json()
    assert body["id"].startswith("m-")
    assert len(body["id"]) > 2


def test_matters_create_duplicate_code_returns_409(client, auth_headers):
    client.post("/api/matters", json={"id": "m-a", "code": "DUP-1", "title": "A", "client": "X"}, headers=auth_headers)
    r = client.post("/api/matters", json={"id": "m-b", "code": "DUP-1", "title": "B", "client": "Y"}, headers=auth_headers)
    assert r.status_code == 409


def test_matters_patch_updates_fields(seeded_client, seeded_auth_headers):
    r = seeded_client.patch(
        "/api/matters/m1",
        json={"hours": 99.5, "openTasks": 0, "status": "closed"},
        headers=seeded_auth_headers,
    )
    assert r.status_code == 200
    body = r.json()
    assert body["hours"] == 99.5
    assert body["openTasks"] == 0
    assert body["status"] == "closed"
    # Unchanged fields survive
    assert body["code"] == "SEV-2026-04"


def test_matters_patch_ignores_unknown_fields(seeded_client, seeded_auth_headers):
    r = seeded_client.patch(
        "/api/matters/m1",
        json={"hours": 50, "phantom_column": "ignored"},
        headers=seeded_auth_headers,
    )
    assert r.status_code == 200
    assert r.json()["hours"] == 50


def test_matters_patch_unknown_id_returns_404(seeded_client, seeded_auth_headers):
    r = seeded_client.patch("/api/matters/nope", json={"hours": 1}, headers=seeded_auth_headers)
    assert r.status_code == 404


def test_matters_delete(seeded_client, seeded_auth_headers):
    r = seeded_client.delete("/api/matters/m1", headers=seeded_auth_headers)
    assert r.status_code == 204
    r2 = seeded_client.get("/api/matters/m1", headers=seeded_auth_headers)
    assert r2.status_code == 404


def test_matters_delete_unknown_returns_404(client, auth_headers):
    r = client.delete("/api/matters/nope", headers=auth_headers)
    assert r.status_code == 404


# ---------------------------------------------------------------------------
# JSON-encoded columns (clause_lib.tags, comments.mentions)
# ---------------------------------------------------------------------------

def test_clause_lib_tags_returned_as_list(seeded_client, seeded_auth_headers):
    r = seeded_client.get("/api/clause-lib", headers=seeded_auth_headers)
    assert r.status_code == 200
    rows = r.json()
    first = next(row for row in rows if row["id"] == "cl-1")
    assert isinstance(first["tags"], list)
    assert "ЦК ст. 22, 906" in first["tags"]


def test_comments_mentions_round_trip(client, auth_headers):
    r = client.post("/api/comments", json={
        "id": "cm-x",
        "clause": "1.1",
        "author": "u1",
        "ts": "2026-06-10 10:00",
        "text": "Note with mention.",
        "mentions": ["Богдан Кравчук", "Олена Гриценко"],
        "resolved": 0,
    }, headers=auth_headers)
    assert r.status_code == 201
    assert r.json()["mentions"] == ["Богдан Кравчук", "Олена Гриценко"]

    r2 = client.get("/api/comments/cm-x", headers=auth_headers)
    assert r2.json()["mentions"] == ["Богдан Кравчук", "Олена Гриценко"]


# ---------------------------------------------------------------------------
# tasks — wire shape spot-check
# ---------------------------------------------------------------------------

def test_tasks_seed_has_expected_columns(seeded_client, seeded_auth_headers):
    r = seeded_client.get("/api/tasks", headers=seeded_auth_headers)
    rows = r.json()
    sample = next(t for t in rows if t["id"] == "k1")
    assert sample["matter"] == "SEV-2026-04"
    assert sample["col"] == "progress"
    assert sample["priority"] == "high"
