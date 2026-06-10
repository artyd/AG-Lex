"""Phase 1.4 tests: Claude wrapper.

- Unit tests use a fake client (no network) to verify shape, cache placement,
  and contract-section routing.
- Integration test makes a real Anthropic call and asserts cache hits on the
  second identical-context request. Skipped automatically when API_KEY is
  not set in `.env`, so CI / fresh checkouts stay offline.
"""
from __future__ import annotations

import os
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from backend import claude_client
from backend.claude_client import (
    ClaudeError,
    ask_claude,
    format_articles,
)
from backend.config import get_settings


# ---------------------------------------------------------------------------
# fixtures
# ---------------------------------------------------------------------------

# Article bodies are padded so the cached prefix exceeds the 2048-token minimum
# on Sonnet 4.6 (and 4096-token minimum on Opus 4.7/4.6). At ~4 chars/token,
# each article carries ~1100 tokens of body → comfortably above thresholds.
_LONG_BODY_UA = (
    "1. Зміна або розірвання договору допускається лише за згодою сторін, "
    "якщо інше не встановлено договором або законом. "
    "2. Договір може бути змінено або розірвано за рішенням суду на вимогу "
    "однієї із сторін у разі істотного порушення договору другою стороною та "
    "в інших випадках, встановлених договором або законом. "
    "3. У разі односторонньої відмови від договору у повному обсязі або "
    "частково, якщо право на таку відмову встановлено договором або законом, "
    "договір є відповідно розірваним або зміненим. "
) * 6  # ~4400 chars ≈ 1100 tokens

ARTICLES_FIXTURE = [
    {
        "article_number": "Стаття 651",
        "title": "Підстави для зміни або розірвання договору",
        "content": _LONG_BODY_UA,
        "source": "ЦКУ",
    },
    {
        "article_number": "Стаття 652",
        "title": "Зміна або розірвання договору у зв'язку з істотною зміною обставин",
        "content": _LONG_BODY_UA,
        "source": "ЦКУ",
    },
]


def _fake_response(answer: str = "За статтею 651 ЦКУ розірвання договору...", **usage_overrides):
    """Build an Anthropic-Message-shaped object the wrapper can read."""
    usage = SimpleNamespace(
        input_tokens=100,
        output_tokens=50,
        cache_creation_input_tokens=0,
        cache_read_input_tokens=0,
    )
    for k, v in usage_overrides.items():
        setattr(usage, k, v)
    return SimpleNamespace(
        content=[SimpleNamespace(type="text", text=answer)],
        model="claude-sonnet-4-6",
        stop_reason="end_turn",
        usage=usage,
    )


@pytest.fixture(autouse=True)
def _clear_client_cache():
    claude_client._client.cache_clear()
    yield
    claude_client._client.cache_clear()


# ---------------------------------------------------------------------------
# format_articles
# ---------------------------------------------------------------------------

def test_format_articles_includes_source_number_title_content():
    text = format_articles(ARTICLES_FIXTURE)
    assert "[ЦКУ]" in text
    assert "Стаття 651" in text
    assert "Стаття 652" in text
    assert "Підстави для зміни або розірвання договору" in text
    assert "за згодою сторін" in text
    # Articles separated by a stable marker so order is preserved.
    assert "\n---\n" in text


def test_format_articles_handles_missing_title():
    out = format_articles([{
        "article_number": "Article 5",
        "title": None,
        "content": "Personal data shall be processed lawfully.",
        "source": "EU_GDPR",
    }])
    assert "[EU_GDPR] Article 5" in out
    assert "Personal data" in out
    assert "None" not in out  # don't leak the literal


# ---------------------------------------------------------------------------
# ask_claude — unit (fake client)
# ---------------------------------------------------------------------------

def test_ask_claude_returns_answer_and_usage_shape():
    fake = MagicMock()
    fake.messages.create.return_value = _fake_response()
    result = ask_claude("Чи правомірне розірвання?", ARTICLES_FIXTURE, client=fake)
    assert "651" in result["answer"]
    assert result["model"] == "claude-sonnet-4-6"
    assert result["stop_reason"] == "end_turn"
    assert set(result["usage"]) == {
        "input_tokens", "output_tokens",
        "cache_creation_input_tokens", "cache_read_input_tokens",
    }


def test_ask_claude_places_cache_control_on_system_and_articles():
    fake = MagicMock()
    fake.messages.create.return_value = _fake_response()
    ask_claude("Q?", ARTICLES_FIXTURE, client=fake)

    kwargs = fake.messages.create.call_args.kwargs
    system = kwargs["system"]
    assert len(system) == 2, "Expected system prompt + articles as two cache breakpoints"
    assert all(b["cache_control"] == {"type": "ephemeral"} for b in system)
    # System prompt comes first (most stable), articles second.
    # Sanity-check that slot 0 is the system prompt (mentions the lawyer identity),
    # not the article block (which mentions <context_articles>).
    assert "адвокат" in system[0]["text"]
    assert "Стаття 651" in system[1]["text"]


def test_ask_claude_passes_model_from_config():
    fake = MagicMock()
    fake.messages.create.return_value = _fake_response()
    ask_claude("Q?", ARTICLES_FIXTURE, client=fake)
    assert fake.messages.create.call_args.kwargs["model"] == get_settings().MODEL_NAME


def test_ask_claude_keeps_question_in_user_turn_not_in_system():
    fake = MagicMock()
    fake.messages.create.return_value = _fake_response()
    ask_claude("Уникальный_маркер_вопроса", ARTICLES_FIXTURE, client=fake)

    kwargs = fake.messages.create.call_args.kwargs
    for block in kwargs["system"]:
        assert "Уникальный_маркер_вопроса" not in block["text"], (
            "Volatile question must NOT live in cached system blocks — "
            "otherwise every call invalidates the cache."
        )
    user_content = kwargs["messages"][0]["content"]
    assert "Уникальный_маркер_вопроса" in user_content


def test_ask_claude_routes_contract_section_into_user_turn():
    fake = MagicMock()
    fake.messages.create.return_value = _fake_response()
    section = {
        "number": "Стаття 5",
        "title": "Розірвання",
        "text": "Сторони мають право розірвати договір в односторонньому порядку.",
    }
    ask_claude("Чи правомірно?", ARTICLES_FIXTURE, contract_section=section, client=fake)

    kwargs = fake.messages.create.call_args.kwargs
    user_content = kwargs["messages"][0]["content"]
    assert "<contract_section>" in user_content
    assert "Сторони мають право розірвати" in user_content
    # Section must not live in cached system blocks (volatile per upload).
    for block in kwargs["system"]:
        assert "Сторони мають право розірвати" not in block["text"]


def test_ask_claude_propagates_cache_usage_metrics():
    fake = MagicMock()
    fake.messages.create.return_value = _fake_response(
        cache_creation_input_tokens=1200,
        cache_read_input_tokens=2400,
    )
    result = ask_claude("Q?", ARTICLES_FIXTURE, client=fake)
    assert result["usage"]["cache_creation_input_tokens"] == 1200
    assert result["usage"]["cache_read_input_tokens"] == 2400


def test_ask_claude_wraps_auth_error_in_claude_error():
    import anthropic
    fake = MagicMock()
    err = anthropic.AuthenticationError.__new__(anthropic.AuthenticationError)
    err.message = "invalid x-api-key"
    err.status_code = 401
    fake.messages.create.side_effect = err
    with pytest.raises(ClaudeError, match="authentication"):
        ask_claude("Q?", ARTICLES_FIXTURE, client=fake)


def test_ask_claude_wraps_connection_error_in_claude_error():
    import anthropic
    fake = MagicMock()
    err = anthropic.APIConnectionError.__new__(anthropic.APIConnectionError)
    err.message = "connection reset"
    fake.messages.create.side_effect = err
    with pytest.raises(ClaudeError, match="Network"):
        ask_claude("Q?", ARTICLES_FIXTURE, client=fake)


# ---------------------------------------------------------------------------
# Integration test — hits real Anthropic API. Auto-skipped without a key.
# ---------------------------------------------------------------------------

_API_KEY_PRESENT = bool(get_settings().API_KEY)


@pytest.mark.skipif(
    not _API_KEY_PRESENT,
    reason="API_KEY is empty in .env — skipping real Anthropic call. "
           "Set API_KEY to run end-to-end with the configured MODEL_NAME.",
)
def test_real_api_responds_and_uses_cache(capsys):
    """End-to-end Phase 1.4 check: real call → answer + cache hit on repeat."""
    q1 = "Чи може одна сторона розірвати договір в односторонньому порядку?"
    r1 = ask_claude(q1, ARTICLES_FIXTURE)

    assert r1["answer"], "Empty answer from Claude"
    assert any(s in r1["answer"].lower() for s in ("стаття", "договір")), (
        f"Answer didn't ground itself in the provided articles: {r1['answer'][:200]}"
    )

    # Identical cached prefix; different question → cache_read should fire.
    q2 = "Які наслідки одностороннього розірвання за статтею 651 ЦКУ?"
    r2 = ask_claude(q2, ARTICLES_FIXTURE)

    with capsys.disabled():
        print("\n=== Phase 1.4 real-API check ===")
        print(f"Model: {r1['model']}")
        print(f"\nQ1: {q1}\nA1 ({len(r1['answer'])} chars):\n{r1['answer']}\n")
        print(f"Usage Q1: {r1['usage']}\n")
        print(f"Q2: {q2}\nA2 ({len(r2['answer'])} chars):\n{r2['answer']}\n")
        print(f"Usage Q2: {r2['usage']}\n")

    assert r2["usage"]["cache_read_input_tokens"] > 0, (
        f"Expected cache hit on second call. Usage was {r2['usage']}. "
        "If the model is Opus 4.7/4.6 (4096-token min prefix), increase the "
        "fixture article body length."
    )
