"""Anthropic SDK wrapper for AG Lex.

Phase 1.4. The contract: callers pass a question + a list of articles fetched
via `backend.search.hybrid_search`, and Claude answers strictly grounded in
those articles. Prompt caching is configured so the system prompt + article
block are reused across requests in the same 5-minute window — the bulk of
the prompt is shared between Phase 3.1's analysis turns, so cache hits drop
input cost by ~90% for repeat queries against the same article set.

Anthropic SDK auto-retries connection errors, 408, 409, 429, and ≥500 with
exponential backoff. We bump `max_retries` to 4 so a transient outage doesn't
need to surface to the user, then translate any final failure into a single
`ClaudeError` with a readable message — no stack traces leaking through.
"""
from __future__ import annotations

import functools

import anthropic

from .config import get_settings
from .prompts import LEGAL_SYSTEM_PROMPT


# Reasonable ceiling for legal answers; bump if Phase 3.x answers get truncated.
DEFAULT_MAX_TOKENS = 2048
SDK_RETRIES = 4


class ClaudeError(RuntimeError):
    """Raised when the Anthropic API is unreachable or returns a hard error."""


@functools.lru_cache(maxsize=1)
def _client() -> anthropic.Anthropic:
    settings = get_settings()
    if not settings.API_KEY:
        raise ClaudeError(
            "API_KEY is empty. Set it in legal_app/.env before calling Claude."
        )
    return anthropic.Anthropic(api_key=settings.API_KEY, max_retries=SDK_RETRIES)


def format_articles(articles: list[dict]) -> str:
    """Render search hits into a deterministic, parseable context block.

    Determinism matters for prompt caching — `dict` ordering, `set` traversal,
    or `f"{datetime.now()}"` anywhere here would silently invalidate the cache.
    """
    parts: list[str] = []
    for a in articles:
        head = f"[{a['source']}] {a['article_number']}"
        title = a.get("title")
        if title:
            head += f". {title}"
        body = (a.get("content") or "").strip()
        parts.append(f"{head}\n{body}")
    return "\n\n---\n\n".join(parts)


def _format_contract_section(section: dict | None) -> str:
    if not section:
        return ""
    number = section.get("number") or ""
    title = section.get("title") or ""
    head = f"{number} {title}".strip() or "(без номера)"
    body = (section.get("text") or section.get("content") or "").strip()
    return (
        "<contract_section>\n"
        f"{head}\n\n"
        f"{body}\n"
        "</contract_section>\n\n"
    )


def ask_claude(
    question: str,
    context_articles: list[dict],
    contract_section: dict | None = None,
    *,
    client: anthropic.Anthropic | None = None,
    max_tokens: int = DEFAULT_MAX_TOKENS,
) -> dict:
    """Ask Claude a legal question grounded only in the provided articles.

    Args:
        question: Free-form lawyer question (Ukrainian or English; Claude
            responds in Ukrainian per the system prompt).
        context_articles: Search hits to ground the answer. Each item should
            carry `article_number`, `title`, `content`, `source`. Order matters
            for caching — pass them in a stable order across calls that should
            share a cache entry.
        contract_section: Optional `{number, title, text}` section from an
            uploaded contract (Phase 1.3 output). Per-request and volatile, so
            it goes in the user turn after the cached prefix.
        client: Inject a custom Anthropic client (used by tests).
        max_tokens: Output cap for this call.

    Returns:
        `{answer, model, stop_reason, usage}` where `usage` is a flat dict
        including `cache_creation_input_tokens` and `cache_read_input_tokens`.
    """
    settings = get_settings()
    cli = client or _client()

    articles_text = format_articles(context_articles)
    context_block = (
        "<context_articles>\n"
        "Нижче — статті кодексів, на які можна посилатися у відповіді. "
        "Будь-яка інша норма права — поза контекстом.\n\n"
        f"{articles_text}\n"
        "</context_articles>"
    )

    # Two cache breakpoints: system prompt (always stable) and the article
    # block (stable per-search-result-set). Sonnet 4.6 minimum cacheable prefix
    # is 2048 tokens; Opus 4.7/4.6 is 4096. Small synthetic article sets in
    # tests will silently skip caching — that's expected.
    system_blocks = [
        {
            "type": "text",
            "text": LEGAL_SYSTEM_PROMPT,
            "cache_control": {"type": "ephemeral"},
        },
        {
            "type": "text",
            "text": context_block,
            "cache_control": {"type": "ephemeral"},
        },
    ]

    user_text = (
        f"{_format_contract_section(contract_section)}"
        f"Запитання: {question.strip()}"
    )

    try:
        response = cli.messages.create(
            model=settings.MODEL_NAME,
            max_tokens=max_tokens,
            system=system_blocks,
            messages=[{"role": "user", "content": user_text}],
        )
    except anthropic.AuthenticationError as e:
        raise ClaudeError(f"Anthropic authentication failed — check API_KEY in .env: {e.message}") from e
    except anthropic.PermissionDeniedError as e:
        raise ClaudeError(f"API key lacks permission for model {settings.MODEL_NAME!r}: {e.message}") from e
    except anthropic.NotFoundError as e:
        raise ClaudeError(f"Model {settings.MODEL_NAME!r} not found — update MODEL_NAME (see docs.claude.com): {e.message}") from e
    except anthropic.RateLimitError as e:
        raise ClaudeError(f"Anthropic rate limit exceeded after {SDK_RETRIES} retries: {e.message}") from e
    except anthropic.APIConnectionError as e:
        raise ClaudeError(f"Network error contacting Anthropic: {e}") from e
    except anthropic.APIStatusError as e:
        raise ClaudeError(f"Anthropic API error ({e.status_code}): {e.message}") from e

    answer = "\n".join(b.text for b in response.content if getattr(b, "type", None) == "text")
    usage = response.usage
    return {
        "answer": answer,
        "model": response.model,
        "stop_reason": response.stop_reason,
        "usage": {
            "input_tokens": usage.input_tokens,
            "output_tokens": usage.output_tokens,
            "cache_creation_input_tokens": getattr(usage, "cache_creation_input_tokens", 0) or 0,
            "cache_read_input_tokens": getattr(usage, "cache_read_input_tokens", 0) or 0,
        },
    }
