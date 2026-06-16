"""Phase 3.1 tests: per-contract risk analysis.

Claude is stubbed via the injectable `client` arg + a Magic-like fake. We
cover the deterministic helpers (score, legal-basis, citation validation) with
real DB rows; the structured-output Claude call is exercised against a fake
that returns the JSON envelope the real API would.
"""
from __future__ import annotations

import json
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

from backend import contract_analysis as ca
from backend.contract_analysis import (
    CONTRACT_ANALYSIS_JSON_SCHEMA,
    analyze_contract,
    build_legal_basis,
    compute_score,
    generate_findings,
    validate_law_citations,
)
from backend.database import get_connection, get_db, init_user_schema
from backend.main import app
from backend.models import init_entity_schema
from backend.database import init_schema
from backend.rbac import init_permissions_schema, seed_default_permissions


# ---------------------------------------------------------------------------
# fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def db_conn():
    conn = get_connection(":memory:", check_same_thread=False)
    init_schema(conn)            # articles + FTS5
    init_user_schema(conn)
    init_entity_schema(conn)
    init_permissions_schema(conn)
    seed_default_permissions(conn)
    yield conn
    conn.close()


@pytest.fixture
def db_with_codex(db_conn):
    """Same as `db_conn` plus a handful of seeded articles for citation tests."""
    db_conn.executemany(
        "INSERT INTO articles (article_number, title, content, source) VALUES (?, ?, ?, ?)",
        [
            ("Стаття 651", "Підстави для розірвання", "...", "ЦКУ"),
            ("Стаття 693", "Аванс", "...", "ЦКУ"),
            ("Стаття 906", "Відповідальність", "...", "ЦКУ"),
            ("Стаття 907", "Розірвання договору про надання послуг", "...", "ЦКУ"),
            ("Article 17", "Right to erasure", "...", "EU_GDPR"),
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
        "name": "Reviewer", "email": "rev@example.com",
        "password": "supersecret", "role": "partner",
    })
    assert r.status_code == 201, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


# Canonical findings array used across tests (mirrors DEMO.findings shape).
SAMPLE_FINDINGS = [
    {
        "id": "f-prepay", "level": "high", "clause": "п. 2.3", "weight": 12,
        "title": "100% безповоротна передоплата",
        "desc": "Повна передоплата без права повернення.",
        "severity": "Критично для Замовника",
        "law": "ст. 693 ЦК України",
        "suggest": {"from": "Сплачена передоплата поверненню не підлягає",
                    "to": "Оплата здійснюється поетапно: 30% / 70%."},
    },
    {
        "id": "f-liability", "level": "high", "clause": "п. 5.2", "weight": 12,
        "title": "Відповідальність обмежена 50 000 ₴",
        "desc": "Ліміт неспівмірний із можливими збитками.",
        "severity": "Критично для Замовника",
        "law": "ст. 906 ЦК України",
        "suggest": {"from": "обмежується сумою 50 000 гривень",
                    "to": "обмежується загальною вартістю послуг."},
    },
    {
        "id": "f-renew", "level": "med", "clause": "п. 7.2", "weight": 5,
        "title": "Автоматична пролонгація",
        "desc": "Тривале вікно повідомлення.",
        "severity": "Потребує контролю строків",
        "law": "ст. 631 ЦК України",  # not in db_with_codex → expected hallucination warning
        "suggest": {"from": "за 60 днів", "to": "за 30 днів"},
    },
]

SAMPLE_COMPARISON = [
    {"clause": "Предмет договору", "status": "warn", "note": "Без додатку"},
    {"clause": "Ціна", "status": "deviate", "note": "100% передоплата"},
    {"clause": "Розірвання", "status": "deviate", "note": "Обмежує замовника"},
]


def _claude_envelope(payload: dict):
    """Mimic an Anthropic Message object exposing .content[0].text + usage/model."""
    return SimpleNamespace(
        content=[SimpleNamespace(type="text", text=json.dumps(payload, ensure_ascii=False))],
        model="claude-sonnet-4-6",
        stop_reason="end_turn",
        usage=SimpleNamespace(
            input_tokens=1000, output_tokens=500,
            cache_creation_input_tokens=0, cache_read_input_tokens=0,
        ),
    )


def _fake_anthropic_client(payload: dict):
    fake = MagicMock()
    fake.messages.create.return_value = _claude_envelope(payload)
    return fake


# ---------------------------------------------------------------------------
# JSON schema sanity (catches drift from spec §7.1 shape)
# ---------------------------------------------------------------------------

def test_schema_locks_finding_required_fields():
    finding_props = CONTRACT_ANALYSIS_JSON_SCHEMA["properties"]["findings"]["items"]
    assert set(finding_props["required"]) == {
        "id", "level", "clause", "weight", "title", "desc", "severity", "law", "suggest",
    }
    assert finding_props["properties"]["level"]["enum"] == ["high", "med", "low"]
    assert finding_props["properties"]["suggest"]["required"] == ["from", "to"]


def test_schema_locks_comparison_required_fields():
    cmp_props = CONTRACT_ANALYSIS_JSON_SCHEMA["properties"]["comparison"]["items"]
    assert set(cmp_props["required"]) == {"clause", "status", "note"}
    assert cmp_props["properties"]["status"]["enum"] == ["ok", "warn", "deviate", "missing"]


# ---------------------------------------------------------------------------
# compute_score
# ---------------------------------------------------------------------------

def test_compute_score_aggregates_weights_and_buckets():
    score = compute_score(SAMPLE_FINDINGS)
    assert score["risks"] == {"high": 2, "med": 1, "low": 0}
    # weights 12 + 12 + 5 = 29 → value = 71 → "Помірний ризик"
    assert score["value"] == 71
    assert score["label"] == "Помірний ризик"


def test_compute_score_clamps_to_zero_on_large_weight():
    findings = [{"level": "high", "weight": 150}]
    assert compute_score(findings)["value"] == 0


def test_compute_score_label_thresholds():
    assert compute_score([])["label"] == "Низький ризик"
    assert compute_score([{"level": "med", "weight": 30}])["label"] == "Помірний ризик"
    assert compute_score([{"level": "high", "weight": 60}])["label"] == "Високий ризик"


# ---------------------------------------------------------------------------
# build_legal_basis
# ---------------------------------------------------------------------------

def test_build_legal_basis_maps_citations_to_codex_rows(db_with_codex):
    basis = build_legal_basis(db_with_codex, SAMPLE_FINDINGS)
    codes = {b["code"] for b in basis}
    assert "ЦКУ" in codes
    # f-renew cites 631 which is NOT in the codex → not in basis (gets a warning instead)
    refs = " ".join(b["ref"] for b in basis)
    assert "Стаття 693" in refs
    assert "Стаття 906" in refs
    assert "Стаття 631" not in refs


def test_build_legal_basis_dedupes_repeated_citations(db_with_codex):
    findings = [
        {"law": "ст. 651 ЦК"}, {"law": "ст. 651 ЦК"}, {"law": "ст. 651"},
    ]
    basis = build_legal_basis(db_with_codex, findings)
    assert len(basis) == 1
    assert "Стаття 651" in basis[0]["ref"]


def test_build_legal_basis_tags_eu_scope(db_with_codex):
    findings = [{"law": "Article 17 GDPR"}]
    basis = build_legal_basis(db_with_codex, findings)
    assert basis and basis[0]["scope"] == "EU"
    assert basis[0]["code"] == "EU_GDPR"


# ---------------------------------------------------------------------------
# validate_law_citations
# ---------------------------------------------------------------------------

def test_validate_citations_flags_articles_not_in_codex(db_with_codex):
    warnings = validate_law_citations(db_with_codex, SAMPLE_FINDINGS)
    # 631 is the one missing from the fixture.
    assert any("631" in w for w in warnings)
    # 693 and 906 are present.
    assert not any("693" in w for w in warnings)
    assert not any("906" in w for w in warnings)


def test_validate_citations_returns_empty_when_all_grounded(db_with_codex):
    findings = [{"law": "ст. 651 ЦК"}, {"law": "Article 17 GDPR"}]
    assert validate_law_citations(db_with_codex, findings) == []


def test_validate_citations_degrades_gracefully_when_codex_empty(db_conn):
    # `db_conn` has the articles table but no rows seeded.
    warnings = validate_law_citations(db_conn, SAMPLE_FINDINGS)
    assert len(warnings) == 1
    assert "порожня" in warnings[0]


# ---------------------------------------------------------------------------
# generate_findings (Claude stub)
# ---------------------------------------------------------------------------

def test_generate_findings_parses_structured_output():
    fake = _fake_anthropic_client({"findings": SAMPLE_FINDINGS, "comparison": SAMPLE_COMPARISON})
    result = generate_findings("contract text", client=fake)
    assert [f["id"] for f in result["findings"]] == ["f-prepay", "f-liability", "f-renew"]
    # Every finding gets the canonical kind: "risk" tag.
    assert all(f["kind"] == "risk" for f in result["findings"])
    assert result["comparison"] == SAMPLE_COMPARISON
    assert result["model"] == "claude-sonnet-4-6"
    assert result["usage"]["input_tokens"] == 1000


def test_generate_findings_normalises_missing_fields():
    fake = _fake_anthropic_client({
        "findings": [{"level": "high", "clause": "п. 1"}],  # most fields missing
        "comparison": [],
    })
    out = generate_findings("x", client=fake)
    f = out["findings"][0]
    assert f["kind"] == "risk"
    assert f["weight"] == 0
    assert f["suggest"] == {"from": "", "to": ""}


def test_generate_findings_raises_clean_error_on_malformed_json():
    from backend.claude_client import ClaudeError

    fake = MagicMock()
    fake.messages.create.return_value = SimpleNamespace(
        content=[SimpleNamespace(type="text", text="not json at all")],
        model="claude-sonnet-4-6", stop_reason="end_turn",
        usage=SimpleNamespace(input_tokens=0, output_tokens=0,
                              cache_creation_input_tokens=0, cache_read_input_tokens=0),
    )
    with pytest.raises(ClaudeError, match="non-JSON"):
        generate_findings("x", client=fake)


def test_generate_findings_call_uses_structured_output_format():
    fake = _fake_anthropic_client({"findings": [], "comparison": []})
    generate_findings("contract", client=fake)
    kwargs = fake.messages.create.call_args.kwargs
    assert kwargs["output_config"]["format"]["type"] == "json_schema"
    assert kwargs["output_config"]["format"]["schema"] is CONTRACT_ANALYSIS_JSON_SCHEMA


def test_generate_findings_caches_system_prompt():
    fake = _fake_anthropic_client({"findings": [], "comparison": []})
    generate_findings("contract", client=fake)
    system = fake.messages.create.call_args.kwargs["system"]
    assert system[0]["cache_control"] == {"type": "ephemeral"}


def test_schema_requires_summary_keydata_missing():
    """PR-2: the structured-output schema now bundles the three former
    demo-only AiPanel tabs into the same response. Required keys ensure
    Claude can't silently drop them."""
    required = set(CONTRACT_ANALYSIS_JSON_SCHEMA.get("required") or [])
    assert {"summary", "keyData", "missing"} <= required
    keydata_props = CONTRACT_ANALYSIS_JSON_SCHEMA["properties"]["keyData"]["items"]["properties"]
    icon_enum = set(keydata_props["icon"]["enum"])
    # Icons must subset what src/ui/Icon.jsx actually renders — anything else
    # produces a blank icon slot in the UI.
    assert {"building", "coins", "calendar", "doc", "pay"} <= icon_enum


def test_generate_findings_extracts_summary_keydata_missing():
    fake = _fake_anthropic_client({
        "findings": [],
        "comparison": [],
        "summary": "Short summary of the contract.",
        "keyData": [
            {"label": "Сторона А", "value": "ТОВ Тест", "sub": "Київ", "icon": "building"},
            {"label": "Сума", "value": "100 000 ₴", "sub": "", "icon": "coins"},
        ],
        "missing": [
            {"title": "Форс-мажор", "note": "Відсутній розділ.", "law": "ст. 617 ЦК"},
        ],
    })
    result = generate_findings("contract", client=fake)
    assert result["summary"] == "Short summary of the contract."
    assert len(result["keyData"]) == 2
    assert result["keyData"][0]["icon"] == "building"
    assert len(result["missing"]) == 1
    assert result["missing"][0]["law"] == "ст. 617 ЦК"


def test_mock_contract_analysis_shape_matches_real_response():
    """Mock-mode response must include the same top-level keys as the real
    analyzer, otherwise AiPanel renders inconsistent UI between dev (mock)
    and prod (real Claude). Guards against the easy mistake of extending the
    real path without updating the fixture."""
    from backend.mock_ai import mock_contract_analysis
    mock = mock_contract_analysis()
    expected_keys = {
        "findings", "comparison", "legal_basis", "score", "warnings",
        "summary", "keyData", "missing", "usage", "model",
    }
    assert expected_keys <= set(mock)
    assert isinstance(mock["summary"], str) and len(mock["summary"]) > 0
    assert isinstance(mock["keyData"], list) and len(mock["keyData"]) > 0
    assert isinstance(mock["missing"], list)
    # Every mock icon must be in the schema enum.
    from backend.contract_analysis import _KEYDATA_ICON_ENUM
    for d in mock["keyData"]:
        assert d["icon"] in _KEYDATA_ICON_ENUM, f"bad mock icon: {d['icon']}"


def test_normalise_keydata_drops_invalid_icon():
    """The Claude schema enforces enum at request time, but defensive
    normalisation catches anything that slips through (e.g. cached old
    responses). Invalid icon → empty string so the FE renders no glyph
    instead of a broken slot."""
    fake = _fake_anthropic_client({
        "findings": [],
        "comparison": [],
        "summary": "",
        "keyData": [
            {"label": "X", "value": "Y", "sub": "Z", "icon": "balance-scale-fa"},
        ],
        "missing": [],
    })
    result = generate_findings("contract", client=fake)
    assert result["keyData"][0]["icon"] == ""


# ---------------------------------------------------------------------------
# analyze_contract orchestration
# ---------------------------------------------------------------------------

def test_analyze_contract_returns_full_response_shape(db_with_codex):
    fake = _fake_anthropic_client({"findings": SAMPLE_FINDINGS, "comparison": SAMPLE_COMPARISON})
    result = analyze_contract("contract text", conn=db_with_codex, client=fake)
    # PR-2 of analyze-unification adds summary / keyData / missing so AiPanel
    # stops rendering DEMO data for those three tabs on real analyses.
    assert set(result) == {
        "findings", "comparison", "legal_basis", "score", "warnings",
        "summary", "keyData", "missing", "usage", "model",
    }
    assert len(result["findings"]) == 3
    assert result["score"]["value"] == 71
    assert any("631" in w for w in result["warnings"])
    assert any(b["code"] == "ЦКУ" for b in result["legal_basis"])
    # The fake Claude response in SAMPLE_* didn't include the new keys, so
    # the normalisers default them to empty — that's the safety net the FE
    # also relies on.
    assert result["summary"] == ""
    assert result["keyData"] == []
    assert result["missing"] == []


# ---------------------------------------------------------------------------
# /api/analyze/contract endpoint
# ---------------------------------------------------------------------------

def test_endpoint_requires_authentication(client):
    r = client.post("/api/analyze/contract", json={"markdown": "x"})
    assert r.status_code == 401


def test_endpoint_requires_ai_capability(client, db_with_codex):
    # admin's default has ai=False
    r = client.post("/api/auth/register", json={
        "name": "A", "email": "a@x.com", "password": "supersecret", "role": "admin",
    })
    token = r.json()["access_token"]
    r2 = client.post(
        "/api/analyze/contract",
        json={"markdown": "x"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r2.status_code == 403


def test_endpoint_returns_full_response(client, auth, monkeypatch):
    from backend import main as main_module

    captured = {}

    def fake_analyze_contract(text, conn=None):
        captured["text"] = text
        return {
            "findings": SAMPLE_FINDINGS,
            "comparison": SAMPLE_COMPARISON,
            "legal_basis": [{"code": "ЦКУ", "ref": "Стаття 693", "scope": "UA"}],
            "score": {"value": 71, "label": "Помірний ризик", "risks": {"high": 2, "med": 1, "low": 0}},
            "warnings": [],
            "usage": {"input_tokens": 100, "output_tokens": 50,
                      "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0},
            "model": "claude-sonnet-4-6",
        }

    monkeypatch.setattr(main_module, "analyze_contract", fake_analyze_contract)

    r = client.post(
        "/api/analyze/contract",
        json={"markdown": "## п. 2.3\nПередоплата..."},
        headers=auth,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert len(body["findings"]) == 3
    assert body["score"]["value"] == 71
    assert captured["text"].startswith("## п. 2.3")


def test_endpoint_accepts_sections_instead_of_markdown(client, auth, monkeypatch):
    from backend import main as main_module

    captured = {}

    def fake_analyze_contract(text, conn=None):
        captured["text"] = text
        return {
            "findings": [], "comparison": [], "legal_basis": [],
            "score": {"value": 100, "label": "Низький ризик", "risks": {"high": 0, "med": 0, "low": 0}},
            "warnings": [], "usage": {"input_tokens": 0, "output_tokens": 0,
                                       "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0},
            "model": "claude-sonnet-4-6",
        }

    monkeypatch.setattr(main_module, "analyze_contract", fake_analyze_contract)

    r = client.post(
        "/api/analyze/contract",
        json={"sections": [
            {"number": "п. 2.3", "title": "Передоплата", "text": "100% передоплата."},
            {"number": "п. 5.2", "title": "Відповідальність", "text": "Ліміт 50 000 ₴."},
        ]},
        headers=auth,
    )
    assert r.status_code == 200
    # Section headings made it into the joined text.
    assert "п. 2.3" in captured["text"]
    assert "Ліміт 50 000 ₴" in captured["text"]


def test_endpoint_rejects_empty_body(client, auth):
    r = client.post("/api/analyze/contract", json={}, headers=auth)
    assert r.status_code == 400


def test_endpoint_maps_claude_error_to_502(client, auth, monkeypatch):
    from backend import main as main_module
    from backend.claude_client import ClaudeError

    def boom(text, conn=None):
        raise ClaudeError("Network error contacting Anthropic")

    monkeypatch.setattr(main_module, "analyze_contract", boom)
    r = client.post("/api/analyze/contract", json={"markdown": "x"}, headers=auth)
    assert r.status_code == 502
    assert "network" in r.json()["detail"].lower()
