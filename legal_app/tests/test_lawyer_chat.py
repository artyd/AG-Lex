"""Tests for /api/lawyer-chat (AI lawyer assistant).

Mirrors the fixture pattern from test_assist.py — in-memory DB, permissions
seed, partner-role auth token. Anthropic SDK is stubbed; hybrid_search is
monkeypatched so we don't need a real codex.
"""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

from backend import lawyer_chat as lc_module
from backend.database import get_connection, get_db, init_schema, init_user_schema
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
        "name": "Senior Counsel", "email": "sc@example.com",
        "password": "supersecret", "role": "partner",
    })
    assert r.status_code == 201, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


# ---------------------------------------------------------------------------
# stubs
# ---------------------------------------------------------------------------

_FAKE_ARTICLE = {
    "id": 1,
    "article_number": "651",
    "title": "Підстави для зміни або розірвання договору",
    "content": "Зміна або розірвання договору допускається лише за згодою сторін, "
               "якщо інше не встановлено договором або законом.",
    "source": "ЦКУ",
    "score": 0.91,
}


def _stub_search(monkeypatch, articles=None):
    """Make hybrid_search return a deterministic single hit."""
    rows = articles if articles is not None else [_FAKE_ARTICLE]
    monkeypatch.setattr(
        lc_module, "hybrid_search",
        lambda *a, **kw: rows,
    )


def _stub_claude(text: str, monkeypatch):
    """Make `_client()` return a MagicMock that mimics the Anthropic SDK."""
    fake = MagicMock()
    fake.messages.create.return_value = SimpleNamespace(
        content=[SimpleNamespace(type="text", text=text)],
        model="claude-sonnet-4-6",
        stop_reason="end_turn",
        usage=SimpleNamespace(
            input_tokens=120, output_tokens=80,
            cache_creation_input_tokens=2048, cache_read_input_tokens=0,
        ),
    )
    monkeypatch.setattr(lc_module, "_client", lambda: fake)
    return fake


# ---------------------------------------------------------------------------
# unit: chat()
# ---------------------------------------------------------------------------

def test_chat_returns_answer_cited_articles_usage(monkeypatch):
    _stub_search(monkeypatch)
    _stub_claude(
        "**Розірвати можна лише за згодою сторін.** За загальним правилом це "
        "встановлено (ст. 651 ЦКУ).\n\nЩо робити:\n1. Перевірте договір.\n"
        "2. Надішліть пропозицію.",
        monkeypatch,
    )

    result = lc_module.chat("Чи можна розірвати договір?")

    assert "Розірвати можна" in result["answer"]
    assert result["cited_articles"] == [
        {"article_number": "651", "title": _FAKE_ARTICLE["title"],
         "source": "ЦКУ", "score": 0.91},
    ]
    assert result["warnings"] == []
    assert result["usage"]["cache_creation_input_tokens"] == 2048
    assert result["model"] == "claude-sonnet-4-6"


def test_chat_flags_fabricated_citations(monkeypatch):
    _stub_search(monkeypatch)
    # Claude cites ст. 999 which was NOT in the retrieved set → warning.
    _stub_claude(
        "Розірвати не можна (ст. 999 ЦКУ).", monkeypatch,
    )
    result = lc_module.chat("Можна розірвати?")
    assert result["warnings"], "Hallucinated citation must trigger a warning"
    assert "999" in result["warnings"][0]


def test_chat_history_clipped_and_normalised(monkeypatch):
    _stub_search(monkeypatch)
    fake = _stub_claude("Так, можна.", monkeypatch)

    # 10 prior turns, alternating roles. Server clips to MAX_HISTORY_TURNS=6
    # AND drops the trailing user turn so the new question slots in cleanly.
    history = []
    for i in range(10):
        history.append({"role": "user" if i % 2 == 0 else "assistant",
                        "text": f"turn {i}"})

    lc_module.chat("Latest question?", history=history)

    sent = fake.messages.create.call_args.kwargs
    msgs = sent["messages"]
    # Last message must always be the new user question
    assert msgs[-1] == {"role": "user", "content": "Latest question?"}
    # History contribution capped — no more than MAX_HISTORY_TURNS prior turns
    assert len(msgs) - 1 <= lc_module.MAX_HISTORY_TURNS
    # First history message must be a user turn (Anthropic requirement)
    assert msgs[0]["role"] == "user"


def test_chat_no_hits_still_answers(monkeypatch):
    _stub_search(monkeypatch, articles=[])
    fake = _stub_claude("Чесна відповідь без посилань.", monkeypatch)

    result = lc_module.chat("Незвичайне питання")

    assert result["cited_articles"] == []
    assert result["warnings"] == []
    # The "no relevant articles" sentinel should be in the system payload so
    # the model knows not to invent citations.
    system_payload = fake.messages.create.call_args.kwargs["system"]
    no_hit_block = system_payload[1]["text"]
    assert "не знайдено" in no_hit_block


# ---------------------------------------------------------------------------
# integration: HTTP route
# ---------------------------------------------------------------------------

def test_endpoint_requires_auth(client):
    r = client.post("/api/lawyer-chat", json={"question": "test"})
    assert r.status_code == 401


def test_endpoint_happy_path(client, auth, monkeypatch):
    _stub_search(monkeypatch)
    _stub_claude("**Можна.** (ст. 651 ЦКУ)", monkeypatch)

    r = client.post(
        "/api/lawyer-chat",
        json={"question": "Чи можна розірвати?", "history": []},
        headers=auth,
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert "Можна" in data["answer"]
    assert data["cited_articles"][0]["article_number"] == "651"
    assert data["usage"]["cache_creation_input_tokens"] == 2048


def test_endpoint_validates_request_body(client, auth):
    # Empty question — pydantic rejects (min_length=1).
    r = client.post("/api/lawyer-chat", json={"question": ""}, headers=auth)
    assert r.status_code == 422

    # History over 8k chars per turn — rejected.
    r = client.post(
        "/api/lawyer-chat",
        json={"question": "ok", "history": [
            {"role": "user", "text": "x" * 9000},
        ]},
        headers=auth,
    )
    assert r.status_code == 422


def test_endpoint_claude_error_becomes_502(client, auth, monkeypatch):
    _stub_search(monkeypatch)

    def _boom():
        raise lc_module.ClaudeError("upstream down")
    monkeypatch.setattr(lc_module, "_client", _boom)

    r = client.post(
        "/api/lawyer-chat",
        json={"question": "test"}, headers=auth,
    )
    assert r.status_code == 502
    assert "upstream down" in r.json()["detail"]
