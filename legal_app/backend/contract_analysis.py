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

# Icons must come from src/ui/Icon.jsx's RAW dict — anything outside this
# enum renders as nothing (Icon returns null on miss). Keeping the enum
# tight avoids the model inventing iconography ("balance-scale", "money").
_KEYDATA_ICON_ENUM = [
    "building", "coins", "calendar", "doc", "pay",
    "clients", "scales", "globe", "shield", "clock",
]


CONTRACT_ANALYSIS_JSON_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["findings", "comparison", "summary", "keyData", "missing"],
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
        # Phase 5: AiPanel's Summary / Data / Missing tabs used to render from
        # frontend DEMO data; the analyzer now produces them so real uploads
        # see real content. Capped lengths via the prompt; the schema only
        # enforces shape.
        "summary": {
            "type": "string",
            "description": "Executive summary in 2-4 sentences. Plain text, no markdown.",
        },
        "keyData": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["label", "value", "sub", "icon"],
                "properties": {
                    "label": {"type": "string"},
                    "value": {"type": "string"},
                    "sub": {"type": "string"},
                    "icon": {"type": "string", "enum": _KEYDATA_ICON_ENUM},
                },
            },
        },
        "missing": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["title", "note", "law"],
                "properties": {
                    "title": {"type": "string"},
                    "note": {"type": "string"},
                    "law": {"type": "string"},
                },
            },
        },
    },
}


# ---------------------------------------------------------------------------
# System prompt
# ---------------------------------------------------------------------------

CONTRACT_ANALYSIS_PROMPT = """Ти — старший адвокат, який швидко переглядає проєкт договору перед \
підписанням. Не "ризик-каталог" і не лекція — практичний звіт: де болить, наскільки серйозно, \
що переписати. Поверни результат у JSON за наданою схемою.

ЗАВДАННЯ:
1. Виявляй РИЗИКИ для слабкішої сторони (зазвичай Замовника). Типові болючі точки, на які варто дивитися \
насамперед: безповоротна передоплата; занижений або символічний ліміт відповідальності; одностороння \
зміна ціни; автоматична пролонгація з довгим вікном відмови; обмеження права односторонньої відмови \
(часто суперечить ст. 907 ЦК); неконкретизовані істотні умови; залучення субпідрядників без згоди \
(ст. 902 ЦК); невизначені строки етапів; відсутність ключових розділів (персональні дані, спори, \
приймання, антикорупція). Список не вичерпний — шукай те, що реально завдасть клієнту шкоди.
2. Дай порівняння договору зі стандартом (5–10 пунктів структури).

ДЛЯ КОЖНОГО РИЗИКУ (finding):
- id: коротке унікальне ID (наприклад "f-prepay", "f-liability", "f-renew").
- level: "high" — суперечить закону або несе критичні втрати; "med" — невигідно; "low" — мінорне.
- clause: посилання на пункт договору ("п. 2.3", "п. 5.2").
- weight: 12 для high, 5 для med, 2 для low.
- title: 5–8 слів. Не назва правової категорії, а суть проблеми ("100% безповоротна передоплата", \
"Відповідальність обмежена 50 000 ₴", "Обмежено право відмови").
- desc: 1–2 речення впевненим практичним тоном. Спочатку — що не так, потім — наслідок для клієнта \
("Ви платите за послуги, зміст яких ще не визначений. Якщо виконавець нічого не зробить — довести \
порушення буде складно."). БЕЗ канцеляризму, БЕЗ цитування повного тексту статей.
- severity: 2–5 слів, прямо ("Критично", "Невигідно Замовнику", "Суперечить ст. 907 ЦК").
- law: РЕАЛЬНА стаття українського кодексу або норми ЄС у форматі "ст. 693 ЦК України", \
"ст. 907 ЦК України", "Article 17 GDPR". НІКОЛИ не вигадуй номери. Якщо не впевнений — не посилайся.
- suggest.from: ДОСЛІВНА цитата з тексту договору, який передано в повідомленні \
користувача — БЕЗ перефразування, БЕЗ додавання чи зміни пунктуації, БЕЗ обʼєднання рядків. \
Перевага коротким унікальним фрагментам 10–30 слів, які гарантовано існують у документі \
один раз. Якщо проблема описана в кількох місцях — обери найкоротший унікальний фрагмент.
- suggest.to: пропозиція переписати — як це сформулював би практик: коротко, недвозначно, \
без шаблонних "на умовах добросовісності та розумності".

ДЛЯ КОЖНОГО ПУНКТА COMPARISON:
- clause: розділ договору ("Предмет договору", "Ціна та порядок розрахунків", …).
- status: "ok" / "warn" (є, але неповний) / "deviate" (є, але невигідні умови) / "missing".
- note: 2–5 слів.

SUMMARY (виконавче резюме):
- 2–4 речення максимум. Перше речення — суть угоди (хто з ким, на що, за скільки). \
Друге — найсильніше / найслабше місце. Третє/четверте (опційно) — ключові ризики чи що відсутнє. \
Пиши як інформативний абзац для керівника, без bullet-list та markdown. Не повторюй \
findings дослівно — це підсумок, не каталог.

KEY DATA (метадані договору):
- 4–8 елементів. Кожен — обʼєкт {label, value, sub, icon}.
- label: коротка назва українською (2–4 слова: "Покупець", "Сума контракту", "Готовність до").
- value: безпосереднє значення з договору (назва компанії, сума з валютою, дата).
- sub: контекст одним рядком (адреса, код, базис, банк) — порожній якщо нічого додати.
- icon — ОБОВ'ЯЗКОВО з цього переліку: \
"building" (компанії/сторони), "coins" (суми/гроші), "calendar" (дати/строки), \
"doc" (тип/предмет), "pay" (умови оплати), "clients" (фіз/юр особи), \
"scales" (право/юрисдикція), "globe" (Incoterms/географія), "shield" (гарантії), \
"clock" (графіки/таймлайн). Будь-яке інше значення FE проігнорує — користуйся лише цим списком.

MISSING (відсутні розділи):
- 0–6 елементів. Не вигадуй "має бути красива преамбула" — тільки реально відсутні розділи, \
що несуть юридичний чи фінансовий ризик.
- title: 3–6 слів ("Антикорупційне застереження", "Pre-Shipment Inspection", \
"Захист персональних даних").
- note: 1–2 речення — чому це потрібно у конкретному контексті цього договору.
- law: правова основа БЕЗ вигадок ("FCPA / UK Bribery Act", "GDPR ст. 6", \
"ст. 505 ЦК"). Порожньо якщо немає однозначної норми.

Усе — українською. Якщо проблем по суті 2–3 — не вигадуй ще; якщо договір токсичний — не пом'якшуй.
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

    raw = "".join(getattr(b, "text", "") for b in response.content if getattr(b, "type", None) == "text")
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as e:
        raise ClaudeError(f"Claude returned non-JSON output: {raw[:200]}…") from e

    findings = [_normalise_finding(f) for f in parsed.get("findings", [])]
    comparison = [_normalise_comparison(c) for c in parsed.get("comparison", [])]
    summary = _normalise_summary(parsed.get("summary"))
    key_data = [_normalise_key_datum(d) for d in parsed.get("keyData", []) if isinstance(d, dict)]
    missing = [_normalise_missing(m) for m in parsed.get("missing", []) if isinstance(m, dict)]
    usage = response.usage
    return {
        "findings": findings,
        "comparison": comparison,
        "summary": summary,
        "keyData": key_data,
        "missing": missing,
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


def _normalise_summary(s) -> str:
    """Coerce to a plain string. Strict-mode schema makes the field required,
    but `null` slips through some Claude paths — defend the FE which renders
    `<p>{summary}</p>` unconditionally."""
    if isinstance(s, str):
        return s
    return ""


_VALID_ICONS = set(_KEYDATA_ICON_ENUM)


def _normalise_key_datum(d: dict) -> dict:
    """Drop bad icon names to '' instead of letting the FE render a broken
    icon slot. Empty `icon` string is fine — Icon component returns null."""
    icon = d.get("icon") or ""
    if icon not in _VALID_ICONS:
        icon = ""
    return {
        "label": d.get("label") or "",
        "value": d.get("value") or "",
        "sub": d.get("sub") or "",
        "icon": icon,
    }


def _normalise_missing(m: dict) -> dict:
    return {
        "title": m.get("title") or "",
        "note": m.get("note") or "",
        "law": m.get("law") or "",
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
    from .mock_ai import is_mock_ai, mock_contract_analysis

    if is_mock_ai():
        return mock_contract_analysis()

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
        # PR-2 of analyze-unification: AiPanel's Summary / Data / Missing
        # tabs no longer fall back to demo data for real analyses.
        "summary": claude_result.get("summary", ""),
        "keyData": claude_result.get("keyData", []),
        "missing": claude_result.get("missing", []),
        "usage": claude_result["usage"],
        "model": claude_result["model"],
    }
