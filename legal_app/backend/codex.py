"""Codex inventory + health checks (Fix 3).

The RAG pipeline only works if `articles` is populated and both search paths
(FTS5 and the sqlite-vec embeddings) are usable. This module exposes a single
helper that returns those signals at a glance, plus a small sampler for the
CLI in `scripts/check_codex.py`.
"""
from __future__ import annotations

import sqlite3
from typing import Any


def _fts_ready(conn: sqlite3.Connection, total: int) -> bool:
    """FTS5 mirror exists AND has as many rows as `articles`.

    Phase 1.2 backfills the mirror inside `init_schema`, but a fresh checkout
    or a partial import could leave the two out of sync. Equality is the
    cleanest "search is ready" signal — anything less means a `MATCH` query
    would silently miss rows.
    """
    try:
        row = conn.execute("SELECT COUNT(*) FROM articles_fts").fetchone()
    except sqlite3.OperationalError:
        return False
    return (row[0] if row else 0) == total


def _vec_ready(conn: sqlite3.Connection) -> bool:
    """sqlite-vec is loaded AND at least one article has an embedding.

    Two failure modes worth catching:
      1. The extension didn't load (build issue, mismatched bitness, etc.) —
         `vec_version()` throws `OperationalError`.
      2. The codex was imported without the embedder running (e.g. mid-Phase
         1.1 truncation) — every row has `embedding IS NULL`.
    """
    try:
        conn.execute("SELECT vec_version()").fetchone()
    except sqlite3.OperationalError:
        return False
    row = conn.execute(
        "SELECT COUNT(*) FROM articles WHERE embedding IS NOT NULL"
    ).fetchone()
    return (row[0] if row else 0) > 0


def get_codex_stats(conn: sqlite3.Connection) -> dict[str, Any]:
    """Return `{total_articles, by_source[], fts_ready, vec_ready}`.

    Cheap on any size of `articles` — three indexed counts, plus the vec-load
    probe.
    """
    total_row = conn.execute("SELECT COUNT(*) FROM articles").fetchone()
    total = total_row[0] if total_row else 0

    source_rows = conn.execute(
        "SELECT source, COUNT(*) FROM articles "
        "GROUP BY source ORDER BY COUNT(*) DESC, source"
    ).fetchall()
    by_source = [{"source": r[0], "count": r[1]} for r in source_rows]

    return {
        "total_articles": total,
        "by_source": by_source,
        "fts_ready": _fts_ready(conn, total) if total > 0 else False,
        "vec_ready": _vec_ready(conn) if total > 0 else False,
    }


def sample_articles(
    conn: sqlite3.Connection,
    source: str,
    n: int = 3,
) -> list[dict]:
    """Return up to `n` random articles from `source` for a visual spot-check."""
    rows = conn.execute(
        "SELECT article_number, title, "
        "       substr(content, 1, 200) AS preview "
        "FROM articles WHERE source = ? "
        "ORDER BY RANDOM() LIMIT ?",
        (source, n),
    ).fetchall()
    return [
        {
            "article_number": r[0],
            "title": r[1],
            "preview": (r[2] or "").strip(),
        }
        for r in rows
    ]
