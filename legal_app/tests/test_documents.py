"""Phase 1.3 tests: parse contract markdown into sections + upload endpoint.

Generates a tiny PDF on the fly with PyMuPDF so the conversion round-trip can
run in CI without checked-in binary fixtures. DOCX is exercised only at the
dispatch level — building a valid .docx from scratch in a unit test isn't
worth the complexity for an MVP.
"""
from __future__ import annotations

import io
from pathlib import Path

import pymupdf
import pytest
from fastapi.testclient import TestClient

from backend.documents import (
    detect_type_and_convert,
    detect_type_and_extract_raw,
    estimate_tokens,
    split_into_sections,
    token_savings,
)
from backend.main import app


# ---------------------------------------------------------------------------
# fixtures
# ---------------------------------------------------------------------------

SAMPLE_CONTRACT_MD = """# Договір №42

Місто Київ, 10 січня 2026 року.

## Розділ I. Загальні положення

Цей договір укладено між Сторонами на нижченаведених умовах.

## Стаття 1. Предмет договору

1. Виконавець зобовʼязується надати юридичні послуги.

2. Замовник зобовʼязується оплатити надані послуги.

### 2.1 Порядок оплати

Оплата здійснюється протягом 5 робочих днів.

### 2.2 Звітність

Виконавець подає щомісячний звіт.

## Стаття 2. Відповідальність сторін

п. 3.1 Сторона, що порушила умови, сплачує неустойку.

п. 3.2 Розмір неустойки — 0.1% від суми договору за кожен день прострочення.
"""


def _make_pdf_bytes(text: str) -> bytes:
    doc = pymupdf.open()
    page = doc.new_page()
    # PyMuPDF's built-in helv font can't render Cyrillic glyphs reliably across
    # versions, so the round-trip fixture stays ASCII. Section regex tested
    # against Ukrainian markdown directly above.
    page.insert_text((72, 72), text, fontname="helv", fontsize=11)
    buf = io.BytesIO()
    doc.save(buf)
    doc.close()
    return buf.getvalue()


@pytest.fixture
def tmp_pdf(tmp_path) -> Path:
    p = tmp_path / "tiny.pdf"
    p.write_bytes(_make_pdf_bytes("Stattya 1. General terms.\n\nThe parties agree to the following."))
    return p


@pytest.fixture
def client():
    return TestClient(app)


# ---------------------------------------------------------------------------
# section splitter
# ---------------------------------------------------------------------------

def test_split_finds_rozdil_stattya_decimal_and_punkt():
    sections = split_into_sections(SAMPLE_CONTRACT_MD)
    numbers = [s["number"] for s in sections if s["number"]]
    # Expect at least: Розділ I, Стаття 1, 2.1, 2.2, Стаття 2, п. 3.1, п. 3.2
    assert any(n.startswith("Розділ") for n in numbers)
    assert "Стаття 1" in numbers
    assert "Стаття 2" in numbers
    assert "2.1" in numbers
    assert "2.2" in numbers
    assert any(n.startswith("п.") and "3.1" in n for n in numbers)
    assert any(n.startswith("п.") and "3.2" in n for n in numbers)


def test_split_keeps_preamble_as_unnumbered_section():
    sections = split_into_sections(SAMPLE_CONTRACT_MD)
    assert sections[0]["number"] is None
    assert "Київ" in sections[0]["text"]


def test_split_skips_inline_references():
    md = "Стаття 5. Початок\n\nЯк зазначено у Статті 99, дія поширюється на всіх."
    sections = split_into_sections(md)
    numbers = [s["number"] for s in sections if s["number"]]
    assert numbers == ["Стаття 5"]


def test_split_empty_markdown_returns_empty_list():
    assert split_into_sections("") == []
    assert split_into_sections("   \n\n  ") == []


def test_split_no_markers_returns_single_section():
    md = "Just plain text with no section markers at all."
    out = split_into_sections(md)
    assert len(out) == 1
    assert out[0]["number"] is None
    assert out[0]["text"] == md.strip()


# ---------------------------------------------------------------------------
# tokens
# ---------------------------------------------------------------------------

def test_estimate_tokens_basic():
    assert estimate_tokens("") == 0
    assert estimate_tokens(None) == 0
    assert estimate_tokens("abcd") == 1
    assert estimate_tokens("a" * 400) == 100


def test_token_savings_shape():
    stats = token_savings("a" * 1000, "b" * 500)
    assert stats == {"raw_tokens": 250, "markdown_tokens": 125, "savings_pct": 50.0}


def test_token_savings_zero_raw_safe():
    stats = token_savings("", "anything")
    assert stats["savings_pct"] == 0.0


# ---------------------------------------------------------------------------
# converter dispatch
# ---------------------------------------------------------------------------

def test_detect_type_rejects_unknown_suffix(tmp_path):
    p = tmp_path / "foo.txt"
    p.write_text("hi")
    with pytest.raises(ValueError, match="Unsupported file type"):
        detect_type_and_convert(p)
    with pytest.raises(ValueError, match="Unsupported file type"):
        detect_type_and_extract_raw(p)


def test_pdf_round_trip_extracts_text(tmp_pdf):
    md = detect_type_and_convert(tmp_pdf)
    raw = detect_type_and_extract_raw(tmp_pdf)
    assert "Stattya" in md
    assert "Stattya" in raw
    assert md.strip(), "markdown should not be empty"


# ---------------------------------------------------------------------------
# /api/upload endpoint
# ---------------------------------------------------------------------------

def test_upload_rejects_unsupported_extension(client):
    r = client.post(
        "/api/upload",
        files={"file": ("note.txt", b"hello", "text/plain")},
    )
    assert r.status_code == 415


def test_upload_rejects_empty_file(client):
    r = client.post(
        "/api/upload",
        files={"file": ("empty.pdf", b"", "application/pdf")},
    )
    assert r.status_code == 400


def test_upload_returns_markdown_sections_and_token_stats(client, tmp_pdf):
    r = client.post(
        "/api/upload",
        files={"file": ("contract.pdf", tmp_pdf.read_bytes(), "application/pdf")},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["filename"] == "contract.pdf"
    assert "Stattya" in body["markdown"]
    assert isinstance(body["sections"], list) and body["sections"]
    stats = body["token_stats"]
    assert {"raw_tokens", "markdown_tokens", "savings_pct"} <= stats.keys()
    assert stats["raw_tokens"] > 0
