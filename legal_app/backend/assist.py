"""Lawyer-assist endpoints: summary + translation (Phase 3.2).

Two thin Claude wrappers driving the two analysis-screen modals:

  POST /api/summary    → {summary, mode, usage, model}
  POST /api/translate  → {pairs, glossary, translation, direction, usage, model}

Both are gated by `require("ai")` per Phase 2.3 — the same gate that protects
`/api/analyze` and `/api/analyze/contract`. Errors from the SDK become a clean
`ClaudeError` and surface as HTTP 502 at the route layer.

Translation uses `output_config.format = json_schema` so paragraph pairs and
glossary survive structured. Summary is plain markdown — the modal renders
it directly.
"""
from __future__ import annotations

import json
from typing import Any, Literal, Optional

import anthropic
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .claude_client import ClaudeError, _client
from .config import get_settings
from .prompts import (
    SUMMARY_LEGAL_PROMPT,
    SUMMARY_PLAIN_PROMPT,
    TRANSLATE_PROMPT,
)
from .rbac import require


DEFAULT_SUMMARY_MAX_TOKENS = 2048
DEFAULT_TRANSLATE_MAX_TOKENS = 8000


SummaryMode = Literal["legal", "plain"]
TranslateDirection = Literal["ua_en", "en_ua"]


# ---------------------------------------------------------------------------
# Translation JSON schema
# ---------------------------------------------------------------------------

TRANSLATE_JSON_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["pairs", "glossary"],
    "properties": {
        "pairs": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["src", "tgt"],
                "properties": {
                    "src": {"type": "string"},
                    "tgt": {"type": "string"},
                },
            },
        },
        "glossary": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["src", "tgt"],
                "properties": {
                    "src": {"type": "string"},
                    "tgt": {"type": "string"},
                },
            },
        },
    },
}


_SUMMARY_PROMPTS: dict[str, str] = {
    "legal": SUMMARY_LEGAL_PROMPT,
    "plain": SUMMARY_PLAIN_PROMPT,
}


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

def _direction_label(direction: TranslateDirection) -> str:
    return "UA → EN" if direction == "ua_en" else "EN → UA"


def _sections_to_text(sections: list[dict]) -> str:
    """Re-join Phase 1.3 sections back into markdown for Claude.

    Local copy of `main._sections_to_text` so this module stays import-free of
    `main`. Behaviour is identical.
    """
    parts: list[str] = []
    for s in sections:
        number = s.get("number") or ""
        title = s.get("title") or ""
        head = " ".join(b for b in (number, title) if b).strip()
        body = (s.get("text") or "").strip()
        if head:
            parts.append(f"## {head}\n\n{body}" if body else f"## {head}")
        elif body:
            parts.append(body)
    return "\n\n".join(parts)


def _wrap_anthropic_errors(call):
    """Decorator-ish helper — runs `call()` and maps SDK errors to ClaudeError."""
    try:
        return call()
    except anthropic.AuthenticationError as e:
        raise ClaudeError(f"Anthropic authentication failed: {e.message}") from e
    except anthropic.RateLimitError as e:
        raise ClaudeError(f"Anthropic rate limit exceeded: {e.message}") from e
    except anthropic.APIConnectionError as e:
        raise ClaudeError(f"Network error contacting Anthropic: {e}") from e
    except anthropic.APIStatusError as e:
        raise ClaudeError(f"Anthropic API error ({e.status_code}): {e.message}") from e


def _usage_dict(usage) -> dict:
    return {
        "input_tokens": usage.input_tokens,
        "output_tokens": usage.output_tokens,
        "cache_creation_input_tokens": getattr(usage, "cache_creation_input_tokens", 0) or 0,
        "cache_read_input_tokens": getattr(usage, "cache_read_input_tokens", 0) or 0,
    }


# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

def generate_summary(
    text: str,
    mode: SummaryMode,
    *,
    client: anthropic.Anthropic | None = None,
    max_tokens: int = DEFAULT_SUMMARY_MAX_TOKENS,
) -> dict:
    """Return Claude's markdown summary of the contract.

    `mode` selects the prompt — `legal` for the lawyer summary, `plain` for the
    client-facing explanation (which carries its own "not a legal opinion"
    disclaimer in the prompt).
    """
    if mode not in _SUMMARY_PROMPTS:
        raise ValueError(f"Unknown summary mode: {mode!r}")

    settings = get_settings()
    cli = client or _client()

    response = _wrap_anthropic_errors(lambda: cli.messages.create(
        model=settings.MODEL_NAME,
        max_tokens=max_tokens,
        system=[{
            "type": "text",
            "text": _SUMMARY_PROMPTS[mode],
            "cache_control": {"type": "ephemeral"},
        }],
        messages=[{"role": "user", "content": text}],
    ))

    summary_text = "".join(
        getattr(b, "text", "") for b in response.content if getattr(b, "type", None) == "text"
    ).strip()
    return {
        "summary": summary_text,
        "mode": mode,
        "model": response.model,
        "usage": _usage_dict(response.usage),
    }


# ---------------------------------------------------------------------------
# Translation
# ---------------------------------------------------------------------------

def generate_translation(
    text: str,
    direction: TranslateDirection,
    *,
    client: anthropic.Anthropic | None = None,
    max_tokens: int = DEFAULT_TRANSLATE_MAX_TOKENS,
) -> dict:
    """Return paragraph-paired translation + glossary."""
    if direction not in ("ua_en", "en_ua"):
        raise ValueError(f"Unknown translate direction: {direction!r}")

    settings = get_settings()
    cli = client or _client()

    # Append a short direction hint so the model knows which way to translate;
    # the bulk of the prompt is identical across directions and stays cached.
    user_content = (
        f"Напрям перекладу: {_direction_label(direction)}.\n\n"
        f"<document>\n{text}\n</document>"
    )

    response = _wrap_anthropic_errors(lambda: cli.messages.create(
        model=settings.MODEL_NAME,
        max_tokens=max_tokens,
        system=[{
            "type": "text",
            "text": TRANSLATE_PROMPT,
            "cache_control": {"type": "ephemeral"},
        }],
        messages=[{"role": "user", "content": user_content}],
        output_config={
            "format": {
                "type": "json_schema",
                "schema": TRANSLATE_JSON_SCHEMA,
            },
        },
    ))

    raw = "".join(getattr(b, "text", "") for b in response.content if getattr(b, "type", None) == "text")
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as e:
        raise ClaudeError(f"Claude returned non-JSON output: {raw[:200]}…") from e

    pairs = [
        {"src": p.get("src", ""), "tgt": p.get("tgt", "")}
        for p in (parsed.get("pairs") or [])
    ]
    glossary = [
        {"src": g.get("src", ""), "tgt": g.get("tgt", "")}
        for g in (parsed.get("glossary") or [])
    ]
    translation = "\n\n".join(p["tgt"] for p in pairs if p["tgt"])

    return {
        "pairs": pairs,
        "glossary": glossary,
        "translation": translation,
        "direction": direction,
        "model": response.model,
        "usage": _usage_dict(response.usage),
    }


# ---------------------------------------------------------------------------
# Router
# ---------------------------------------------------------------------------

router = APIRouter(prefix="/api", tags=["assist"])


class SummaryRequest(BaseModel):
    # 200k chars ≈ ~50k tokens — generous for a typical contract; caps
    # adversarial multi-MB payloads (audit fix #2-5).
    contract: Optional[str] = Field(
        default=None,
        max_length=200_000,
        description="Full contract markdown (alias for `markdown`).",
    )
    markdown: Optional[str] = Field(
        default=None,
        max_length=200_000,
        description="Alias for `contract`.",
    )
    sections: Optional[list[dict]] = Field(
        default=None,
        max_length=500,
        description="Sections from /api/upload — joined into markdown server-side.",
    )
    mode: SummaryMode = "legal"


def _resolve_contract_text(req_text_field: Optional[str],
                           req_markdown: Optional[str],
                           req_sections: Optional[list[dict]]) -> str:
    text = req_text_field or req_markdown or ""
    if not text.strip() and req_sections:
        text = _sections_to_text(req_sections)
    return text


@router.post("/summary", dependencies=[Depends(require("ai"))])
def summary(req: SummaryRequest):
    text = _resolve_contract_text(req.contract, req.markdown, req.sections)
    if not text.strip():
        raise HTTPException(status_code=400, detail="Provide `contract`, `markdown`, or non-empty `sections`.")
    try:
        return generate_summary(text, req.mode)
    except ClaudeError as e:
        raise HTTPException(status_code=502, detail=str(e))


class TranslateRequest(BaseModel):
    # See SummaryRequest — same ceiling.
    text: Optional[str] = Field(default=None, max_length=200_000, description="Source text or markdown.")
    markdown: Optional[str] = Field(default=None, max_length=200_000, description="Alias for `text`.")
    sections: Optional[list[dict]] = Field(default=None, max_length=500, description="Source as Phase 1.3 sections.")
    direction: TranslateDirection = "ua_en"


@router.post("/translate", dependencies=[Depends(require("ai"))])
def translate(req: TranslateRequest):
    text = _resolve_contract_text(req.text, req.markdown, req.sections)
    if not text.strip():
        raise HTTPException(status_code=400, detail="Provide `text`, `markdown`, or non-empty `sections`.")
    try:
        return generate_translation(text, req.direction)
    except ClaudeError as e:
        raise HTTPException(status_code=502, detail=str(e))
