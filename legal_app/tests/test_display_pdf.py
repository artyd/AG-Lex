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


def test_fallback_skipped_for_explicit_absolute_path(tmp_path, monkeypatch):
    """An explicit absolute SOFFICE_PATH that doesn't exist must fail loud —
    we don't silently rewrite it to a fallback even if /usr/bin/soffice
    happens to exist. Pointing at a specific path is a user intent we honor.
    """
    src = tmp_path / "thing.docx"
    src.write_bytes(b"PK\x03\x04 fake docx")
    monkeypatch.setenv("SOFFICE_PATH", "/nope/intentional/soffice")
    get_settings.cache_clear()

    import shutil as _shutil
    real_which = _shutil.which

    def fake_which(cmd, *args, **kwargs):
        # The explicit absolute path doesn't exist…
        if cmd == "/nope/intentional/soffice":
            return None
        # …but a fallback candidate would have resolved if we asked. We
        # assert below that we *didn't* fall back, so this branch should
        # never be hit when SOFFICE_PATH is absolute.
        if cmd == "/usr/bin/soffice":
            return "/usr/bin/soffice"
        return real_which(cmd, *args, **kwargs)

    monkeypatch.setattr(_shutil, "which", fake_which)

    with pytest.raises(DisplayPdfError) as exc:
        to_display_pdf(src)
    assert exc.value.kind == "missing"
    # The error message echoes the user's explicit path, not the fallback.
    assert "/nope/intentional/soffice" in str(exc.value)


@pytest.mark.skipif(sys.platform == "win32", reason="bash stub script is POSIX-only")
def test_fallback_resolves_when_path_lookup_fails(tmp_path, monkeypatch):
    """Reproduce the prod scenario: which('soffice') returns None even though
    /usr/bin/soffice exists (systemd PATH excludes /usr/bin, or sandbox
    hides it). The fallback list should pick it up so the user doesn't
    have to set SOFFICE_PATH manually.
    """
    src = tmp_path / "sample.docx"
    src.write_bytes(b"PK\x03\x04 fake docx body")
    stub = tmp_path / "stub_soffice.sh"
    pdf_payload = _tiny_pdf_bytes()
    stub.write_text(
        "#!/bin/sh\n"
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

    # Default SOFFICE_PATH=soffice (bare name).
    monkeypatch.delenv("SOFFICE_PATH", raising=False)
    get_settings.cache_clear()

    import shutil as _shutil
    real_which = _shutil.which

    def fake_which(cmd, *args, **kwargs):
        if cmd == "soffice":
            # Simulate PATH miss — exactly what the prod systemd unit does.
            return None
        if cmd == "/usr/bin/soffice":
            # First fallback path: pretend it points at our stub script.
            return str(stub)
        return real_which(cmd, *args, **kwargs)

    monkeypatch.setattr(_shutil, "which", fake_which)

    out = to_display_pdf(src)
    assert out.startswith(b"%PDF-")
    assert b"Minimal AG Lex test PDF" in out


@pytest.mark.skipif(sys.platform == "win32", reason="bash stub script is POSIX-only")
def test_crash_kind_carries_stderr_tail(tmp_path, monkeypatch):
    """When soffice exits non-zero we surface its stderr in the
    DisplayPdfError message so the UI banner can show the actual cause —
    reproduces the prod 'exit 127' case where the wrapper script failed to
    find a helper binary and we need the stderr to know why.
    """
    src = tmp_path / "sample.docx"
    src.write_bytes(b"PK\x03\x04 fake docx")
    stub = tmp_path / "stub_crashing_soffice.sh"
    stub.write_text(
        "#!/bin/sh\n"
        # Mimics the soffice wrapper's "exec'd helper not found" path.
        "echo '/usr/lib/libreoffice/program/oosplash: not found' >&2\n"
        "exit 127\n"
    )
    stub.chmod(stub.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
    monkeypatch.setenv("SOFFICE_PATH", str(stub))
    get_settings.cache_clear()

    with pytest.raises(DisplayPdfError) as exc:
        to_display_pdf(src)
    assert exc.value.kind == "crash"
    msg = str(exc.value)
    assert "exit 127" in msg
    assert "oosplash" in msg  # the actual cause now reaches the UI


def test_fallback_misses_raise_kind_missing(tmp_path, monkeypatch):
    """When neither the configured path nor any fallback resolves, we still
    raise DisplayPdfError(kind='missing') with the updated hint about
    SOFFICE_PATH."""
    src = tmp_path / "thing.docx"
    src.write_bytes(b"PK\x03\x04 fake docx")
    monkeypatch.delenv("SOFFICE_PATH", raising=False)
    get_settings.cache_clear()

    import shutil as _shutil
    # which() returns None for absolutely everything.
    monkeypatch.setattr(_shutil, "which", lambda *a, **k: None)

    with pytest.raises(DisplayPdfError) as exc:
        to_display_pdf(src)
    assert exc.value.kind == "missing"
    assert "SOFFICE_PATH" in str(exc.value)


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX PATH semantics")
def test_subprocess_env_path_includes_system_bins(tmp_path, monkeypatch):
    """Reproduces the prod 'exit 127, dirname: not found' failure where the
    systemd unit set PATH=/app/venv/bin only. The soffice wrapper script
    needs /usr/bin (dirname/basename/sed/grep/uname) to compute its own
    install dir. We force-prepend /usr/bin and friends to the child env
    so the wrapper works regardless of the parent PATH.
    """
    src = tmp_path / "doc.docx"
    src.write_bytes(b"PK\x03\x04 fake")

    # Mimic the prod systemd unit: PATH = venv only, soffice resolves via
    # the fallback list (since /usr/bin/soffice "exists" but /usr/bin isn't
    # on PATH for which() — same logic as in prod).
    monkeypatch.setenv("PATH", "/root/ag-lex/legal_app/venv/bin")
    monkeypatch.delenv("SOFFICE_PATH", raising=False)
    get_settings.cache_clear()

    import shutil as _shutil
    import subprocess as _sp

    # Pretend /usr/bin/soffice resolves (it does on prod — just not via the
    # stripped PATH). Return None for the bare name so we take the fallback
    # path; pretend /usr/bin/soffice exists when checked directly.
    def fake_which(cmd, *args, **kwargs):
        if cmd == "soffice":
            return None
        if cmd == "/usr/bin/soffice":
            return "/usr/bin/soffice"
        return None

    monkeypatch.setattr(_shutil, "which", fake_which)

    captured = {}

    def fake_run(cmd, *args, **kwargs):
        captured["env"] = kwargs.get("env") or {}
        captured["cmd"] = cmd
        # Synthesize a valid PDF in --outdir so we get past the empty check.
        outdir = cmd[cmd.index("--outdir") + 1]
        src_arg = cmd[-1]
        pdf_path = Path(outdir) / (Path(src_arg).stem + ".pdf")
        pdf_path.write_bytes(_tiny_pdf_bytes())

        class _Proc:
            returncode = 0
            stdout = b""
            stderr = b""

        return _Proc()

    monkeypatch.setattr(_sp, "run", fake_run)

    to_display_pdf(src)

    path_dirs = captured["env"]["PATH"].split(":")
    # /usr/bin must come BEFORE the venv (we prepend) so the wrapper finds
    # coreutils first.
    assert "/usr/bin" in path_dirs
    assert "/bin" in path_dirs
    assert path_dirs.index("/usr/bin") < path_dirs.index("/root/ag-lex/legal_app/venv/bin")
    # The original parent PATH is preserved, just augmented.
    assert "/root/ag-lex/legal_app/venv/bin" in path_dirs


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
