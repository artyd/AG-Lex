"""RAG pipeline: search → Claude → citation check.

Phase 1.5 — the integration phase. `analyze()` is the single entry point for
"answer a legal question grounded in real codex articles":

  1. `hybrid_search` pulls the most relevant articles (UA + EU by default).
  2. `ask_claude` answers with prompt caching + the lawyer system prompt.
  3. `validate_citations` cross-checks every article number cited in the answer
     against the set that was actually retrieved. Anything fabricated becomes a
     warning — the lawyer still sees the answer, but with a clear trust flag.

The third step is the trust boundary of the product: Claude either grounds itself
in the database or we tell the user it didn't.
"""
from __future__ import annotations

import re
import sqlite3

from .claude_client import ask_claude
from .search import hybrid_search


DEFAULT_LIMIT = 5
SECTION_TEXT_TRUNCATE = 1000


# Matches "ст. 651", "ст.651", UA inflections of "стаття", and EN "Article N" /
# "Art. N". Anchored to the citation lead-in so plain numbers in the body
# (dates, list indices, percentages) don't get flagged as citations.
_CITATION_RE = re.compile(
    r"(?:"
    r"ст\.\s*"
    r"|стат(?:тя|ті|тю|тею|тей|тями|тях)\s+"
    r"|art(?:icle|\.)\s+"
    r")"
    r"(?P<num>\d+(?:[\-.]\d+)?[а-яa-z]?)",
    re.IGNORECASE,
)

_BARE_NUM_RE = re.compile(r"\d+(?:[\-.]\d+)?[а-яa-z]?", re.IGNORECASE)


def _bare_number(article_number: str) -> str | None:
    """Pull "651" out of "Стаття 651" or "5" out of "Article 5"."""
    m = _BARE_NUM_RE.search(article_number or "")
    return m.group(0).lower() if m else None


def validate_citations(answer: str, provided_articles: list[dict]) -> list[str]:
    """Return one warning per cited article number that wasn't in the context.

    Number-only matching (not source-aware). UA codex numbers and EU article
    numbers practically don't collide in this corpus, so a number match is a
    sufficient grounding signal. If lawyers later report a false-pass, upgrade
    to (number, source) tuples.
    """
    if not answer:
        return []

    provided = {n for n in (_bare_number(a.get("article_number", "")) for a in provided_articles) if n}

    seen_invalid: set[str] = set()
    warnings: list[str] = []
    for m in _CITATION_RE.finditer(answer):
        num = m.group("num").lower()
        if num in provided or num in seen_invalid:
            continue
        seen_invalid.add(num)
        warnings.append(
            f"Стаття {num} згадана у відповіді, але її немає в наданому контексті — "
            f"можлива галюцинація моделі."
        )
    return warnings


def _build_search_query(question: str, contract_section: dict | None) -> str:
    """Question + a slice of the contract section text, when present.

    Per Phase 1.5 Step 4: search uses (question + section), but Claude only ever
    sees the section itself (handled by `ask_claude`) — that's the token saving.
    """
    if not contract_section:
        return question
    section_text = (contract_section.get("text") or "").strip()
    if not section_text:
        return question
    return f"{question}\n\n{section_text[:SECTION_TEXT_TRUNCATE]}"


_USED_ARTICLE_FIELDS = ("article_number", "title", "source", "score")


def analyze(
    question: str,
    contract_section: dict | None = None,
    sources=None,
    *,
    limit: int = DEFAULT_LIMIT,
    conn: sqlite3.Connection | None = None,
    embedder=None,
    client=None,
) -> dict:
    """Run a single RAG turn end-to-end.

    Args:
        question: Lawyer's question (Ukrainian preferred; Claude answers in UA).
        contract_section: Optional `{number, title, text}` from Phase 1.3 output.
            When present, the section text feeds the search query AND is sent to
            Claude — only the section, not the whole contract.
        sources: `None` (search UA + EU), a string (`"ЦКУ"`), or a list.
        limit: Number of articles to retrieve. 5 is the Phase 1.5 default —
            enough to ground typical questions, few enough to keep Claude's
            input small and the answer focused.
        conn / embedder / client: Inject for tests; production uses defaults.

    Returns:
        `{answer, used_articles, warnings, usage, model}`. `used_articles`
        carries only metadata (no `content`/`id`), keeping the wire payload
        small — the full article texts live in the request to Claude, not the
        response to the lawyer.
    """
    from .mock_ai import is_mock_ai, mock_analyze_answer
    if is_mock_ai():
        return mock_analyze_answer(question)

    query = _build_search_query(question, contract_section)
    hits = hybrid_search(query, source=sources, limit=limit, conn=conn, embedder=embedder)

    claude = ask_claude(question, hits, contract_section, client=client)

    warnings = validate_citations(claude["answer"], hits)

    return {
        "answer": claude["answer"],
        "used_articles": [{k: a.get(k) for k in _USED_ARTICLE_FIELDS} for a in hits],
        "warnings": warnings,
        "usage": claude["usage"],
        "model": claude["model"],
    }
