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
from backend.models import init_entity_schema, migrate_matters, migrate_users
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
    # Phase 2.4: seed_all now writes case_members + sets users.legacy_id, so
    # both migrations must run for seed_all to succeed against fresh test DBs.
    migrate_users(conn)
    migrate_matters(conn)
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

# `drafts` (Phase 3.3), `reconciliations` (handover feature), and `contracts`
# (Phase 3.2 single-contract analyses) are intentionally user-created at
# runtime, not seeded with demo data.
_SEEDED_ENTITIES = tuple(
    e for e in ALL_ENTITIES if e.table not in {"drafts", "reconciliations", "contracts"}
)


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
    # drafts (Phase 3.3), reconciliations (handover) and contracts
    # (Phase 3.2 analyses) start empty by design — user-created at runtime.
    if entity.table not in {"drafts", "reconciliations", "contracts"}:
        assert body, f"{path} returned empty list despite seed"


# ---------------------------------------------------------------------------
# matters — full CRUD coverage.
# ---------------------------------------------------------------------------

# NOTE: Matters CRUD tests moved to tests/test_matters_endpoints.py.
# /api/matters is no longer generic CRUD as of Phase 2.4 — it has row-level
# access control through case_members, field-level activity_log on PATCH,
# and dedicated child endpoints (notes, hearings, parties, time entries).
# The Phase 2.2 tests that lived here probed behavior the new router does
# not expose (e.g. open create-by-id, no membership check); equivalent
# coverage lives in the dedicated test file.


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


# ---------------------------------------------------------------------------
# contracts — Phase 3.2 single-contract analysis persistence.
# ---------------------------------------------------------------------------

def test_contracts_round_trip(client, auth_headers):
    # Mirrors what ContractAnalysis posts after a successful /api/analyze/contract.
    payload = {
        "filename": "sample.docx",
        "title": "sample.docx",
        "counterparty": "ТОВ Тест",
        "risk": "med",
        "score": 64,
        "findingsCount": 3,
        "analysis": {
            "findings": [
                {"id": "f1", "level": "med", "clause": "п. 4.1", "title": "Penalty"},
            ],
            "comparison": [],
            "legal_basis": [{"code": "ЦКУ", "ref": "ст. 549", "scope": "UA"}],
            "score": {"value": 64, "label": "Помірний ризик", "risks": {"high": 0, "med": 1, "low": 0}},
            "warnings": [],
            "_doc": {"filename": "sample.docx", "sections": [{"number": "1", "title": "Предмет", "text": "..."}]},
        },
        "createdAt": "2026-06-15T09:00:00Z",
    }
    r = client.post("/api/contracts", json=payload, headers=auth_headers)
    assert r.status_code == 201, r.text
    created = r.json()
    # camelCase ↔ snake_case alias on findingsCount + createdAt + analysis.
    assert created["findingsCount"] == 3
    assert created["createdAt"] == "2026-06-15T09:00:00Z"
    assert isinstance(created["analysis"], dict)
    assert created["analysis"]["legal_basis"][0]["code"] == "ЦКУ"
    assert created["id"].startswith("c-")

    # Listing returns at least the new row.
    rl = client.get("/api/contracts", headers=auth_headers)
    assert rl.status_code == 200
    rows = rl.json()
    assert any(c["id"] == created["id"] for c in rows)

    # GET-by-id hydrates the same JSON-decoded analysis blob the FE expects.
    rg = client.get(f"/api/contracts/{created['id']}", headers=auth_headers)
    assert rg.status_code == 200
    got = rg.json()
    assert got["analysis"]["_doc"]["sections"][0]["number"] == "1"
    assert got["risk"] == "med"
    assert got["score"] == 64


def test_contracts_requires_auth(client):
    r = client.get("/api/contracts")
    assert r.status_code == 401
    r2 = client.post("/api/contracts", json={"filename": "x.docx"})
    assert r2.status_code == 401
