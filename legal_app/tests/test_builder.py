"""Phase 3.3 tests: document builder + drafts.

Claude is stubbed (no network). Drafts CRUD rides on the generic Phase 2.2
router and is exercised end-to-end via the TestClient.
"""
from __future__ import annotations

import json
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

from backend import builder as builder_module
from backend.builder import (
    DOC_TYPES,
    GENERATE_JSON_SCHEMA,
    _validate_cited_articles,
    generate_document,
)
from backend.claude_client import ClaudeError
from backend.database import (
    get_connection,
    get_db,
    init_schema,
    init_user_schema,
)
from backend.main import app
from backend.models import init_entity_schema
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
    yield conn
    conn.close()


@pytest.fixture
def db_with_codex(db_conn):
    db_conn.executemany(
        "INSERT INTO articles (article_number, title, content, source) VALUES (?, ?, ?, ?)",
        [
            ("Стаття 901", "Договір про надання послуг", "...", "ЦКУ"),
            ("Стаття 906", "Відповідальність виконавця", "...", "ЦКУ"),
            ("Стаття 907", "Розірвання договору про надання послуг", "...", "ЦКУ"),
            ("Стаття 712", "Договір постачання", "...", "ЦКУ"),
        ],
    )
    db_conn.commit()
    return db_conn


@pytest.fixture
def client(db_with_codex):
    def _override():
        yield db_with_codex
    app.dependency_overrides[get_db] = _override
    try:
        with TestClient(app) as c:
            yield c
    finally:
        app.dependency_overrides.pop(get_db, None)


@pytest.fixture
def auth(client):
    r = client.post("/api/auth/register", json={
        "name": "P", "email": "p@x.com", "password": "supersecret", "role": "partner",
    })
    assert r.status_code == 201, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


# ---------------------------------------------------------------------------
# stubs
# ---------------------------------------------------------------------------

def _envelope(payload: dict):
    return SimpleNamespace(
        content=[SimpleNamespace(type="text", text=json.dumps(payload, ensure_ascii=False))],
        model="claude-sonnet-4-6",
        stop_reason="end_turn",
        usage=SimpleNamespace(input_tokens=2000, output_tokens=1000,
                              cache_creation_input_tokens=0, cache_read_input_tokens=0),
    )


def _fake_anthropic_client(payload: dict):
    fake = MagicMock()
    fake.messages.create.return_value = _envelope(payload)
    return fake


_DEFAULT_PAYLOAD = {
    "document_markdown": "# ДОГОВІР про надання послуг\n\n1. Предмет договору…",
    "layout": "contract",
    "articles_cited": ["ст. 901 ЦК", "ст. 906 ЦК"],
}


# ---------------------------------------------------------------------------
# DOC_TYPES registry
# ---------------------------------------------------------------------------

def test_doc_types_cover_six_required_kinds():
    assert set(DOC_TYPES.keys()) == {
        "services", "supply", "lease", "nda", "claim", "lawsuit",
    }


def test_doc_types_have_layouts():
    contracts = {k for k, v in DOC_TYPES.items() if v.layout == "contract"}
    letters = {k for k, v in DOC_TYPES.items() if v.layout == "letter"}
    assert {"services", "supply", "lease", "nda"} <= contracts
    assert {"claim", "lawsuit"} == letters


# ---------------------------------------------------------------------------
# JSON schema sanity
# ---------------------------------------------------------------------------

def test_schema_locks_required_fields():
    assert set(GENERATE_JSON_SCHEMA["required"]) == {
        "document_markdown", "layout", "articles_cited",
    }
    assert GENERATE_JSON_SCHEMA["properties"]["layout"]["enum"] == ["contract", "letter"]


# ---------------------------------------------------------------------------
# generate_document — Claude call
# ---------------------------------------------------------------------------

def test_generate_document_uses_json_schema_and_cached_prompt(db_with_codex):
    fake = _fake_anthropic_client(_DEFAULT_PAYLOAD)
    generate_document("services", {"partyA": "X", "partyB": "Y"}, {}, conn=db_with_codex, client=fake)
    kwargs = fake.messages.create.call_args.kwargs
    assert kwargs["output_config"]["format"]["type"] == "json_schema"
    assert kwargs["output_config"]["format"]["schema"] is GENERATE_JSON_SCHEMA
    assert kwargs["system"][0]["cache_control"] == {"type": "ephemeral"}


def test_generate_document_returns_full_shape(db_with_codex):
    fake = _fake_anthropic_client(_DEFAULT_PAYLOAD)
    result = generate_document(
        "services", {"partyA": "Замовник", "partyB": "Виконавець"}, {}, conn=db_with_codex, client=fake,
    )
    assert set(result) >= {
        "document_markdown", "layout", "articles_cited",
        "warnings", "type", "type_label", "model", "usage",
    }
    assert result["type"] == "services"
    assert result["layout"] == "contract"
    assert result["articles_cited"] == ["ст. 901 ЦК", "ст. 906 ЦК"]
    assert result["model"] == "claude-sonnet-4-6"


def test_generate_document_passes_params_options_and_context_in_user_turn(db_with_codex):
    fake = _fake_anthropic_client(_DEFAULT_PAYLOAD)
    generate_document(
        "services",
        {"partyA": "ТОВ «Альфа»", "partyB": "ТОВ «Бета»", "amount": "100000"},
        {"penalty": True, "liability": False},
        conn=db_with_codex,
        client=fake,
    )
    user_content = fake.messages.create.call_args.kwargs["messages"][0]["content"]
    # Params surfaced as JSON, options enumerated, codex articles included.
    assert "ТОВ «Альфа»" in user_content
    assert "penalty" in user_content
    assert "<context_articles>" in user_content


def test_generate_document_warns_on_invented_articles(db_with_codex):
    # The model cites ст. 9999, which isn't in the codex.
    payload = {
        **_DEFAULT_PAYLOAD,
        "articles_cited": ["ст. 9999 ЦК"],
    }
    fake = _fake_anthropic_client(payload)
    result = generate_document("services", {}, {}, conn=db_with_codex, client=fake)
    assert any("9999" in w for w in result["warnings"])


def test_generate_document_raises_on_unknown_type(db_with_codex):
    fake = _fake_anthropic_client(_DEFAULT_PAYLOAD)
    with pytest.raises(ValueError, match="Unknown document type"):
        generate_document("invalid_type", {}, {}, conn=db_with_codex, client=fake)


def test_generate_document_raises_on_malformed_json(db_with_codex):
    fake = MagicMock()
    fake.messages.create.return_value = SimpleNamespace(
        content=[SimpleNamespace(type="text", text="not json")],
        model="claude-sonnet-4-6", stop_reason="end_turn",
        usage=SimpleNamespace(input_tokens=0, output_tokens=0,
                              cache_creation_input_tokens=0, cache_read_input_tokens=0),
    )
    with pytest.raises(ClaudeError, match="non-JSON"):
        generate_document("services", {}, {}, conn=db_with_codex, client=fake)


# ---------------------------------------------------------------------------
# Citation validator
# ---------------------------------------------------------------------------

def test_validate_cited_articles_flags_missing(db_with_codex):
    warnings = _validate_cited_articles(db_with_codex, ["ст. 9999 ЦК"])
    assert len(warnings) == 1
    assert "9999" in warnings[0]


def test_validate_cited_articles_empty_when_grounded(db_with_codex):
    warnings = _validate_cited_articles(db_with_codex, ["ст. 901 ЦК", "ст. 906 ЦК"])
    assert warnings == []


def test_validate_cited_articles_degrades_when_codex_empty(db_conn):
    warnings = _validate_cited_articles(db_conn, ["ст. 901 ЦК"])
    assert any("порожня" in w for w in warnings)


# ---------------------------------------------------------------------------
# /api/generate-document endpoint
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("doc_type", list(DOC_TYPES.keys()))
def test_endpoint_generates_each_of_six_types(client, auth, monkeypatch, doc_type):
    def fake_generate(type_, params, options, conn=None):
        return {
            "document_markdown": f"# {DOC_TYPES[type_].default_heading}\n…",
            "layout": DOC_TYPES[type_].layout,
            "articles_cited": [],
            "warnings": [],
            "type": type_,
            "type_label": DOC_TYPES[type_].label,
            "model": "claude-sonnet-4-6",
            "usage": {"input_tokens": 0, "output_tokens": 0,
                      "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0},
        }

    monkeypatch.setattr(builder_module, "generate_document", fake_generate)

    r = client.post(
        "/api/generate-document",
        json={"type": doc_type, "params": {"partyA": "A", "partyB": "B"}, "options": {}},
        headers=auth,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["type"] == doc_type
    assert body["layout"] == DOC_TYPES[doc_type].layout
    assert body["document_markdown"].startswith("# ")


def test_endpoint_requires_auth(client):
    r = client.post("/api/generate-document", json={"type": "services", "params": {}})
    assert r.status_code == 401


def test_endpoint_requires_ai_capability(client):
    r = client.post("/api/auth/register", json={
        "name": "A", "email": "a@x.com", "password": "supersecret", "role": "admin",
    })
    token = r.json()["access_token"]
    r2 = client.post(
        "/api/generate-document",
        json={"type": "services", "params": {}},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r2.status_code == 403


def test_endpoint_rejects_unknown_type(client, auth):
    r = client.post(
        "/api/generate-document",
        json={"type": "wedding_vows", "params": {}},
        headers=auth,
    )
    assert r.status_code == 422


def test_endpoint_maps_claude_error_to_502(client, auth, monkeypatch):
    def boom(type_, params, options, conn=None):
        raise ClaudeError("Anthropic authentication failed: bad key")
    monkeypatch.setattr(builder_module, "generate_document", boom)
    r = client.post(
        "/api/generate-document",
        json={"type": "services", "params": {}},
        headers=auth,
    )
    assert r.status_code == 502


def test_endpoint_includes_options_in_call(client, auth, monkeypatch):
    captured = {}

    def fake_generate(type_, params, options, conn=None):
        captured["options"] = options
        return {
            "document_markdown": "x", "layout": "contract", "articles_cited": [],
            "warnings": [], "type": type_, "type_label": "X", "model": "x",
            "usage": {"input_tokens": 0, "output_tokens": 0,
                      "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0},
        }

    monkeypatch.setattr(builder_module, "generate_document", fake_generate)

    r = client.post(
        "/api/generate-document",
        json={"type": "services", "params": {"partyA": "X"},
              "options": {"penalty": True, "nda": False}},
        headers=auth,
    )
    assert r.status_code == 200
    assert captured["options"] == {"penalty": True, "nda": False}


# ---------------------------------------------------------------------------
# Drafts — generic CRUD via /api/drafts
# ---------------------------------------------------------------------------

def test_drafts_list_is_empty_initially(client, auth):
    r = client.get("/api/drafts", headers=auth)
    assert r.status_code == 200
    assert r.json() == []


def test_drafts_create_persists_round_trip(client, auth):
    payload = {
        "typeId": "services",
        "name": "ДОГОВІР про надання послуг — ТОВ Альфа",
        "party": "ТОВ Альфа",
        "documentMarkdown": "# ДОГОВІР…",
        "params": {"partyA": "ТОВ Альфа", "partyB": "ФОП Бета", "amount": "150000"},
        "options": {"penalty": True, "nda": False},
        "createdAt": "2026-06-10T10:00:00",
    }
    r = client.post("/api/drafts", json=payload, headers=auth)
    assert r.status_code == 201, r.text
    created = r.json()
    assert created["id"].startswith("dr-")
    # camelCase aliases round-trip
    assert created["typeId"] == "services"
    assert created["documentMarkdown"].startswith("# ДОГОВІР")
    # JSON columns decode to objects on read
    assert created["params"]["partyA"] == "ТОВ Альфа"
    assert created["options"]["penalty"] is True

    # GET by id
    r2 = client.get(f"/api/drafts/{created['id']}", headers=auth)
    assert r2.status_code == 200
    assert r2.json()["name"].startswith("ДОГОВІР")

    # GET list now has the row
    r3 = client.get("/api/drafts", headers=auth)
    assert r3.status_code == 200
    assert len(r3.json()) == 1


def test_drafts_requires_auth(client):
    r = client.get("/api/drafts")
    assert r.status_code == 401
