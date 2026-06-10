"""Phase 3.2 tests: /api/summary + /api/translate.

Mocked Claude — no network. Mirrors the fixture pattern from
test_contract_analysis.py (in-memory DB + permissions seed + auth fixture).
"""
from __future__ import annotations

import json
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

from backend import assist as assist_module
from backend.assist import (
    TRANSLATE_JSON_SCHEMA,
    generate_summary,
    generate_translation,
)
from backend.claude_client import ClaudeError
from backend.database import get_connection, get_db, init_schema, init_user_schema
from backend.main import app
from backend.models import init_entity_schema
from backend.prompts import (
    SUMMARY_LEGAL_PROMPT,
    SUMMARY_PLAIN_PROMPT,
    TRANSLATE_PROMPT,
)
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
        "name": "Reviewer", "email": "rev@example.com",
        "password": "supersecret", "role": "partner",
    })
    assert r.status_code == 201, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


# ---------------------------------------------------------------------------
# stubs
# ---------------------------------------------------------------------------

def _text_envelope(text: str):
    return SimpleNamespace(
        content=[SimpleNamespace(type="text", text=text)],
        model="claude-sonnet-4-6",
        stop_reason="end_turn",
        usage=SimpleNamespace(
            input_tokens=400, output_tokens=200,
            cache_creation_input_tokens=0, cache_read_input_tokens=0,
        ),
    )


def _fake_anthropic_text(text: str):
    fake = MagicMock()
    fake.messages.create.return_value = _text_envelope(text)
    return fake


def _fake_anthropic_json(payload: dict):
    return _fake_anthropic_text(json.dumps(payload, ensure_ascii=False))


# ---------------------------------------------------------------------------
# generate_summary (mode routing + shape + cache)
# ---------------------------------------------------------------------------

def test_generate_summary_legal_mode_uses_legal_prompt():
    fake = _fake_anthropic_text("## Про договір\n…")
    generate_summary("contract text", "legal", client=fake)
    kwargs = fake.messages.create.call_args.kwargs
    assert kwargs["system"][0]["text"] == SUMMARY_LEGAL_PROMPT
    assert kwargs["system"][0]["cache_control"] == {"type": "ephemeral"}


def test_generate_summary_plain_mode_uses_plain_prompt():
    fake = _fake_anthropic_text("Якщо коротко…")
    generate_summary("contract text", "plain", client=fake)
    kwargs = fake.messages.create.call_args.kwargs
    assert kwargs["system"][0]["text"] == SUMMARY_PLAIN_PROMPT


def test_generate_summary_returns_text_response_shape():
    fake = _fake_anthropic_text("## Про договір\nДоговір про надання послуг…")
    result = generate_summary("contract", "legal", client=fake)
    assert set(result) == {"summary", "mode", "model", "usage"}
    assert result["mode"] == "legal"
    assert result["model"] == "claude-sonnet-4-6"
    assert result["summary"].startswith("## Про договір")
    assert result["usage"]["input_tokens"] == 400


def test_generate_summary_rejects_unknown_mode():
    fake = _fake_anthropic_text("x")
    with pytest.raises(ValueError, match="Unknown summary mode"):
        generate_summary("x", "creative", client=fake)


def test_generate_summary_wraps_anthropic_connection_error():
    import anthropic
    fake = MagicMock()
    err = anthropic.APIConnectionError.__new__(anthropic.APIConnectionError)
    err.message = "connection reset"
    fake.messages.create.side_effect = err
    with pytest.raises(ClaudeError, match="Network"):
        generate_summary("x", "legal", client=fake)


# ---------------------------------------------------------------------------
# generate_translation (schema + shape + parsing)
# ---------------------------------------------------------------------------

def test_generate_translation_call_uses_json_schema():
    fake = _fake_anthropic_json({"pairs": [], "glossary": []})
    generate_translation("contract", "ua_en", client=fake)
    kwargs = fake.messages.create.call_args.kwargs
    assert kwargs["output_config"]["format"]["type"] == "json_schema"
    assert kwargs["output_config"]["format"]["schema"] is TRANSLATE_JSON_SCHEMA
    assert kwargs["system"][0]["text"] == TRANSLATE_PROMPT
    assert kwargs["system"][0]["cache_control"] == {"type": "ephemeral"}


def test_generate_translation_parses_pairs_and_glossary():
    payload = {
        "pairs": [
            {"src": "ТОВ «Северин»", "tgt": "LLC «Severyn»"},
            {"src": "Договір про надання послуг", "tgt": "Services Agreement"},
        ],
        "glossary": [
            {"src": "Замовник", "tgt": "Customer"},
            {"src": "Виконавець", "tgt": "Contractor"},
        ],
    }
    fake = _fake_anthropic_json(payload)
    result = generate_translation("contract", "ua_en", client=fake)
    assert result["direction"] == "ua_en"
    assert result["pairs"] == payload["pairs"]
    assert result["glossary"] == payload["glossary"]


def test_generate_translation_joins_pairs_into_translation_string():
    payload = {
        "pairs": [{"src": "A", "tgt": "Alpha"}, {"src": "B", "tgt": "Beta"}],
        "glossary": [],
    }
    fake = _fake_anthropic_json(payload)
    result = generate_translation("x", "ua_en", client=fake)
    assert result["translation"] == "Alpha\n\nBeta"


def test_generate_translation_raises_on_malformed_json():
    fake = _fake_anthropic_text("definitely not json")
    with pytest.raises(ClaudeError, match="non-JSON"):
        generate_translation("x", "ua_en", client=fake)


def test_generate_translation_rejects_unknown_direction():
    fake = _fake_anthropic_json({"pairs": [], "glossary": []})
    with pytest.raises(ValueError, match="Unknown translate direction"):
        generate_translation("x", "ua_de", client=fake)


def test_generate_translation_en_ua_passes_direction_hint_to_user_turn():
    fake = _fake_anthropic_json({"pairs": [], "glossary": []})
    generate_translation("Hello world", "en_ua", client=fake)
    kwargs = fake.messages.create.call_args.kwargs
    user_content = kwargs["messages"][0]["content"]
    assert "EN → UA" in user_content
    assert "Hello world" in user_content


# ---------------------------------------------------------------------------
# /api/summary endpoint
# ---------------------------------------------------------------------------

def test_summary_endpoint_legal_returns_text(client, auth, monkeypatch):
    captured = {}

    def fake_generate_summary(text, mode):
        captured["text"] = text
        captured["mode"] = mode
        return {
            "summary": "## Про договір\nLegal summary.",
            "mode": mode,
            "model": "claude-sonnet-4-6",
            "usage": {"input_tokens": 100, "output_tokens": 50,
                      "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0},
        }

    monkeypatch.setattr(assist_module, "generate_summary", fake_generate_summary)

    r = client.post(
        "/api/summary",
        json={"contract": "ДОГОВІР…", "mode": "legal"},
        headers=auth,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["summary"].startswith("## Про договір")
    assert body["mode"] == "legal"
    assert captured["text"] == "ДОГОВІР…"


def test_summary_endpoint_requires_auth(client):
    r = client.post("/api/summary", json={"contract": "x"})
    assert r.status_code == 401


def test_summary_endpoint_requires_ai_capability(client):
    r = client.post("/api/auth/register", json={
        "name": "A", "email": "a@x.com", "password": "supersecret", "role": "admin",
    })
    token = r.json()["access_token"]
    r2 = client.post(
        "/api/summary",
        json={"contract": "x"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r2.status_code == 403


def test_summary_endpoint_rejects_empty_body(client, auth):
    r = client.post("/api/summary", json={}, headers=auth)
    assert r.status_code == 400


def test_summary_endpoint_rejects_invalid_mode(client, auth):
    r = client.post(
        "/api/summary",
        json={"contract": "x", "mode": "creative"},
        headers=auth,
    )
    assert r.status_code == 422


def test_summary_endpoint_accepts_sections(client, auth, monkeypatch):
    captured = {}

    def fake_generate_summary(text, mode):
        captured["text"] = text
        return {"summary": "x", "mode": mode, "model": "x",
                "usage": {"input_tokens": 0, "output_tokens": 0,
                          "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0}}

    monkeypatch.setattr(assist_module, "generate_summary", fake_generate_summary)

    r = client.post(
        "/api/summary",
        json={"sections": [
            {"number": "1", "title": "Предмет", "text": "Послуги."},
            {"number": "2", "title": "Ціна", "text": "1000 ₴."},
        ], "mode": "legal"},
        headers=auth,
    )
    assert r.status_code == 200
    assert "Послуги" in captured["text"]
    assert "1000 ₴" in captured["text"]


def test_summary_endpoint_maps_claude_error_to_502(client, auth, monkeypatch):
    def boom(text, mode):
        raise ClaudeError("Anthropic authentication failed: bad key")
    monkeypatch.setattr(assist_module, "generate_summary", boom)
    r = client.post("/api/summary", json={"contract": "x"}, headers=auth)
    assert r.status_code == 502
    assert "authentication" in r.json()["detail"].lower()


# ---------------------------------------------------------------------------
# /api/translate endpoint
# ---------------------------------------------------------------------------

def test_translate_endpoint_ua_en_happy_path(client, auth, monkeypatch):
    def fake_generate_translation(text, direction):
        return {
            "pairs": [{"src": "Замовник", "tgt": "Customer"}],
            "glossary": [{"src": "Договір", "tgt": "Agreement"}],
            "translation": "Customer",
            "direction": direction,
            "model": "claude-sonnet-4-6",
            "usage": {"input_tokens": 50, "output_tokens": 50,
                      "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0},
        }

    monkeypatch.setattr(assist_module, "generate_translation", fake_generate_translation)

    r = client.post(
        "/api/translate",
        json={"text": "Замовник", "direction": "ua_en"},
        headers=auth,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["pairs"][0] == {"src": "Замовник", "tgt": "Customer"}
    assert body["glossary"][0] == {"src": "Договір", "tgt": "Agreement"}
    assert body["translation"] == "Customer"
    assert body["direction"] == "ua_en"


def test_translate_endpoint_requires_auth(client):
    r = client.post("/api/translate", json={"text": "x"})
    assert r.status_code == 401


def test_translate_endpoint_requires_ai_capability(client):
    r = client.post("/api/auth/register", json={
        "name": "A", "email": "a@x.com", "password": "supersecret", "role": "admin",
    })
    token = r.json()["access_token"]
    r2 = client.post(
        "/api/translate",
        json={"text": "x"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r2.status_code == 403


def test_translate_endpoint_validates_direction(client, auth):
    r = client.post(
        "/api/translate",
        json={"text": "x", "direction": "ua_de"},
        headers=auth,
    )
    assert r.status_code == 422


def test_translate_endpoint_rejects_empty_body(client, auth):
    r = client.post("/api/translate", json={"direction": "ua_en"}, headers=auth)
    assert r.status_code == 400


def test_translate_endpoint_maps_claude_error_to_502(client, auth, monkeypatch):
    def boom(text, direction):
        raise ClaudeError("Network error contacting Anthropic")
    monkeypatch.setattr(assist_module, "generate_translation", boom)
    r = client.post("/api/translate", json={"text": "x"}, headers=auth)
    assert r.status_code == 502
    assert "network" in r.json()["detail"].lower()
