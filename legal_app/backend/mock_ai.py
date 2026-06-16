"""Deterministic fixtures used when AGLEX_MOCK_AI=1.

Every AI entry point (`pipeline.analyze`, `contract_analysis.analyze_contract`,
`reconciliation.reconcile`) checks `is_mock_ai()` and returns the matching
fixture before touching the Claude SDK. Used by:

- e2e tests (Playwright) so flows are deterministic and don't burn tokens
- offline development when no API_KEY is configured

The fixtures are shape-stable with the real response so the frontend renders
identically; only the contents are canned. The `suggest.from` strings are
chosen to match the sample DOCX shipped in `e2e/fixtures/` — the highlight
mapper finds them verbatim and produces real <mark> overlays.
"""
from __future__ import annotations

import os
import time
from typing import Any


def is_mock_ai() -> bool:
    return os.environ.get("AGLEX_MOCK_AI", "").strip() in {"1", "true", "yes"}


# When mock mode is on the e2e suite uses this stub PDF instead of running
# soffice — keeps CI hermetic and Windows-friendly. Generated once via
# `e2e/fixtures/generate.py` and checked in. Returns None if the fixture
# isn't available so prod code paths never depend on this.
def mock_display_pdf_bytes() -> bytes | None:
    if not is_mock_ai():
        return None
    from pathlib import Path
    candidate = (
        Path(__file__).resolve().parent.parent.parent
        / "e2e" / "fixtures" / "mock_display.pdf"
    )
    try:
        if candidate.is_file():
            return candidate.read_bytes()
    except OSError:
        pass
    return None


# ---------------------------------------------------------------------------
# /api/analyze/contract
# ---------------------------------------------------------------------------

def mock_contract_analysis() -> dict[str, Any]:
    findings = [
        {
            "id": "f-mock-1",
            "level": "high",
            "clause": "п. 4",
            "weight": 12,
            "title": "Штраф 0,5% за кожен день прострочення",
            "desc": "Розмір неустойки не обмежений верхньою межею. ЦКУ ст. 551 ч. 3 дозволяє суду зменшити її.",
            "severity": "критичний",
            "law": "ЦКУ ст. 549, 551",
            "suggest": {
                "from": "0,5% за кожен день прострочення",
                "to": "0,1% за кожен день, але не більше 10% від суми зобов'язання",
            },
        },
        {
            "id": "f-mock-2",
            "level": "med",
            "clause": "п. 6",
            "weight": 5,
            "title": "Право на одностороннє розірвання без причини",
            "desc": "Замовник може розірвати договір у будь-який час без сплати фактично понесених витрат.",
            "severity": "помірний",
            "law": "ЦКУ ст. 651",
            "suggest": {
                "from": "розірвати договір у будь-який час",
                "to": "розірвати договір з письмовим повідомленням за 30 днів та відшкодуванням фактичних витрат",
            },
        },
        {
            "id": "f-mock-3",
            "level": "low",
            "clause": "п. 8",
            "weight": 2,
            "title": "Відсутнє посилання на форс-мажор",
            "desc": "Розділ не містить визначення обставин непереборної сили.",
            "severity": "низький",
            "law": "ЦКУ ст. 617",
            "suggest": {
                "from": "у разі настання обставин",
                "to": "у разі настання обставин непереборної сили (форс-мажор), що підтверджуються довідкою ТПП України",
            },
        },
    ]
    comparison = [
        {"clause": "Предмет договору", "status": "ok",      "note": "Відповідає типовій формі"},
        {"clause": "Штрафні санкції",  "status": "deviate", "note": "Розмір вище ринкового"},
        {"clause": "Форс-мажор",        "status": "missing", "note": "Розділ відсутній"},
        {"clause": "Розірвання",        "status": "warn",    "note": "Одностороннє без обмежень"},
    ]
    legal_basis = [
        {"code": "ЦКУ", "ref": "ст. 549 «Поняття неустойки»",                 "scope": "UA"},
        {"code": "ЦКУ", "ref": "ст. 551 ч. 3 «Зменшення розміру неустойки»", "scope": "UA"},
        {"code": "ЦКУ", "ref": "ст. 617 «Підстави звільнення від відповідальності»", "scope": "UA"},
        {"code": "ЦКУ", "ref": "ст. 651 «Підстави для зміни або розірвання»", "scope": "UA"},
    ]
    score = {"value": 54, "label": "Підвищений ризик", "risks": {"high": 1, "med": 1, "low": 1}}
    # PR-2 of analyze-unification: AiPanel's Summary / Data / Missing tabs
    # now read from the analyzer response. Mock returns plausible content so
    # e2e tests that mount AiPanel can assert non-demo strings.
    summary = (
        "Договір постачання послуг на тестовий проєкт між Покупцем та "
        "Виконавцем. Сильні сторони: чітко зафіксована ціна та валюта. "
        "Ключові ризики: висока пеня без обмеження, можливість одностороннього "
        "розірвання без компенсації, відсутність форс-мажорного застереження."
    )
    key_data = [
        {"icon": "building", "label": "Покупець", "value": "ТОВ «Тест»", "sub": "Київ"},
        {"icon": "building", "label": "Виконавець", "value": "ФОП Іваненко", "sub": "Львів"},
        {"icon": "coins",    "label": "Сума договору", "value": "100 000 ₴", "sub": "без ПДВ"},
        {"icon": "calendar", "label": "Дата підписання", "value": "01.06.2026", "sub": ""},
        {"icon": "pay",      "label": "Умови оплати", "value": "Передоплата 50%", "sub": "Залишок — після приймання"},
    ]
    missing_sections = [
        {"title": "Форс-мажорне застереження", "note": "Розділ відсутній; без нього сторона несе ризик повної відповідальності за невиконання через об'єктивні обставини.", "law": "ст. 617 ЦК України"},
        {"title": "Захист персональних даних", "note": "Сторони обмінюються контактами представників — потрібен пункт про обробку ПД відповідно до GDPR / ЗУ «Про захист ПД».", "law": "GDPR · ЗУ «Про захист ПД»"},
    ]
    return {
        "findings": findings,
        "comparison": comparison,
        "legal_basis": legal_basis,
        "score": score,
        "warnings": [],
        "summary": summary,
        "keyData": key_data,
        "missing": missing_sections,
        "usage": {"input_tokens": 0, "output_tokens": 0, "cached_input_tokens": 0},
        "model": "mock",
    }


# ---------------------------------------------------------------------------
# /api/analyze (chat / RAG)
# ---------------------------------------------------------------------------

def mock_analyze_answer(question: str) -> dict[str, Any]:
    return {
        "answer": (
            "Згідно ЦКУ ст. 549, неустойка (штраф, пеня) — це визначена законом або "
            "договором грошова сума, яку боржник зобов'язаний сплатити кредиторові у разі "
            "порушення зобов'язання. Суд може зменшити розмір неустойки (ЦКУ ст. 551 ч. 3), "
            "якщо вона значно перевищує розмір збитків."
        ),
        "used_articles": [
            {"article_number": "549", "code": "ЦКУ", "title": "Поняття неустойки"},
            {"article_number": "551", "code": "ЦКУ", "title": "Розмір неустойки"},
        ],
        "warnings": [],
        "usage": {"input_tokens": 0, "output_tokens": 0},
        "model": "mock",
    }


# ---------------------------------------------------------------------------
# /api/reconcile (contract ↔ handover)
# ---------------------------------------------------------------------------

def mock_reconciliation() -> dict[str, Any]:
    pair = {
        "product": "Sorbitol Solution 70% BP",
        "counterparty": "KASYAP SWEETNERS PVT LTD",
        "contractNo": "AGL-2026-04-MOCK",
        "date": "01.04.2026",
        "contractFile": "contract.docx",
        "handoverFile": "handover.xlsx",
    }
    rows = [
        {"key": "price",     "name": "Ціна",      "location": "п. 3.1", "status": "ok",       "t3": "USD 1 280/т",  "contract": "USD 1 280/т", "reason": "", "rec": ""},
        {"key": "currency",  "name": "Валюта",   "location": "п. 3.2", "status": "ok",       "t3": "USD",          "contract": "USD",          "reason": "", "rec": ""},
        {"key": "incoterms", "name": "Incoterms", "location": "п. 2.3", "status": "mismatch", "t3": "CIF Odesa",    "contract": "FCA Mumbai",
         "reason": "Базис постачання в Таблиці 3 (CIF) не збігається з контрактом (FCA).",
         "rec":    "Узгодити з логістикою та оновити Таблицю 3 або підписати додаткову угоду."},
        {"key": "payment",   "name": "Оплата",   "location": "п. 4.1", "status": "flag",     "t3": "100% за 30 днів", "contract": "30% передоплата + 70%",
         "reason": "Передача справ передбачає інший графік оплати.",
         "rec":    "Привести Таблицю 3 у відповідність до фактичних умов оплати."},
    ]
    findings = [
        {
            "id": "rec-mock-1",
            "severity": "must",
            "cat": "incoterms",
            "location": "п. 2.3 контракту / поле Incoterms ПД",
            "issue": "Базис постачання відрізняється: CIF Odesa у ПД vs FCA Mumbai у контракті.",
            "rec": "Виправити Таблицю 3 на FCA Mumbai або підписати ДУ до контракту.",
            "verified": "VERIFIED",
            "source": "п. 2.3 контракту",
        },
        {
            "id": "rec-mock-2",
            "severity": "should",
            "cat": "payment",
            "location": "п. 4.1 контракту / поле Оплата ПД",
            "issue": "Графік оплати відрізняється: одноразовий платіж vs передоплата + залишок.",
            "rec": "Узгодити з фінансовим відділом та оновити Таблицю 3.",
            "verified": "VERIFIED",
            "source": "п. 4.1 контракту",
        },
    ]
    docs = {
        "contract": {
            "title": "SUPPLY CONTRACT", "titleUa": "ДОГОВІР ПОСТАЧАННЯ",
            "place": "Mumbai, India", "placeUa": "Мумбаї, Індія",
            "sections": [
                {"n": "2.3", "en": "Delivery basis", "ua": "Базис постачання",
                 "enP": [[{"t": "FCA Mumbai", "cat": "incoterms", "st": "mismatch"}, " per Incoterms 2020."]],
                 "uaP": [[{"t": "FCA Мумбаї", "cat": "incoterms", "st": "mismatch"}, " за Incoterms 2020."]]},
                {"n": "4.1", "en": "Payment terms", "ua": "Умови оплати",
                 "enP": [["30% prepayment, ", {"t": "70% within 14 days of B/L", "cat": "payment", "st": "flag"}, "."]],
                 "uaP": [["30% передоплата, ", {"t": "70% протягом 14 днів з дати коносамента", "cat": "payment", "st": "flag"}, "."]]},
            ],
        },
        "handover": {
            "appendix": "Додаток 1", "title": "Передача справ — Таблиця 3",
            "sub": "Sorbitol Solution 70% BP", "section": "Розділ 1: Фінансові умови",
            "rows": [
                {"n": "1",  "label": "Постачальник",          "v": ["KASYAP SWEETNERS PVT LTD"]},
                {"n": "2",  "label": "Продукт",               "v": ["Sorbitol Solution 70% BP"]},
                {"n": "3",  "label": "Ціна",                   "v": ["USD 1 280/т"], "star": True},
                {"n": "4",  "label": "Валюта",                 "v": ["USD"]},
                {"n": "5",  "label": "Базис постачання",       "v": [{"t": "CIF Odesa", "cat": "incoterms", "st": "mismatch"}], "star": True},
                {"n": "6",  "label": "Оплата",                 "v": [{"t": "100% протягом 30 днів", "cat": "payment", "st": "flag"}], "star": True},
            ],
            "footnote": "Зірочкою позначені обов'язкові поля для звіряння.",
        },
    }
    return {
        "pair": pair,
        "rows": rows,
        "findings": findings,
        "docs": docs,
        "usage": {"input_tokens": 0, "output_tokens": 0},
        "model": "mock",
        "created_at_unix": int(time.time()),
    }
