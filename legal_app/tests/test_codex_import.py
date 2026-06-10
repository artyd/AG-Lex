"""Phase 1.1 tests: codex parsing + idempotent import.

Uses an in-memory SQLite + a fake deterministic embedder so the test suite
doesn't download the 100+ MB Sentence-Transformer model on first run.
"""
from __future__ import annotations

import numpy as np

from backend.database import init_schema, get_connection
from scripts.import_codex import (
    _normalize_codex_text,
    embed_batch,
    import_file,
    parse_articles,
    source_for,
)


UA_CODEX_SAMPLE = """ЦИВІЛЬНИЙ КОДЕКС УКРАЇНИ

Книга перша. Загальні положення.

Стаття 1. Відносини, що регулюються цивільним законодавством

1. Цивільним законодавством регулюються особисті немайнові та майнові відносини
між особами.

2. До майнових відносин, заснованих на адміністративному підпорядкуванні,
цивільне законодавство не застосовується.

Стаття 2. Учасники цивільних відносин

1. Учасниками цивільних відносин є фізичні особи та юридичні особи.

Стаття 651. Підстави для зміни або розірвання договору

1. Зміна або розірвання договору допускається лише за згодою сторін.
"""


EN_CODEX_SAMPLE = """REGULATION (EU) 2016/679 — GDPR

Article 1. Subject-matter and objectives

1. This Regulation lays down rules relating to the protection of natural persons.

Article 5. Principles relating to processing of personal data

1. Personal data shall be processed lawfully, fairly and in a transparent manner.
"""


class FakeEmbedder:
    """Deterministic stand-in for SentenceTransformer.encode used in tests."""

    def encode(self, texts, **_):
        rng = np.random.default_rng(seed=42)
        return rng.random((len(texts), 8), dtype=np.float32)


def test_parse_articles_ua():
    rows = parse_articles(UA_CODEX_SAMPLE, "ЦКУ")
    nums = [r["article_number"] for r in rows]
    assert nums == ["Стаття 1", "Стаття 2", "Стаття 651"]
    assert all(r["source"] == "ЦКУ" for r in rows)
    assert rows[0]["title"].startswith("Відносини, що регулюються")
    assert "Зміна або розірвання договору" in rows[2]["content"]


def test_parse_articles_en():
    rows = parse_articles(EN_CODEX_SAMPLE, "EU_GDPR")
    nums = [r["article_number"] for r in rows]
    assert nums == ["Article 1", "Article 5"]
    assert rows[1]["title"] == "Principles relating to processing of personal data"


def test_parse_skips_inline_references():
    text = "Стаття 5. Перша\n\nЯк зазначено у Стаття 99 цього Кодексу, дія поширюється."
    rows = parse_articles(text, "ЦКУ")
    assert [r["article_number"] for r in rows] == ["Стаття 5"]


def test_embed_batch_shape():
    out = embed_batch(["alpha", "beta"], model=FakeEmbedder())
    assert len(out) == 2
    # 8-dim float32 vector = 32 bytes
    assert all(len(b) == 32 for b in out)


def test_import_file_is_idempotent(tmp_path):
    src_file = tmp_path / "tsku.txt"
    src_file.write_text(UA_CODEX_SAMPLE, encoding="utf-8")

    conn = get_connection(":memory:")
    init_schema(conn)

    parsed1, inserted1 = import_file(src_file, "ЦКУ", conn, model=FakeEmbedder())
    assert (parsed1, inserted1) == (3, 3)

    parsed2, inserted2 = import_file(src_file, "ЦКУ", conn, model=FakeEmbedder())
    assert parsed2 == 3 and inserted2 == 0, "re-import must not duplicate"

    count = conn.execute("SELECT COUNT(*) FROM articles").fetchone()[0]
    assert count == 3

    row = conn.execute(
        "SELECT article_number, title, source, length(embedding) "
        "FROM articles WHERE article_number = ?",
        ("Стаття 651",),
    ).fetchone()
    assert row[2] == "ЦКУ"
    assert row[3] == 32  # fake embedding bytes preserved


def test_source_for_known_and_fallback(tmp_path):
    assert source_for(tmp_path / "tsku.txt") == "ЦКУ"
    assert source_for(tmp_path / "gdpr.md") == "EU_GDPR"
    assert source_for(tmp_path / "mystery.txt") == "MYSTERY"


# ---------------------------------------------------------------------------
# Codex text normalization (handles tsku/kk/kzpp anchor noise + kupap CRLF).
# ---------------------------------------------------------------------------

def test_normalize_strips_anchor_lines():
    text = (
        "Стаття 1. Перша\n"
        "[]{#n1}\n"
        "Тіло статті.\n"
        "[]{#n2}\n"
        "[]{#n3}\n"
        "Ще тіла.\n"
    )
    out = _normalize_codex_text(text)
    assert "[]{#n1}" not in out
    assert "[]{#n2}" not in out
    assert "[]{#n3}" not in out
    assert "Стаття 1. Перша" in out
    assert "Тіло статті." in out
    assert "Ще тіла." in out


def test_normalize_converts_crlf_to_lf():
    text = "Стаття 1.\r\nТіло.\r\nКінець.\r\n"
    out = _normalize_codex_text(text)
    assert "\r" not in out
    assert out == "Стаття 1.\nТіло.\nКінець.\n"


def test_normalize_handles_mixed_crlf_and_anchors():
    """The kupap.txt case combined with tsku.txt — both fixes in one pass."""
    text = "Стаття 212-21.\r\n[]{#n42}\r\nТіло КУпАП.\r\n"
    out = _normalize_codex_text(text)
    assert "\r" not in out
    assert "[]{#n42}" not in out
    assert "Стаття 212-21." in out
    assert "Тіло КУпАП." in out


def test_normalize_passes_through_clean_text_unchanged():
    text = "Стаття 1. Назва\n\nТіло без шуму.\n"
    assert _normalize_codex_text(text) == text


def test_normalize_keeps_inline_brace_anchor_references():
    """Only WHOLE-LINE `[]{#nXXX}` is noise; inline references mustn't be touched."""
    text = "Стаття 1.\nДив. посилання [test]{#nref} у тексті.\n"
    out = _normalize_codex_text(text)
    assert "[test]{#nref}" in out


def test_parse_articles_handles_compound_kupap_numbers():
    """`Стаття 212-21` is real КУпАП format — must parse as one article."""
    text = (
        "Стаття 212-21. Адміністративні правопорушення у сфері медіа\n\n"
        "1. Тіло статті.\n\n"
        "Стаття 213. Підвідомчість справ\n\n"
        "1. Інше тіло.\n"
    )
    rows = parse_articles(text, "КУпАП")
    nums = [r["article_number"] for r in rows]
    assert nums == ["Стаття 212-21", "Стаття 213"]


def test_import_file_normalizes_before_parse(tmp_path):
    """CRLF + anchors in the source file → rows in DB are clean."""
    raw = (
        "Стаття 1. Перша\r\n"
        "[]{#n1}\r\n"
        "Тіло статті.\r\n"
        "\r\n"
        "Стаття 2. Друга\r\n"
        "[]{#n2}\r\n"
        "Ще тіло.\r\n"
    )
    src_file = tmp_path / "kupap.txt"
    # Write the raw CRLF bytes verbatim — no newline translation by the open() layer.
    src_file.write_bytes(raw.encode("utf-8"))

    conn = get_connection(":memory:")
    init_schema(conn)
    parsed, inserted = import_file(src_file, "КУпАП", conn, model=FakeEmbedder())
    assert (parsed, inserted) == (2, 2)

    rows = conn.execute(
        "SELECT article_number, content FROM articles WHERE source = ? ORDER BY article_number",
        ("КУпАП",),
    ).fetchall()
    assert [r[0] for r in rows] == ["Стаття 1", "Стаття 2"]
    for article_no, content in rows:
        assert "\r" not in content, f"{article_no!r} carried a stray \\r byte"
        assert "[]{#n" not in content, f"{article_no!r} carried anchor noise"
