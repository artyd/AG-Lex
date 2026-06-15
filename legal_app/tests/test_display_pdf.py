"""Phase 4.x — display-PDF pipeline (`documents.to_display_pdf`).

PDF inputs pass through. DOCX/XLSX go through `soffice --headless`.
Missing/crashing/oversize outputs raise `DisplayPdfError` with a distinct
`kind` so the caller can map to a meaningful UX. The soffice path itself
is covered by a stub-script test on POSIX only — Windows runners hit the
endpoint test (`test_display_pdf_endpoint.py`) where a pre-seeded BLOB
bypasses the converter entirely.
"""
from __future__ import annotations

import os
import stat
import sys
from pathlib import Path

import pytest

from backend.config import get_settings
from backend.documents import DisplayPdfError, to_display_pdf


@pytest.fixture(autouse=True)
def _reset_settings_cache():
    """Each test mutates SOFFICE_PATH; clear the lru_cache so changes stick."""
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def _tiny_pdf_bytes() -> bytes:
    # Minimal-but-valid PDF skeleton; enough to satisfy the %PDF- + ≥256 byte
    # checks. Not viewable in real readers, but `to_display_pdf` only validates
    # the magic + size, never tries to parse it.
    body = b"% Minimal AG Lex test PDF " + (b"0" * 300)
    return b"%PDF-1.4\n" + body + b"\n%%EOF"


def test_pdf_passthrough_returns_original_bytes(tmp_path):
    src = tmp_path / "input.pdf"
    data = _tiny_pdf_bytes()
    src.write_bytes(data)
    out = to_display_pdf(src)
    assert out == data


def test_pdf_passthrough_rejects_non_pdf_magic(tmp_path):
    src = tmp_path / "fake.pdf"
    src.write_bytes(b"not really a pdf")
    with pytest.raises(DisplayPdfError) as exc:
        to_display_pdf(src)
    assert exc.value.kind == "empty"


def test_pdf_passthrough_rejects_oversize(tmp_path):
    src = tmp_path / "big.pdf"
    src.write_bytes(_tiny_pdf_bytes())
    with pytest.raises(DisplayPdfError) as exc:
        to_display_pdf(src, max_bytes=64)
    assert exc.value.kind == "too_large"


def test_unsupported_suffix_raises_value_error(tmp_path):
    src = tmp_path / "thing.rtf"
    src.write_bytes(b"nope")
    with pytest.raises(ValueError):
        to_display_pdf(src)


def test_missing_soffice_raises_kind_missing(tmp_path, monkeypatch):
    # Point SOFFICE_PATH at something definitely-not-installed so shutil.which
    # returns None. Any DOCX/XLSX source triggers the lookup before subprocess.
    src = tmp_path / "thing.docx"
    src.write_bytes(b"PK\x03\x04 fake docx")
    monkeypatch.setenv("SOFFICE_PATH", "/no/such/binary_aglex_test")
    get_settings.cache_clear()
    with pytest.raises(DisplayPdfError) as exc:
        to_display_pdf(src)
    assert exc.value.kind == "missing"


@pytest.mark.skipif(sys.platform == "win32", reason="bash stub script is POSIX-only")
def test_stub_soffice_produces_valid_pdf(tmp_path, monkeypatch):
    # Hand-rolled "soffice" shell stub that writes a valid-shaped PDF into
    # whatever directory was passed via --outdir. Keeps the test hermetic and
    # avoids a real LibreOffice install on CI.
    src = tmp_path / "sample.docx"
    src.write_bytes(b"PK\x03\x04 fake docx body")
    stub = tmp_path / "stub_soffice.sh"
    pdf_payload = _tiny_pdf_bytes()
    stub.write_text(
        "#!/bin/sh\n"
        "# Parse out --outdir <dir> and write <stem>.pdf there.\n"
        "outdir=\"\"\n"
        "src=\"\"\n"
        "while [ $# -gt 0 ]; do\n"
        "  case \"$1\" in\n"
        "    --outdir) outdir=\"$2\"; shift 2 ;;\n"
        "    *.docx|*.xlsx|*.pdf) src=\"$1\"; shift ;;\n"
        "    *) shift ;;\n"
        "  esac\n"
        "done\n"
        "stem=$(basename \"$src\" .docx)\n"
        "stem=$(basename \"$stem\" .xlsx)\n"
        "printf '%s' '" + pdf_payload.decode("latin-1") + "' > \"$outdir/$stem.pdf\"\n"
    )
    stub.chmod(stub.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
    monkeypatch.setenv("SOFFICE_PATH", str(stub))
    get_settings.cache_clear()

    out = to_display_pdf(src)
    assert out.startswith(b"%PDF-")
    assert b"Minimal AG Lex test PDF" in out
