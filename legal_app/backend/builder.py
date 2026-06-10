"""Document builder: Claude generates a real Ukrainian legal document
from a typed parameter form (Phase 3.3, spec §8.3).

Six document types, each with a codex-search seed query so the model is
given real ЦК/ГК articles to reference (RAG, same idea as the analysis flow).
Output is a single Markdown document plus the list of articles the model
chose to cite — validated against the codex on the way back.

Wire contract:

  POST /api/generate-document
    { type: "services|supply|lease|nda|claim|lawsuit",
      params: { partyA, partyB, amount, subject, ... },
      options: { penalty, liability, nda, warranty, indexation } }
  →
    { document_markdown, layout: "contract|letter",
      articles_cited[], warnings[], usage, model }
"""
from __future__ import annotations

import json
import sqlite3
from typing import Any, Literal, Optional

import anthropic
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .assist import _wrap_anthropic_errors, _usage_dict
from .claude_client import ClaudeError, _client
from .config import get_settings
from .database import get_db
from .pipeline import _CITATION_RE
from .prompts import DOC_BUILDER_PROMPT
from .rbac import require
from .search import hybrid_search


DEFAULT_MAX_TOKENS = 8000
ARTICLES_FOR_CONTEXT = 8  # generous; Claude truncates what it doesn't need

DocumentType = Literal["services", "supply", "lease", "nda", "claim", "lawsuit"]


# ---------------------------------------------------------------------------
# Per-type metadata
# ---------------------------------------------------------------------------

class _Type:
    __slots__ = ("label", "layout", "seed_query", "default_heading")

    def __init__(self, *, label: str, layout: str, seed_query: str, default_heading: str):
        self.label = label
        self.layout = layout  # "contract" or "letter"
        self.seed_query = seed_query
        self.default_heading = default_heading


DOC_TYPES: dict[str, _Type] = {
    "services": _Type(
        label="Договір про надання послуг",
        layout="contract",
        seed_query="договір про надання послуг виконавець замовник плата строк відповідальність",
        default_heading="ДОГОВІР про надання послуг",
    ),
    "supply": _Type(
        label="Договір постачання",
        layout="contract",
        seed_query="договір постачання товар постачальник покупець ціна якість строк",
        default_heading="ДОГОВІР постачання",
    ),
    "lease": _Type(
        label="Договір оренди",
        layout="contract",
        seed_query="договір оренди майна орендодавець орендар плата строк передача",
        default_heading="ДОГОВІР оренди",
    ),
    "nda": _Type(
        label="Угода про нерозголошення (NDA)",
        layout="contract",
        seed_query="конфіденційна інформація комерційна таємниця нерозголошення обмін даними",
        default_heading="УГОДА про нерозголошення конфіденційної інформації",
    ),
    "claim": _Type(
        label="Претензія контрагенту",
        layout="letter",
        seed_query="претензія порушення зобовʼязання неустойка повернення коштів строки",
        default_heading="ПРЕТЕНЗІЯ",
    ),
    "lawsuit": _Type(
        label="Позовна заява",
        layout="letter",
        seed_query="позовна заява стягнення збитків господарський суд позивач відповідач",
        default_heading="ПОЗОВНА ЗАЯВА",
    ),
}


# ---------------------------------------------------------------------------
# JSON schema for Claude's response
# ---------------------------------------------------------------------------

GENERATE_JSON_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["document_markdown", "layout", "articles_cited"],
    "properties": {
        "document_markdown": {"type": "string"},
        "layout": {"type": "string", "enum": ["contract", "letter"]},
        "articles_cited": {
            "type": "array",
            "items": {"type": "string"},
        },
    },
}


# ---------------------------------------------------------------------------
# Context helpers
# ---------------------------------------------------------------------------

def _format_articles_block(articles: list[dict]) -> str:
    parts: list[str] = []
    for a in articles:
        head = f"[{a['source']}] {a['article_number']}"
        if a.get("title"):
            head += f". {a['title']}"
        body = (a.get("content") or "").strip()
        parts.append(f"{head}\n{body}")
    return "\n\n---\n\n".join(parts) if parts else "(база кодексів порожня)"


def _build_user_turn(doc_type: str, params: dict, options: dict, articles: list[dict]) -> str:
    type_meta = DOC_TYPES[doc_type]
    options_json = json.dumps(options or {}, ensure_ascii=False)
    params_json = json.dumps(params or {}, ensure_ascii=False, indent=2)
    articles_block = _format_articles_block(articles)
    return (
        f"ТИП ДОКУМЕНТА: {type_meta.label} (`{doc_type}`)\n"
        f"РЕКОМЕНДОВАНА ШАПКА: {type_meta.default_heading}\n"
        f"МАКЕТ: `{type_meta.layout}`\n\n"
        f"ПАРАМЕТРИ:\n{params_json}\n\n"
        f"ОПЦІЇ: {options_json}\n\n"
        f"<context_articles>\n{articles_block}\n</context_articles>"
    )


def _retrieve_articles(conn: sqlite3.Connection, doc_type: str, params: dict) -> list[dict]:
    """RAG retrieval: build a query from type seed + params and hybrid-search the codex."""
    type_meta = DOC_TYPES[doc_type]
    extras = " ".join(
        str(v) for v in (params or {}).values()
        if isinstance(v, str) and v.strip()
    )
    query = f"{type_meta.seed_query} {extras}".strip()
    try:
        hits = hybrid_search(query, limit=ARTICLES_FOR_CONTEXT, conn=conn)
    except Exception:
        # Codex empty or FTS not yet seeded: continue without grounding rather
        # than 500. The prompt explicitly handles the "no context" case.
        hits = []
    return hits


def _validate_cited_articles(conn: sqlite3.Connection, cited: list[str]) -> list[str]:
    """Warn for each citation whose article number isn't in the codex.

    Mirrors `contract_analysis.validate_law_citations` but operates on the
    `articles_cited` array Claude returns rather than scraping a markdown body.
    """
    total = conn.execute("SELECT COUNT(*) FROM articles").fetchone()[0]
    if total == 0:
        return [] if not cited else [
            "База кодексів порожня — згадані статті не валідовано."
        ]

    nums = set()
    for raw in cited:
        m = _CITATION_RE.search(raw or "")
        if m:
            nums.add(m.group("num").lower())
    if not nums:
        return []

    placeholders = " OR ".join("LOWER(article_number) LIKE ?" for _ in nums)
    params = [f"% {n}" for n in nums]
    rows = conn.execute(
        f"SELECT article_number FROM articles WHERE {placeholders}",
        params,
    ).fetchall()
    found = set()
    for (article_no,) in rows:
        tail = article_no.split()[-1] if article_no else ""
        if tail:
            found.add(tail.lower())
    return [
        f"У документі згадано «ст. {n}», але цієї статті немає в завантажених кодексах."
        for n in sorted(nums - found)
    ]


# ---------------------------------------------------------------------------
# Core generator
# ---------------------------------------------------------------------------

def generate_document(
    doc_type: str,
    params: dict,
    options: dict | None,
    *,
    conn: sqlite3.Connection,
    client: anthropic.Anthropic | None = None,
    max_tokens: int = DEFAULT_MAX_TOKENS,
) -> dict:
    """Generate a full document via Claude with grounded codex citations."""
    if doc_type not in DOC_TYPES:
        raise ValueError(f"Unknown document type: {doc_type!r}")

    settings = get_settings()
    cli = client or _client()

    articles = _retrieve_articles(conn, doc_type, params)
    user_content = _build_user_turn(doc_type, params, options or {}, articles)

    response = _wrap_anthropic_errors(lambda: cli.messages.create(
        model=settings.MODEL_NAME,
        max_tokens=max_tokens,
        system=[{
            "type": "text",
            "text": DOC_BUILDER_PROMPT,
            "cache_control": {"type": "ephemeral"},
        }],
        messages=[{"role": "user", "content": user_content}],
        output_config={
            "format": {
                "type": "json_schema",
                "schema": GENERATE_JSON_SCHEMA,
            },
        },
    ))

    raw = "".join(b.text for b in response.content if getattr(b, "type", None) == "text")
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as e:
        raise ClaudeError(f"Claude returned non-JSON output: {raw[:200]}…") from e

    document_markdown = parsed.get("document_markdown") or ""
    layout = parsed.get("layout") or DOC_TYPES[doc_type].layout
    articles_cited = [str(a) for a in (parsed.get("articles_cited") or [])]

    warnings = _validate_cited_articles(conn, articles_cited)

    return {
        "document_markdown": document_markdown,
        "layout": layout,
        "articles_cited": articles_cited,
        "warnings": warnings,
        "type": doc_type,
        "type_label": DOC_TYPES[doc_type].label,
        "model": response.model,
        "usage": _usage_dict(response.usage),
    }


# ---------------------------------------------------------------------------
# Router
# ---------------------------------------------------------------------------

router = APIRouter(prefix="/api", tags=["builder"])


class GenerateDocumentRequest(BaseModel):
    type: DocumentType
    params: dict = Field(default_factory=dict, description="Type-specific form fields.")
    options: Optional[dict] = Field(
        default=None,
        description="Boolean toggles: penalty, liability, nda, warranty, indexation.",
    )


@router.post("/generate-document", dependencies=[Depends(require("ai"))])
def generate_document_endpoint(
    req: GenerateDocumentRequest,
    conn: sqlite3.Connection = Depends(get_db),
):
    try:
        return generate_document(req.type, req.params, req.options, conn=conn)
    except ClaudeError as e:
        raise HTTPException(status_code=502, detail=str(e))
