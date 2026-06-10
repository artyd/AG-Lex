"""Per-contract risk analysis (Phase 3.1).

Generates the §7.1 `findings` array + `comparison` chart for a single contract
in one Claude call, computes the deterministic `score`, derives `legal_basis`
from the codex, and validates every cited article exists in the database.

Wire contract (matches the prototype's `DEMO.findings` shape exactly):

  findings[] = {
    id, kind:"risk", level:"high|med|low", clause, weight,
    title, desc, severity, law,
    suggest: {from, to},
  }
  comparison[] = {clause, status:"ok|warn|deviate|missing", note}
  legal_basis[] = {code, ref, scope:"UA|EU"}
  score = {value:0–100, label, risks:{high,med,low}}

The Claude call uses `output_config.format = json_schema` so the response is
guaranteed parseable JSON — that's the closest the API offers to "structured
output" without Pydantic gymnastics around the `from`/`to` reserved word.
"""
from __future__ import annotations

import json
import sqlite3
from typing import Any

import anthropic

from .claude_client import ClaudeError, _client
from .config import get_settings
from .pipeline import _CITATION_RE


# ---------------------------------------------------------------------------
# JSON schema for Claude's response.
# ---------------------------------------------------------------------------
# Every property is required + `additionalProperties: false` so the model
# can't drift the shape between calls. `weight` is constrained to the three
# bands the prototype uses (12 / 5 / 2). Add new levels by relaxing both
# `level` and `weight`.

CONTRACT_ANALYSIS_JSON_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["findings", "comparison"],
    "properties": {
        "findings": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": [
                    "id", "level", "clause", "weight",
                    "title", "desc", "severity", "law", "suggest",
                ],
                "properties": {
                    "id": {"type": "string"},
                    "level": {"type": "string", "enum": ["high", "med", "low"]},
                    "clause": {"type": "string"},
                    "weight": {"type": "integer"},
                    "title": {"type": "string"},
                    "desc": {"type": "string"},
                    "severity": {"type": "string"},
                    "law": {"type": "string"},
                    "suggest": {
                        "type": "object",
                        "additionalProperties": False,
                        "required": ["from", "to"],
                        "properties": {
                            "from": {"type": "string"},
                            "to": {"type": "string"},
                        },
                    },
                },
            },
        },
        "comparison": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["clause", "status", "note"],
                "properties": {
                    "clause": {"type": "string"},
                    "status": {"type": "string", "enum": ["ok", "warn", "deviate", "missing"]},
                    "note": {"type": "string"},
                },
            },
        },
    },
}


# ---------------------------------------------------------------------------
# System prompt
# ---------------------------------------------------------------------------

CONTRACT_ANALYSIS_PROMPT = """Ти — старший юрист-аналітик. Тобі надано проєкт договору (українською). \
Поверни структурований звіт у JSON за наданою схемою.

ЗАВДАННЯ:
1. Виявляй РИЗИКИ для слабкішої сторони (зазвичай Замовника). Шукай:
   - 100% передоплату без права повернення
   - занижений ліміт відповідальності
   - відсутність симетричних санкцій
   - односторонню зміну ціни
   - автоматичну пролонгацію з тривалим вікном повідомлення
   - обмеження права односторонньої відмови (часто суперечить ст. 907 ЦК)
   - відсутність розділів (персональні дані, спори, приймання, антикорупція)
   - неконкретизовані істотні умови
   - залучення третіх осіб без згоди (ст. 902 ЦК)
   - відсутність строків окремих етапів
2. Дай порівняння договору зі стандартом (5–10 пунктів структури).

ДЛЯ КОЖНОГО РИЗИКУ (finding):
- id: коротке унікальне ID (наприклад "f-prepay", "f-liability", "f-renew")
- level: "high" — суперечить закону або несе критичні втрати; "med" — невигідно; "low" — мінорне
- clause: посилання на пункт договору (наприклад "п. 2.3", "п. 5.2")
- weight: 12 для high, 5 для med, 2 для low
- title: 5–10 слів
- desc: 1–2 речення пояснення
- severity: коротка оцінка ("Критично для Замовника", "Невигідно Замовнику", "Суперечить ст. X ЦК")
- law: РЕАЛЬНА стаття українського кодексу або норми ЄС, у форматі "ст. 693 ЦК України", \
"ст. 907 ЦК України", "Article 17 GDPR". НІКОЛИ не вигадуй номери статей.
- suggest.from: точна цитата з договору (фрагмент, що змінюється)
- suggest.to: запропоноване нове формулювання

ДЛЯ КОЖНОГО ПУНКТА COMPARISON:
- clause: розділ договору ("Предмет договору", "Ціна та порядок розрахунків", …)
- status: "ok" / "warn" (є, але неповний) / "deviate" (є, але невигідні умови) / "missing"
- note: 2–5 слів

Усі формулювання — українською. Точні, юридичні.
"""


# ---------------------------------------------------------------------------
# Claude call
# ---------------------------------------------------------------------------

DEFAULT_MAX_TOKENS = 8000


def generate_findings(
    contract_text: str,
    *,
    client: anthropic.Anthropic | None = None,
    max_tokens: int = DEFAULT_MAX_TOKENS,
) -> dict:
    """Call Claude with structured output → `{findings, comparison}`.

    `client` is injectable for tests.
    """
    settings = get_settings()
    cli = client or _client()

    try:
        response = cli.messages.create(
            model=settings.MODEL_NAME,
            max_tokens=max_tokens,
            system=[{
                "type": "text",
                "text": CONTRACT_ANALYSIS_PROMPT,
                "cache_control": {"type": "ephemeral"},
            }],
            messages=[{"role": "user", "content": contract_text}],
            output_config={
                "format": {
                    "type": "json_schema",
                    "schema": CONTRACT_ANALYSIS_JSON_SCHEMA,
                },
            },
        )
    except anthropic.AuthenticationError as e:
        raise ClaudeError(f"Anthropic authentication failed: {e.message}") from e
    except anthropic.RateLimitError as e:
        raise ClaudeError(f"Anthropic rate limit exceeded: {e.message}") from e
    except anthropic.APIConnectionError as e:
        raise ClaudeError(f"Network error contacting Anthropic: {e}") from e
    except anthropic.APIStatusError as e:
        raise ClaudeError(f"Anthropic API error ({e.status_code}): {e.message}") from e

    raw = "".join(b.text for b in response.content if getattr(b, "type", None) == "text")
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as e:
        raise ClaudeError(f"Claude returned non-JSON output: {raw[:200]}…") from e

    findings = [_normalise_finding(f) for f in parsed.get("findings", [])]
    comparison = [_normalise_comparison(c) for c in parsed.get("comparison", [])]
    usage = response.usage
    return {
        "findings": findings,
        "comparison": comparison,
        "usage": {
            "input_tokens": usage.input_tokens,
            "output_tokens": usage.output_tokens,
            "cache_creation_input_tokens": getattr(usage, "cache_creation_input_tokens", 0) or 0,
            "cache_read_input_tokens": getattr(usage, "cache_read_input_tokens", 0) or 0,
        },
        "model": response.model,
    }


def _normalise_finding(f: dict) -> dict:
    """Pin every finding to the spec shape — adds `kind:'risk'`, defaults."""
    return {
        "id": f.get("id") or "f-unknown",
        "kind": "risk",
        "level": f.get("level") or "med",
        "clause": f.get("clause") or "",
        "weight": int(f.get("weight") or 0),
        "title": f.get("title") or "",
        "desc": f.get("desc") or "",
        "severity": f.get("severity") or "",
        "law": f.get("law") or "",
        "suggest": {
            "from": (f.get("suggest") or {}).get("from", ""),
            "to": (f.get("suggest") or {}).get("to", ""),
        },
    }


def _normalise_comparison(c: dict) -> dict:
    return {
        "clause": c.get("clause") or "",
        "status": c.get("status") or "warn",
        "note": c.get("note") or "",
    }


# ---------------------------------------------------------------------------
# Score (deterministic; mirrors the prototype's DEMO.score weight bands)
# ---------------------------------------------------------------------------

def compute_score(findings: list[dict]) -> dict:
    risks = {"high": 0, "med": 0, "low": 0}
    total_weight = 0
    for f in findings:
        level = f.get("level", "med")
        if level in risks:
            risks[level] += 1
        total_weight += int(f.get("weight") or 0)

    # 100 = clean, 0 = catastrophic. Each high finding (weight 12) drops 12 pts.
    value = max(0, 100 - total_weight)
    if value < 50:
        label = "Високий ризик"
    elif value < 75:
        label = "Помірний ризик"
    else:
        label = "Низький ризик"
    return {"value": value, "label": label, "risks": risks}


# ---------------------------------------------------------------------------
# Legal basis + citation validation
# ---------------------------------------------------------------------------

def _bare_law_number(text: str) -> str | None:
    m = _CITATION_RE.search(text or "")
    return m.group("num").lower() if m else None


def build_legal_basis(conn: sqlite3.Connection, findings: list[dict]) -> list[dict]:
    """Map every cited article number back to its codex row.

    Returns `{code, ref, scope}` per the prototype's `DEMO.legalBasis` shape.
    Articles cited multiple times appear once. Articles not present in the
    codex are skipped here (they show up as warnings via `validate_law_citations`).
    """
    seen_nums: set[str] = set()
    out: list[dict] = []
    for f in findings:
        for m in _CITATION_RE.finditer(f.get("law", "")):
            num = m.group("num").lower()
            if num in seen_nums:
                continue
            seen_nums.add(num)
            # `article_number` stores e.g. "Стаття 651" or "Article 17" — match the
            # number suffix case-insensitively.
            row = conn.execute(
                "SELECT article_number, title, source FROM articles "
                "WHERE LOWER(article_number) LIKE ? LIMIT 1",
                (f"% {num}",),
            ).fetchone()
            if not row:
                continue
            article_no, title, source = row
            out.append({
                "code": source or "",
                "ref": f"{article_no}. {title}" if title else article_no,
                "scope": "EU" if (source or "").startswith("EU") else "UA",
            })
    return out


def validate_law_citations(conn: sqlite3.Connection, findings: list[dict]) -> list[str]:
    """Warn for each cited article number that doesn't exist in the codex.

    Gracefully degrades to a single informational warning when the codex is
    empty — typical state during early development before `scripts/import_codex.py`
    has been run.
    """
    total_articles = conn.execute("SELECT COUNT(*) FROM articles").fetchone()[0]
    if total_articles == 0:
        return ["База кодексів порожня — посилання у findings не валідовано."]

    cited: set[str] = set()
    for f in findings:
        for m in _CITATION_RE.finditer(f.get("law", "")):
            cited.add(m.group("num").lower())
    if not cited:
        return []

    placeholders = " OR ".join("LOWER(article_number) LIKE ?" for _ in cited)
    params = [f"% {n}" for n in cited]
    rows = conn.execute(
        f"SELECT article_number FROM articles WHERE {placeholders}",
        params,
    ).fetchall()
    found_nums: set[str] = set()
    for (article_no,) in rows:
        for m in _CITATION_RE.finditer(f"ст. {article_no.split()[-1]}"):
            found_nums.add(m.group("num").lower())
        # Belt: extract bare number from the stored article_number too.
        tail = article_no.split()[-1] if article_no else ""
        if tail:
            found_nums.add(tail.lower())

    return [
        f"У findings згадано «ст. {num}», але цієї статті немає в завантажених кодексах."
        for num in sorted(cited - found_nums)
    ]


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------

def analyze_contract(
    contract_text: str,
    *,
    conn: sqlite3.Connection | None = None,
    client: anthropic.Anthropic | None = None,
    max_tokens: int = DEFAULT_MAX_TOKENS,
) -> dict:
    """Full Phase 3.1 analysis: Claude → score → legal_basis → citation check."""
    from .database import get_connection

    own_conn = conn is None
    db = conn or get_connection()
    try:
        claude_result = generate_findings(
            contract_text, client=client, max_tokens=max_tokens,
        )
        findings = claude_result["findings"]
        comparison = claude_result["comparison"]
        score = compute_score(findings)
        legal_basis = build_legal_basis(db, findings)
        warnings = validate_law_citations(db, findings)
    finally:
        if own_conn:
            db.close()

    return {
        "findings": findings,
        "comparison": comparison,
        "legal_basis": legal_basis,
        "score": score,
        "warnings": warnings,
        "usage": claude_result["usage"],
        "model": claude_result["model"],
    }
