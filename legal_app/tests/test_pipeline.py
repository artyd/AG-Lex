"""Phase 1.5 tests: RAG pipeline (search → Claude → citation check)."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from backend import main, pipeline
from backend.claude_client import ClaudeError
from backend.main import app
from backend.pipeline import analyze, validate_citations


# ---------------------------------------------------------------------------
# fixtures
# ---------------------------------------------------------------------------

PROVIDED = [
    {"id": 1, "article_number": "Стаття 651", "title": "Підстави для розірвання",
     "content": "...", "source": "ЦКУ", "score": 0.9},
    {"id": 2, "article_number": "Стаття 652", "title": "Істотна зміна обставин",
     "content": "...", "source": "ЦКУ", "score": 0.8},
    {"id": 3, "article_number": "Article 17", "title": "Right to erasure",
     "content": "...", "source": "EU_GDPR", "score": 0.7},
]


def _claude_stub(answer: str = "За статтею 651 ЦКУ розірвання можливе."):
    return {
        "answer": answer,
        "model": "claude-sonnet-4-6",
        "stop_reason": "end_turn",
        "usage": {
            "input_tokens": 1000,
            "output_tokens": 200,
            "cache_creation_input_tokens": 0,
            "cache_read_input_tokens": 0,
        },
    }


# ---------------------------------------------------------------------------
# validate_citations
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("answer,expected_num", [
    ("Відповідно до ст. 651 ЦКУ договір може бути розірвано.", "651"),
    ("Згідно зі статтею 651, розірвання можливе.", "651"),
    ("Як зазначено у статті 651 ЦКУ, ...", "651"),
    ("Сторона може посилатися на статтю 651.", "651"),
    ("Застосовується статтею 651 ЦКУ.", "651"),
    ("Див. ст.651 (без пробілу).", "651"),
])
def test_validate_citations_finds_ua_forms(answer, expected_num):
    warnings = validate_citations(answer, PROVIDED)
    assert warnings == [], f"Should have grounded {expected_num} via {answer!r}"


@pytest.mark.parametrize("answer", [
    "Per Article 17 GDPR, the data subject may request erasure.",
    "Art. 17 GDPR establishes the right to erasure.",
    "ARTICLE 17 — Right to erasure.",
])
def test_validate_citations_finds_en_forms(answer):
    warnings = validate_citations(answer, PROVIDED)
    assert warnings == [], f"Should have grounded Article 17 via {answer!r}"


def test_validate_citations_empty_when_all_grounded():
    answer = "За статтею 651 ЦКУ та Article 17 GDPR, розірвання можливе."
    assert validate_citations(answer, PROVIDED) == []


def test_validate_citations_flags_invented_number():
    answer = "Згідно зі статтею 9999 ЦКУ, розірвання неможливе."
    warnings = validate_citations(answer, PROVIDED)
    assert len(warnings) == 1
    assert "9999" in warnings[0]
    assert "галюцинація" in warnings[0]


def test_validate_citations_flags_each_invented_only_once():
    answer = "За ст. 9999, та статтею 9999, та ще раз ст.9999 ..."
    warnings = validate_citations(answer, PROVIDED)
    assert len(warnings) == 1


def test_validate_citations_handles_compound_numbers():
    provided = [{"article_number": "Стаття 651-1", "source": "ЦКУ"}]
    answer = "Відповідно до ст. 651-1 ЦКУ ..."
    assert validate_citations(answer, provided) == []


def test_validate_citations_mixed_some_grounded_some_invented():
    answer = "За ст. 651 ЦКУ та ст. 9999 ЦКУ, наслідки такі..."
    warnings = validate_citations(answer, PROVIDED)
    assert len(warnings) == 1
    assert "9999" in warnings[0]


def test_validate_citations_empty_answer_returns_empty():
    assert validate_citations("", PROVIDED) == []


# ---------------------------------------------------------------------------
# analyze orchestration
# ---------------------------------------------------------------------------

def test_analyze_uses_question_only_when_no_section(monkeypatch):
    captured = {}
    def fake_search(query, **kwargs):
        captured["query"] = query
        captured["kwargs"] = kwargs
        return PROVIDED
    def fake_ask(question, articles, section, **_):
        return _claude_stub()
    monkeypatch.setattr(pipeline, "hybrid_search", fake_search)
    monkeypatch.setattr(pipeline, "ask_claude", fake_ask)

    analyze("Чи правомірне розірвання?")
    assert captured["query"] == "Чи правомірне розірвання?"


def test_analyze_includes_section_text_in_search_query(monkeypatch):
    captured = {}
    monkeypatch.setattr(pipeline, "hybrid_search",
                        lambda q, **kw: (captured.setdefault("q", q), PROVIDED)[1])
    monkeypatch.setattr(pipeline, "ask_claude",
                        lambda *a, **kw: _claude_stub())

    section = {"number": "Стаття 5", "title": "Розірвання",
               "text": "Сторони мають право розірвати договір."}
    analyze("Чи правомірно?", contract_section=section)

    assert "Чи правомірно?" in captured["q"]
    assert "Сторони мають право розірвати договір." in captured["q"]


def test_analyze_truncates_long_section_text_in_search_query(monkeypatch):
    captured = {}
    monkeypatch.setattr(pipeline, "hybrid_search",
                        lambda q, **kw: (captured.setdefault("q", q), PROVIDED)[1])
    monkeypatch.setattr(pipeline, "ask_claude",
                        lambda *a, **kw: _claude_stub())

    long_text = "Дуже довгий текст. " * 200
    analyze("Q?", contract_section={"text": long_text})

    # Should be capped to <= question + truncate budget + some glue.
    assert len(captured["q"]) <= len("Q?") + 1000 + 10


def test_analyze_forwards_sources_filter_to_search(monkeypatch):
    captured = {}
    def fake_search(query, source=None, limit=5, **kwargs):
        captured["source"] = source
        captured["limit"] = limit
        return PROVIDED
    monkeypatch.setattr(pipeline, "hybrid_search", fake_search)
    monkeypatch.setattr(pipeline, "ask_claude", lambda *a, **kw: _claude_stub())

    analyze("Q?", sources=["ЦКУ", "ГКУ"], limit=10)
    assert captured["source"] == ["ЦКУ", "ГКУ"]
    assert captured["limit"] == 10


def test_analyze_forwards_contract_section_to_ask_claude(monkeypatch):
    captured = {}
    def fake_ask(question, articles, contract_section, **_):
        captured["section"] = contract_section
        captured["articles_count"] = len(articles)
        return _claude_stub()
    monkeypatch.setattr(pipeline, "hybrid_search", lambda *a, **kw: PROVIDED)
    monkeypatch.setattr(pipeline, "ask_claude", fake_ask)

    section = {"number": "Стаття 5", "text": "Body"}
    analyze("Q?", contract_section=section)
    assert captured["section"] == section
    assert captured["articles_count"] == 3


def test_analyze_response_shape(monkeypatch):
    monkeypatch.setattr(pipeline, "hybrid_search", lambda *a, **kw: PROVIDED)
    monkeypatch.setattr(pipeline, "ask_claude", lambda *a, **kw: _claude_stub())

    result = analyze("Q?")
    assert set(result) == {"answer", "used_articles", "warnings", "usage", "model"}
    assert result["model"] == "claude-sonnet-4-6"
    assert isinstance(result["warnings"], list)

    used = result["used_articles"]
    assert len(used) == 3
    assert set(used[0]) == {"article_number", "title", "source", "score"}
    # Content/id stripped so response stays small.
    assert "content" not in used[0]
    assert "id" not in used[0]


def test_analyze_warnings_populated_when_claude_invents_article(monkeypatch):
    monkeypatch.setattr(pipeline, "hybrid_search", lambda *a, **kw: PROVIDED)
    monkeypatch.setattr(pipeline, "ask_claude",
                        lambda *a, **kw: _claude_stub(answer="За ст. 9999 ЦКУ — не можна."))

    result = analyze("Q?")
    assert len(result["warnings"]) == 1
    assert "9999" in result["warnings"][0]


def test_analyze_warnings_empty_when_answer_is_grounded(monkeypatch):
    monkeypatch.setattr(pipeline, "hybrid_search", lambda *a, **kw: PROVIDED)
    monkeypatch.setattr(pipeline, "ask_claude",
                        lambda *a, **kw: _claude_stub(answer="За ст. 651 ЦКУ — можна."))

    result = analyze("Q?")
    assert result["warnings"] == []


# ---------------------------------------------------------------------------
# /api/analyze route
# ---------------------------------------------------------------------------
# Phase 2.3 gates /api/analyze behind `require("ai")`, which means the route
# now needs (a) a valid bearer token and (b) the user's role to have `ai`
# allowed in the permissions matrix. The fixture below sets up both against
# an in-memory DB so tests stay hermetic.

@pytest.fixture
def client():
    from backend.database import get_connection, get_db, init_user_schema
    from backend.rbac import init_permissions_schema, seed_default_permissions

    conn = get_connection(":memory:", check_same_thread=False)
    init_user_schema(conn)
    init_permissions_schema(conn)
    seed_default_permissions(conn)

    def _override():
        yield conn

    app.dependency_overrides[get_db] = _override
    try:
        with TestClient(app) as c:
            yield c
    finally:
        app.dependency_overrides.pop(get_db, None)
        conn.close()


@pytest.fixture
def auth(client):
    """Register a `partner` (defaults grant `ai`) and return `{Authorization: Bearer …}`."""
    r = client.post("/api/auth/register", json={
        "name": "Reviewer", "email": "reviewer@example.com",
        "password": "supersecret", "role": "partner",
    })
    assert r.status_code == 201, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


def test_api_analyze_returns_pipeline_result(client, auth, monkeypatch):
    def fake_analyze(question, contract_section=None, sources=None, **_):
        return {
            "answer": "За ст. 651 ЦКУ розірвання можливе.",
            "used_articles": [{"article_number": "Стаття 651", "title": "...",
                               "source": "ЦКУ", "score": 0.9}],
            "warnings": [],
            "usage": {"input_tokens": 100, "output_tokens": 50,
                      "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0},
            "model": "claude-sonnet-4-6",
        }
    monkeypatch.setattr(main, "analyze", fake_analyze)

    r = client.post("/api/analyze", json={"question": "Чи правомірне розірвання?"}, headers=auth)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["answer"].startswith("За ст. 651")
    assert body["used_articles"][0]["article_number"] == "Стаття 651"
    assert body["warnings"] == []


def test_api_analyze_rejects_empty_question(client, auth):
    r = client.post("/api/analyze", json={"question": ""}, headers=auth)
    assert r.status_code == 422


def test_api_analyze_maps_claude_error_to_502(client, auth, monkeypatch):
    def boom(*a, **kw):
        raise ClaudeError("Anthropic authentication failed — check API_KEY")
    monkeypatch.setattr(main, "analyze", boom)

    r = client.post("/api/analyze", json={"question": "Q?"}, headers=auth)
    assert r.status_code == 502
    assert "authentication" in r.json()["detail"].lower()


def test_api_analyze_accepts_contract_section_and_sources(client, auth, monkeypatch):
    captured = {}
    def fake_analyze(**kw):
        captured.update(kw)
        return {"answer": "ok", "used_articles": [], "warnings": [],
                "usage": {"input_tokens": 0, "output_tokens": 0,
                          "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0},
                "model": "x"}
    monkeypatch.setattr(main, "analyze", fake_analyze)

    r = client.post("/api/analyze", json={
        "question": "Q?",
        "contract_section": {"number": "Стаття 5", "text": "Body"},
        "sources": ["ЦКУ", "ГКУ"],
    }, headers=auth)
    assert r.status_code == 200
    assert captured["contract_section"] == {"number": "Стаття 5", "text": "Body"}
    assert captured["sources"] == ["ЦКУ", "ГКУ"]


def test_api_analyze_requires_authentication(client):
    r = client.post("/api/analyze", json={"question": "Q?"})
    assert r.status_code == 401


def test_api_analyze_requires_ai_capability(client, monkeypatch):
    """A role without `ai` should get 403 even with a valid token."""
    from backend.database import get_db
    # The override fixture's conn is the same `get_db` returns to routes.
    override = app.dependency_overrides[get_db]
    conn = next(override())
    # admin's default has `ai: False`
    conn.execute(
        "INSERT INTO permissions(capability, role, allowed) VALUES('ai','admin',0) "
        "ON CONFLICT DO UPDATE SET allowed=0"
    )
    conn.commit()

    r = client.post("/api/auth/register", json={
        "name": "A", "email": "a@example.com", "password": "supersecret", "role": "admin",
    })
    token = r.json()["access_token"]
    r2 = client.post("/api/analyze", json={"question": "Q?"},
                     headers={"Authorization": f"Bearer {token}"})
    assert r2.status_code == 403
    assert "ai" in r2.json()["detail"].lower()
