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
from pydantic import BaseModel, Field, field_validator

from .assist import _wrap_anthropic_errors, _usage_dict
from .claude_client import ClaudeError, _client
from .config import get_settings
from .database import get_db
from .pipeline import _CITATION_RE
from .prompts import DOC_BUILDER_PROMPT, INTERNATIONAL_CONTRACT_PROMPT
from .rbac import require
from .search import hybrid_search


DEFAULT_MAX_TOKENS = 8000
ARTICLES_FOR_CONTEXT = 8  # generous; Claude truncates what it doesn't need

DocumentType = Literal[
    "services", "supply", "lease", "nda", "claim", "lawsuit",
    # Phase F1 of the unified-builder work: bilingual UA/EN supply contract
    # produced from the "Передача справ" intake form. Output schema includes
    # parallel UA/EN sections so the FE can render two columns side-by-side.
    "international_supply",
]


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
    "international_supply": _Type(
        label="Міжнародний контракт постачання (UA/EN)",
        layout="contract",
        seed_query=(
            "міжнародний контракт постачання Incoterms 2020 валютний контроль "
            "експорт імпорт CIF FCA FOB митниця сертифікат якості форс-мажор "
            "арбітраж зовнішньоекономічна діяльність"
        ),
        default_heading="КОНТРАКТ / CONTRACT",
    ),
}

# Categories the international-supply prompt expects in `params`. These mirror
# the 15 reconciliation categories the user's "Передача справ" intake form
# produces — so the same intake schema can feed both /api/reconcile (compare
# existing contract vs handover) AND /api/generate-document (draft a new
# contract from the handover). One vocabulary, two flows.
INTERNATIONAL_INTAKE_KEYS: tuple[str, ...] = (
    "supplier", "product", "price", "quantity", "incoterms", "delivery",
    "payment", "origin", "hscode", "certificates", "packaging", "quality",
    "consignee", "regnumber", "additional",
)

# Required-field gate for international supply. The intake form must populate
# at least these BEFORE we send the request to Claude — otherwise the prompt
# would have to make up half the contract. List corresponds to the * fields in
# the user's intake template (Додаток А / "Передача справ").
INTERNATIONAL_REQUIRED_KEYS: tuple[str, ...] = (
    "supplier", "product", "price", "quantity", "incoterms",
    "payment", "consignee",
)


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


# Schema used for international_supply only — adds parallel UA/EN sections
# so the FE can render the two-column layout the user's reference template
# uses. document_markdown is still emitted (as the UA-side flattening) so
# downstream consumers that don't know about sections still work.
INTERNATIONAL_GENERATE_JSON_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["document_markdown", "layout", "articles_cited", "sections_bilingual"],
    "properties": {
        "document_markdown": {"type": "string"},
        "layout": {"type": "string", "enum": ["contract", "letter"]},
        "articles_cited": {
            "type": "array",
            "items": {"type": "string"},
        },
        # 15 contract sections per the user's reference template, each with
        # parallel Ukrainian + English titles and bodies. Body is markdown so
        # numbered sub-clauses (1.1, 1.2 …) render correctly on both sides.
        "sections_bilingual": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["n", "ua_title", "en_title", "ua_text", "en_text"],
                "properties": {
                    "n": {"type": "integer"},
                    "ua_title": {"type": "string"},
                    "en_title": {"type": "string"},
                    "ua_text": {"type": "string"},
                    "en_text": {"type": "string"},
                },
            },
        },
        # Appendix #1: the goods specification table generated from the
        # intake's product/quantity/price fields. Rendered on its own page.
        "specification": {
            "type": "object",
            "additionalProperties": False,
            "required": ["rows", "total"],
            "properties": {
                "rows": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "additionalProperties": False,
                        "required": ["product", "producer", "packaging", "quantity", "price", "amount"],
                        "properties": {
                            "product": {"type": "string"},
                            "producer": {"type": "string"},
                            "packaging": {"type": "string"},
                            "quantity": {"type": "string"},
                            "price": {"type": "string"},
                            "amount": {"type": "string"},
                        },
                    },
                },
                "total": {"type": "string"},
            },
        },
    },
}


def _check_intake_required(params: dict, required_keys: tuple[str, ...]) -> list[str]:
    """Essential-conditions validator: emit a warning per missing required key.
    The intake form should refuse to submit when any of these are blank, but
    we double-check on the server so direct API callers can't bypass it
    silently. Warnings flow into the response so the FE can highlight the
    intake field that needs attention."""
    missing: list[str] = []
    for k in required_keys:
        v = (params or {}).get(k)
        if v is None or (isinstance(v, str) and not v.strip()):
            missing.append(k)
    if not missing:
        return []
    return [
        f"Пропущено обовʼязкову істотну умову: «{k}». "
        f"Контракт без цього поля підписувати ризиковано."
        for k in missing
    ]


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
    """Generate a full document via Claude with grounded codex citations.

    For `international_supply`: uses the bilingual prompt/schema and emits
    `sections_bilingual` (parallel UA/EN sections) + `specification` for the
    Appendix #1 goods table. Other types still get a flat
    `document_markdown` per the original wire contract.
    """
    if doc_type not in DOC_TYPES:
        raise ValueError(f"Unknown document type: {doc_type!r}")

    settings = get_settings()
    cli = client or _client()

    is_international = doc_type == "international_supply"

    # Essential-conditions gate. We DON'T 4xx on missing fields — the FE
    # has the gate that prevents submission — but we surface a clear
    # warning per missing field so anyone bypassing the form (curl,
    # script, tests) gets the same feedback the UI gives.
    intake_warnings: list[str] = []
    if is_international:
        intake_warnings = _check_intake_required(params, INTERNATIONAL_REQUIRED_KEYS)

    articles = _retrieve_articles(conn, doc_type, params)
    user_content = _build_user_turn(doc_type, params, options or {}, articles)

    system_prompt = INTERNATIONAL_CONTRACT_PROMPT if is_international else DOC_BUILDER_PROMPT
    schema = INTERNATIONAL_GENERATE_JSON_SCHEMA if is_international else GENERATE_JSON_SCHEMA
    # Bilingual generation roughly doubles output size — bump the token
    # ceiling so Claude doesn't truncate mid-section.
    effective_max_tokens = max_tokens * 2 if is_international else max_tokens

    response = _wrap_anthropic_errors(lambda: cli.messages.create(
        model=settings.MODEL_NAME,
        max_tokens=effective_max_tokens,
        system=[{
            "type": "text",
            "text": system_prompt,
            "cache_control": {"type": "ephemeral"},
        }],
        messages=[{"role": "user", "content": user_content}],
        output_config={
            "format": {
                "type": "json_schema",
                "schema": schema,
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

    warnings = intake_warnings + _validate_cited_articles(conn, articles_cited)

    result: dict[str, Any] = {
        "document_markdown": document_markdown,
        "layout": layout,
        "articles_cited": articles_cited,
        "warnings": warnings,
        "type": doc_type,
        "type_label": DOC_TYPES[doc_type].label,
        "model": response.model,
        "usage": _usage_dict(response.usage),
        # Every generated doc is a working draft until a qualified lawyer
        # approves it. The FE renders a prominent banner; downstream
        # consumers (E-sign, etc.) should refuse to act on a draft whose
        # status hasn't been escalated. Phase 2 implements the real
        # approval workflow; Phase 1 just plants the flag.
        "review_status": "draft",
    }
    if is_international:
        result["sections_bilingual"] = parsed.get("sections_bilingual") or []
        result["specification"] = parsed.get("specification") or {"rows": [], "total": ""}
    return result


# ---------------------------------------------------------------------------
# Router
# ---------------------------------------------------------------------------

router = APIRouter(prefix="/api", tags=["builder"])


_MAX_DICT_JSON_BYTES = 50_000  # ~12k tokens — generous for form payload, blocks abuse.


class GenerateDocumentRequest(BaseModel):
    type: DocumentType
    params: dict = Field(default_factory=dict, description="Type-specific form fields.")
    options: Optional[dict] = Field(
        default=None,
        description="Boolean toggles: penalty, liability, nda, warranty, indexation.",
    )

    @field_validator("params", "options", mode="before")
    @classmethod
    def _cap_dict_size(cls, v):
        if v is None:
            return v
        if len(json.dumps(v, ensure_ascii=False)) > _MAX_DICT_JSON_BYTES:
            raise ValueError(
                f"payload too large (max {_MAX_DICT_JSON_BYTES} chars when JSON-encoded)"
            )
        return v


@router.post("/generate-document", dependencies=[Depends(require("ai"))])
def generate_document_endpoint(
    req: GenerateDocumentRequest,
    conn: sqlite3.Connection = Depends(get_db),
):
    try:
        return generate_document(req.type, req.params, req.options, conn=conn)
    except ClaudeError as e:
        raise HTTPException(status_code=502, detail=str(e))
