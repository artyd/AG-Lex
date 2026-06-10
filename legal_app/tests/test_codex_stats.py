"""Fix 3 tests: /api/codex/stats + the helpers in backend.codex."""
from __future__ import annotations

import struct

import pytest
from fastapi.testclient import TestClient

from backend.codex import get_codex_stats, sample_articles
from backend.database import (
    get_connection,
    get_db,
    init_schema,
    init_user_schema,
)
from backend.main import app
from backend.rbac import init_permissions_schema, seed_default_permissions


# ---------------------------------------------------------------------------
# fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def db_conn():
    conn = get_connection(":memory:", check_same_thread=False)
    init_schema(conn)
    init_user_schema(conn)
    init_permissions_schema(conn)
    seed_default_permissions(conn)
    yield conn
    conn.close()


def _make_embedding() -> bytes:
    """Three little-endian float32s. Shape doesn't matter for the readiness check."""
    return struct.pack("<3f", 0.1, 0.2, 0.3)


@pytest.fixture
def db_with_codex(db_conn):
    db_conn.executemany(
        "INSERT INTO articles (article_number, title, content, source, embedding) "
        "VALUES (?, ?, ?, ?, ?)",
        [
            ("Стаття 651", "Підстави для розірвання",
             "1. Зміна або розірвання договору допускається лише за згодою сторін…",
             "ЦКУ", _make_embedding()),
            ("Стаття 652", "Зміна обставин",
             "1. У разі істотної зміни обставин…",
             "ЦКУ", _make_embedding()),
            ("Стаття 906", "Відповідальність виконавця",
             "1. За невиконання…",
             "ЦКУ", _make_embedding()),
            ("Article 17", "Right to erasure",
             "The data subject shall have the right to obtain from the controller…",
             "EU_GDPR", _make_embedding()),
        ],
    )
    db_conn.commit()
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
def seeded_client(db_with_codex):
    def _override():
        yield db_with_codex
    app.dependency_overrides[get_db] = _override
    try:
        with TestClient(app) as c:
            yield c
    finally:
        app.dependency_overrides.pop(get_db, None)


def _register(client, *, role="partner"):
    r = client.post("/api/auth/register", json={
        "name": "P", "email": "p@x.com", "password": "supersecret", "role": role,
    })
    assert r.status_code == 201, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


# ---------------------------------------------------------------------------
# get_codex_stats — direct helper
# ---------------------------------------------------------------------------

def test_get_codex_stats_empty_codex(db_conn):
    stats = get_codex_stats(db_conn)
    assert stats == {
        "total_articles": 0,
        "by_source": [],
        "fts_ready": False,
        "vec_ready": False,
    }


def test_get_codex_stats_aggregates_by_source(db_with_codex):
    stats = get_codex_stats(db_with_codex)
    assert stats["total_articles"] == 4
    sources = {row["source"]: row["count"] for row in stats["by_source"]}
    assert sources == {"ЦКУ": 3, "EU_GDPR": 1}
    # by_source is sorted by count desc, then source name asc.
    assert stats["by_source"][0]["source"] == "ЦКУ"


def test_fts_ready_true_when_mirror_in_sync(db_with_codex):
    # init_schema's INSERT trigger keeps FTS5 in sync on every insert.
    stats = get_codex_stats(db_with_codex)
    assert stats["fts_ready"] is True


def test_fts_ready_false_when_mirror_missing(db_with_codex):
    # External-content FTS5 silently swallows direct DELETEs, so dropping the
    # mirror entirely is the cleanest way to simulate "search is broken" — and
    # it also covers a more realistic failure mode (the table was never built).
    db_with_codex.execute("DROP TABLE articles_fts")
    db_with_codex.commit()
    assert get_codex_stats(db_with_codex)["fts_ready"] is False


def test_vec_ready_true_when_embeddings_present(db_with_codex):
    assert get_codex_stats(db_with_codex)["vec_ready"] is True


def test_vec_ready_false_when_no_embeddings(db_conn):
    db_conn.execute(
        "INSERT INTO articles (article_number, title, content, source, embedding) "
        "VALUES (?, ?, ?, ?, ?)",
        ("Стаття 1", "No embedding", "body", "ЦКУ", None),
    )
    db_conn.commit()
    assert get_codex_stats(db_conn)["vec_ready"] is False


# ---------------------------------------------------------------------------
# sample_articles
# ---------------------------------------------------------------------------

def test_sample_articles_returns_at_most_n_rows(db_with_codex):
    samples = sample_articles(db_with_codex, "ЦКУ", n=2)
    assert len(samples) == 2
    for s in samples:
        assert set(s.keys()) == {"article_number", "title", "preview"}
        assert s["article_number"].startswith("Стаття")


def test_sample_articles_truncates_preview(db_with_codex):
    samples = sample_articles(db_with_codex, "ЦКУ", n=1)
    # `substr(content, 1, 200)` upstream; CLI re-trims to 160.
    assert len(samples[0]["preview"]) <= 200


def test_sample_articles_returns_empty_for_unknown_source(db_with_codex):
    assert sample_articles(db_with_codex, "NOWHERE", n=5) == []


# ---------------------------------------------------------------------------
# /api/codex/stats endpoint
# ---------------------------------------------------------------------------

def test_endpoint_requires_auth(client):
    r = client.get("/api/codex/stats")
    assert r.status_code == 401


def test_endpoint_returns_stats_for_authenticated_user(seeded_client):
    headers = _register(seeded_client, role="partner")
    r = seeded_client.get("/api/codex/stats", headers=headers)
    assert r.status_code == 200
    body = r.json()
    assert body["total_articles"] == 4
    assert {row["source"] for row in body["by_source"]} == {"ЦКУ", "EU_GDPR"}
    assert body["fts_ready"] is True
    assert body["vec_ready"] is True


def test_endpoint_works_for_paralegal_role(seeded_client):
    """`view` is granted to every role — even paralegal sees the stats."""
    headers = _register(seeded_client, role="paralegal")
    r = seeded_client.get("/api/codex/stats", headers=headers)
    assert r.status_code == 200
    assert r.json()["total_articles"] == 4


def test_endpoint_returns_403_when_view_revoked(seeded_client, db_with_codex):
    # Strip `view` from paralegal so the gate actually fires.
    db_with_codex.execute(
        "UPDATE permissions SET allowed = 0 WHERE capability = 'view' AND role = 'paralegal'"
    )
    db_with_codex.commit()
    headers = _register(seeded_client, role="paralegal")
    r = seeded_client.get("/api/codex/stats", headers=headers)
    assert r.status_code == 403


def test_endpoint_returns_empty_shape_on_fresh_db(client):
    headers = _register(client, role="partner")
    r = client.get("/api/codex/stats", headers=headers)
    assert r.status_code == 200
    assert r.json() == {
        "total_articles": 0,
        "by_source": [],
        "fts_ready": False,
        "vec_ready": False,
    }
