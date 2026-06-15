"""Contract ↔ Handover (Table 3) reconciliation.

The procurement team fills a "Лист погодження вопросів по поставці субстанцій"
(Table 3 / handover). Counsel must check that the signed contract matches it
across 15 universal categories. One Claude call extracts both sides, compares
them, and emits a finding list keyed by severity (MUST / SHOULD / NICE / FLAG).

Wire contract (matches the prototype's `compare-data.js` shape):

  pair = {product, counterparty, contractNo, date, contractFile, handoverFile}
  rows[] = {key, name, t3, contract, location, status, reason, rec}
           status ∈ {ok, mismatch, flag, absent, positive}
  findings[] = {id, severity, verified, source, cat, location, issue, rec}
           severity ∈ {must, should, nice, flag}
           verified ∈ {VERIFIED, FLAG}
  docs = {
    contract: {kind, title, titleUa, place, placeUa,
               sections: [{n, en, ua, enP: [parts], uaP: [parts]}]},
    handover: {kind, appendix, title, sub, section,
               rows: [{n, star, label, v: [parts]}], footnote},
  }
  part = str | {t, cat, st}     # cat = one of the 15 keys; st = row status

The Claude call uses `output_config.format = json_schema`, mirroring
`contract_analysis.generate_findings`.
"""
from __future__ import annotations

import json
from typing import Any

import anthropic

from .claude_client import ClaudeError, _client
from .config import get_settings


CATEGORY_KEYS: tuple[str, ...] = (
    "supplier", "product", "price", "quantity", "incoterms", "delivery",
    "payment", "origin", "hscode", "certificates", "packaging", "quality",
    "consignee", "regnumber", "additional",
)

# Sentinel category for plain (non-highlight) paragraph fragments. Lives in
# _PART_SCHEMA's enum so every part can be a single object shape — Anthropic's
# structured-output schema rejects `oneOf` at non-root nodes.
PART_PLAIN = "plain"

ROW_STATUSES = ["ok", "mismatch", "flag", "absent", "positive"]
SEVERITIES = ["must", "should", "nice", "flag"]
VERIFIED_STATES = ["VERIFIED", "FLAG"]


# Part of a paragraph in the rendered contract/handover. ALWAYS an object so
# the schema doesn't need `oneOf` (Anthropic strict mode rejects it). For
# plain text use {t: "...", cat: "plain", st: "ok"}; the FE renderer treats
# `cat == "plain"` as a non-highlighted span.
_PART_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["t", "cat", "st"],
    "properties": {
        "t": {"type": "string"},
        "cat": {"type": "string", "enum": list(CATEGORY_KEYS) + [PART_PLAIN]},
        "st": {"type": "string", "enum": ROW_STATUSES},
    },
}


RECONCILIATION_JSON_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["pair", "rows", "findings", "docs"],
    "properties": {
        "pair": {
            "type": "object",
            "additionalProperties": False,
            "required": ["product", "counterparty", "contractNo", "date"],
            "properties": {
                "product": {"type": "string"},
                "counterparty": {"type": "string"},
                "contractNo": {"type": "string"},
                "date": {"type": "string"},
            },
        },
        "rows": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["key", "name", "t3", "contract", "location", "status", "reason", "rec"],
                "properties": {
                    "key": {"type": "string", "enum": list(CATEGORY_KEYS)},
                    "name": {"type": "string"},
                    "t3": {"type": "string"},
                    "contract": {"type": "string"},
                    "location": {"type": "string"},
                    "status": {"type": "string", "enum": ROW_STATUSES},
                    "reason": {"type": "string"},
                    "rec": {"type": "string"},
                },
            },
        },
        "findings": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["id", "severity", "verified", "source", "cat", "location", "issue", "rec"],
                "properties": {
                    "id": {"type": "string"},
                    "severity": {"type": "string", "enum": SEVERITIES},
                    "verified": {"type": "string", "enum": VERIFIED_STATES},
                    "source": {"type": "string"},
                    "cat": {"type": "string", "enum": list(CATEGORY_KEYS)},
                    "location": {"type": "string"},
                    "issue": {"type": "string"},
                    "rec": {"type": "string"},
                },
            },
        },
        "docs": {
            "type": "object",
            "additionalProperties": False,
            "required": ["contract", "handover"],
            "properties": {
                "contract": {
                    "type": "object",
                    "additionalProperties": False,
                    # Strict mode requires every property in `required`; empty
                    # strings are fine (`_normalise_docs` passes them through).
                    "required": ["kind", "title", "titleUa", "place", "placeUa", "sections"],
                    "properties": {
                        "kind": {"type": "string"},
                        "title": {"type": "string"},
                        "titleUa": {"type": "string"},
                        "place": {"type": "string"},
                        "placeUa": {"type": "string"},
                        "sections": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "additionalProperties": False,
                                "required": ["n", "en", "ua", "enP", "uaP"],
                                "properties": {
                                    "n": {"type": "string"},
                                    "en": {"type": "string"},
                                    "ua": {"type": "string"},
                                    "enP": {"type": "array", "items": _PART_SCHEMA},
                                    "uaP": {"type": "array", "items": _PART_SCHEMA},
                                },
                            },
                        },
                    },
                },
                "handover": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["kind", "appendix", "title", "sub", "section", "footnote", "rows"],
                    "properties": {
                        "kind": {"type": "string"},
                        "appendix": {"type": "string"},
                        "title": {"type": "string"},
                        "sub": {"type": "string"},
                        "section": {"type": "string"},
                        "footnote": {"type": "string"},
                        "rows": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "additionalProperties": False,
                                "required": ["n", "star", "label", "v"],
                                "properties": {
                                    "n": {"type": "string"},
                                    "star": {"type": "boolean"},
                                    "label": {"type": "string"},
                                    "v": {"type": "array", "items": _PART_SCHEMA},
                                },
                            },
                        },
                    },
                },
            },
        },
    },
}


RECONCILIATION_PROMPT = """Ти — старший юрист, який звіряє підписаний договір із внутрішньою \
«передачею справ» (Лист погодження вопросів по поставці субстанцій, Таблиця 3). \
Передача справ — це еталон, який погодив відділ закупівель. Договір — те, що насправді підписав \
постачальник. Твоє завдання — знайти всі суттєві розбіжності і подати їх практично, як це зробив би \
адвокат перед підписанням.

ЗАВДАННЯ:
1. Витягни з ОБОХ документів значення для 15 універсальних категорій:
   supplier (постачальник), product (товар), price (ціна та валюта), quantity (кількість),
   incoterms (Incoterms / місце поставки), delivery (строки поставки), payment (умови оплати),
   origin (країна походження), hscode (код ТН ЗЕД), certificates (MSDS, CoA …),
   packaging (пакування/маркування), quality (вимоги до якості),
   consignee (вантажовідправник/одержувач), regnumber (реєстраційний номер договору),
   additional (додаткові вимоги).
2. Для кожної категорії склади один елемент `rows[]` із полями key, name (людська назва українською),
   t3 (значення з передачі справ), contract (значення з контракту), location (де саме в контракті),
   status, reason (1–2 речення, чому такий статус), rec (порада, що з цим робити; для status=ok можна порожньо).
3. Статуси: ok — значення збігаються; mismatch — є в обох, але різні (напр. 25 kg vs 200 кг);
   flag — є в одному, відсутнє/неоднозначне в іншому; absent — немає в обох; positive — контракт додає
   корисне, чого в передачі справ не було.
4. На розбіжностях побудуй `findings[]` з рівнем severity:
   • must — критично, виправити до підписання (порушення вимог або фінансовий ризик);
   • should — рекомендовано виправити (істотно невигідно або юридично слабко);
   • nice — опціональне покращення формулювання;
   • flag — потребує уваги юриста/логіста, потрібно зʼясувати.
   `verified`: VERIFIED — впевнений на основі тексту обох документів; FLAG — потрібна перевірка людиною.
   `source` — короткою фразою, який «агент» виявив (напр. «Звірка з передачею справ»,
   «Юридично-фінансовий аналіз», «Мова та стиль», «Двомовна звірка», «Галузевий аналіз»).
   `cat` — один з 15 ключів. `location` — розділ контракту або пункт ПД.
   `issue` — суть проблеми 1 реченням. `rec` — конкретна дія.
   Не вигадуй знахідок без підстав; для status=ok знахідок бути не повинно.
5. Заповни `pair`: product (назва товару), counterparty (постачальник), contractNo, date.
6. У `docs.contract` сформуй стислу EN/UA презентацію договору: 3–6 коротких секцій (SUBJECT/ПРЕДМЕТ,
   PRICE/ЦІНА, QUANTITY/КІЛЬКІСТЬ, DELIVERY/ПОСТАВКА тощо). `enP` і `uaP` — масиви фрагментів абзацу.
   КОЖЕН фрагмент — обʼєкт `{t, cat, st}`:
   • для звичайного тексту вказуй `cat: "plain"`, `st: "ok"` — це фрагмент без підсвітки;
   • для ключових значень (ціна, обсяг, Incoterms, строки, реквізити, реєстраційний номер тощо)
     `cat` — один із 15 категорійних ключів, `st` — статус відповідного рядка `rows[]`.
   Це і є інлайн-підсвітка, по якій юрист клікатиме.
7. У `docs.handover` дай форму «Лист погодження вопросів по поставці субстанцій»: appendix (наприклад
   «Додаток №3»), title, sub, section, footnote (короткий примітковий рядок), та `rows` — нумеровані
   поля з label і `v` (масив фрагментів за тим же правилом: звичайний текст → `cat: "plain", st: "ok"`,
   ключові значення → конкретні `cat` і `st`). Заповнюй усі поля; якщо у документі чогось немає —
   ставь порожній рядок або `star: false`.

ВИМОГИ ДО ТОНУ:
- Українською, без канцеляризму, як старший практик.
- Конкретні цифри й посилання. Якщо чогось не видно з тексту — пиши status=flag і пояснюй, що бракує.
- Не дублюй знахідок. Не вигадуй законодавчих посилань — їх давати не потрібно у цьому форматі.
- Поверни СТРОГО JSON за наданою схемою.
"""


DEFAULT_MAX_TOKENS = 12000


def reconcile(
    contract_text: str,
    handover_text: str,
    *,
    client: anthropic.Anthropic | None = None,
    max_tokens: int = DEFAULT_MAX_TOKENS,
) -> dict:
    """Call Claude with structured output → reconciliation payload."""
    from .mock_ai import is_mock_ai, mock_reconciliation
    if is_mock_ai():
        return mock_reconciliation()

    settings = get_settings()
    cli = client or _client()

    user_payload = (
        "<contract>\n"
        f"{contract_text.strip()}\n"
        "</contract>\n\n"
        "<handover_table3>\n"
        f"{handover_text.strip()}\n"
        "</handover_table3>"
    )

    try:
        response = cli.messages.create(
            model=settings.MODEL_NAME,
            max_tokens=max_tokens,
            system=[{
                "type": "text",
                "text": RECONCILIATION_PROMPT,
                "cache_control": {"type": "ephemeral"},
            }],
            messages=[{"role": "user", "content": user_payload}],
            output_config={
                "format": {
                    "type": "json_schema",
                    "schema": RECONCILIATION_JSON_SCHEMA,
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

    pair = _normalise_pair(parsed.get("pair") or {})
    rows = [_normalise_row(r) for r in parsed.get("rows") or []]
    findings = [_normalise_finding(f) for f in parsed.get("findings") or []]
    docs = _normalise_docs(parsed.get("docs") or {})

    usage = response.usage
    return {
        "pair": pair,
        "rows": rows,
        "findings": findings,
        "docs": docs,
        "usage": {
            "input_tokens": usage.input_tokens,
            "output_tokens": usage.output_tokens,
            "cache_creation_input_tokens": getattr(usage, "cache_creation_input_tokens", 0) or 0,
            "cache_read_input_tokens": getattr(usage, "cache_read_input_tokens", 0) or 0,
        },
        "model": response.model,
    }


def _normalise_pair(p: dict) -> dict:
    return {
        "product": p.get("product") or "",
        "counterparty": p.get("counterparty") or "",
        "contractNo": p.get("contractNo") or "",
        "date": p.get("date") or "",
    }


def _normalise_row(r: dict) -> dict:
    status = r.get("status") or "flag"
    if status not in ROW_STATUSES:
        status = "flag"
    key = r.get("key") or ""
    if key not in CATEGORY_KEYS:
        key = "additional"
    return {
        "key": key,
        "name": r.get("name") or "",
        "t3": r.get("t3") or "",
        "contract": r.get("contract") or "",
        "location": r.get("location") or "",
        "status": status,
        "reason": r.get("reason") or "",
        "rec": r.get("rec") or "",
    }


def _normalise_finding(f: dict) -> dict:
    severity = f.get("severity") or "should"
    if severity not in SEVERITIES:
        severity = "should"
    verified = f.get("verified") or "FLAG"
    if verified not in VERIFIED_STATES:
        verified = "FLAG"
    cat = f.get("cat") or "additional"
    if cat not in CATEGORY_KEYS:
        cat = "additional"
    return {
        "id": f.get("id") or "fnd-unknown",
        "severity": severity,
        "verified": verified,
        "source": f.get("source") or "Звірка з передачею справ",
        "cat": cat,
        "location": f.get("location") or "",
        "issue": f.get("issue") or "",
        "rec": f.get("rec") or "",
    }


def _normalise_docs(d: dict) -> dict:
    contract = d.get("contract") or {}
    handover = d.get("handover") or {}
    return {
        "contract": {
            "kind": "contract",
            "title": contract.get("title") or "",
            "titleUa": contract.get("titleUa") or "",
            "place": contract.get("place") or "",
            "placeUa": contract.get("placeUa") or "",
            "sections": [
                {
                    "n": s.get("n") or "",
                    "en": s.get("en") or "",
                    "ua": s.get("ua") or "",
                    "enP": s.get("enP") or [],
                    "uaP": s.get("uaP") or [],
                }
                for s in (contract.get("sections") or [])
            ],
        },
        "handover": {
            "kind": "handover",
            "appendix": handover.get("appendix") or "",
            "title": handover.get("title") or "",
            "sub": handover.get("sub") or "",
            "section": handover.get("section") or "",
            "footnote": handover.get("footnote") or "",
            "rows": [
                {
                    "n": r.get("n") or "",
                    "star": bool(r.get("star")),
                    "label": r.get("label") or "",
                    "v": r.get("v") or [],
                }
                for r in (handover.get("rows") or [])
            ],
        },
    }


def compute_verdict(findings: list[dict]) -> tuple[str, int, int]:
    """Reduce findings → verdict label + must/should counts.

    Returns ("critical" | "minor" | "clean", must_count, should_count).
    """
    must = sum(1 for f in findings if f.get("severity") == "must")
    should = sum(1 for f in findings if f.get("severity") == "should")
    if must > 0:
        return "critical", must, should
    if should > 0 or any(f.get("severity") == "flag" for f in findings):
        return "minor", must, should
    return "clean", must, should
