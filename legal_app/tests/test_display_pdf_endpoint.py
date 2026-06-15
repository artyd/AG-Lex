"""Phase 4.x — GET /api/contracts/{rid}/display.pdf and the reconciliation
siblings. We bypass soffice entirely by seeding the BLOB column directly so
the test is hermetic and Windows-safe.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from backend.database import get_connection, get_db, init_user_schema
from backend.main import app
from backend.models import (
    init_entity_schema,
    migrate_contracts_display_pdf,
    migrate_matters,
    migrate_reconciliations_display_pdf,
    migrate_users,
)
from backend.rbac import init_permissions_schema, seed_default_permissions


_TINY_PDF = b"%PDF-1.4\n" + b"AG Lex e2e display test " + (b"0" * 300) + b"\n%%EOF"


@pytest.fixture
def db_conn():
    conn = get_connection(":memory:", check_same_thread=False)
    init_user_schema(conn)
    init_entity_schema(conn)
    init_permissions_schema(conn)
    seed_default_permissions(conn)
    migrate_users(conn)
    migrate_matters(conn)
    migrate_reconciliations_display_pdf(conn)
    migrate_contracts_display_pdf(conn)
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
def auth(client):
    r = client.post("/api/auth/register", json={
        "name": "Test", "email": "displaypdf@example.com",
        "password": "supersecret", "role": "partner",
    })
    assert r.status_code == 201, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


def _insert_contract(conn, rid: str, pdf: bytes | None) -> None:
    conn.execute(
        "INSERT INTO contracts (id, filename, title, risk, score, findings_count,"
        " analysis_json, display_pdf, created_at)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (rid, "sample.docx", "sample.docx", "med", 64, 0,
         "{}", pdf, "2026-06-15T09:00:00Z"),
    )
    conn.commit()


def test_contract_display_pdf_401_without_auth(client, db_conn):
    _insert_contract(db_conn, "c-test01", _TINY_PDF)
    r = client.get("/api/contracts/c-test01/display.pdf")
    assert r.status_code == 401


def test_contract_display_pdf_200_streams_bytes(client, auth, db_conn):
    _insert_contract(db_conn, "c-test01", _TINY_PDF)
    r = client.get("/api/contracts/c-test01/display.pdf", headers=auth)
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "application/pdf"
    assert r.headers.get("cache-control") == "no-store"
    assert r.content == _TINY_PDF


def test_contract_display_pdf_404_when_blob_null(client, auth, db_conn):
    _insert_contract(db_conn, "c-no-pdf", None)
    r = client.get("/api/contracts/c-no-pdf/display.pdf", headers=auth)
    assert r.status_code == 404
    assert "display pdf" in r.json()["detail"].lower()


def test_contract_display_pdf_404_when_row_missing(client, auth):
    r = client.get("/api/contracts/c-nope/display.pdf", headers=auth)
    assert r.status_code == 404


def test_reconciliation_display_pdf_404_on_unknown(client, auth):
    for tail in ("contract-display.pdf", "handover-display.pdf"):
        r = client.get(f"/api/reconciliations/rec-nope/{tail}", headers=auth)
        assert r.status_code == 404


def test_create_contract_persists_display_pdf_b64(client, auth, db_conn):
    import base64
    payload = {
        "filename": "sample.docx",
        "title": "sample.docx",
        "risk": "med",
        "score": 60,
        "findingsCount": 2,
        "analysis": {"findings": []},
        "displayPdfB64": base64.b64encode(_TINY_PDF).decode("ascii"),
    }
    r = client.post("/api/contracts", json=payload, headers=auth)
    assert r.status_code == 201, r.text
    cid = r.json()["id"]
    assert cid.startswith("c-")
    # BLOB column intentionally absent from generic CRUD list/get responses,
    # so we read it from the DB directly to confirm the write.
    row = db_conn.execute(
        "SELECT display_pdf FROM contracts WHERE id = ?", (cid,),
    ).fetchone()
    assert bytes(row[0]) == _TINY_PDF
    # Endpoint also streams it back.
    r2 = client.get(f"/api/contracts/{cid}/display.pdf", headers=auth)
    assert r2.status_code == 200
    assert r2.content == _TINY_PDF


def test_create_contract_without_display_pdf_b64(client, auth, db_conn):
    payload = {
        "filename": "sample.docx",
        "title": "sample.docx",
        "risk": "low",
        "score": 88,
        "findingsCount": 0,
        "analysis": {},
    }
    r = client.post("/api/contracts", json=payload, headers=auth)
    assert r.status_code == 201, r.text
    cid = r.json()["id"]
    row = db_conn.execute(
        "SELECT display_pdf FROM contracts WHERE id = ?", (cid,),
    ).fetchone()
    assert row[0] is None
    # Endpoint returns 404 when BLOB is NULL.
    r2 = client.get(f"/api/contracts/{cid}/display.pdf", headers=auth)
    assert r2.status_code == 404
