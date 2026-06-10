"""Hybrid codex search: vector (sqlite-vec) + keyword (FTS5) fused via RRF.

Three public entry points:

    search_by_vector(query, source=None, limit=5)
    search_by_text(query, source=None, limit=5)
    hybrid_search(query, source=None, limit=5)

Each returns dicts shaped `{id, article_number, title, content, source, score}`
where higher `score` means more relevant. `source` accepts either a string
(`"ЦКУ"`) or a list of strings (`["ЦКУ", "ГКУ"]`) — used to scope queries to
UA codices, EU regulations, or one specific source.

Vectors are produced by the same Sentence-Transformer model the importer used
(`settings.EMBED_MODEL`). Using a different model here would silently return
junk — Phase 1.1's pitfall, called out in the design doc.
"""
from __future__ import annotations

import functools
import re
import sqlite3
from typing import Iterable, Sequence

import numpy as np

from .config import get_settings
from .database import get_connection


DEFAULT_LIMIT = 5
RRF_K = 60


# ---------------------------------------------------------------------------
# embedder cache
# ---------------------------------------------------------------------------

@functools.lru_cache(maxsize=1)
def _default_embedder():
    from sentence_transformers import SentenceTransformer
    return SentenceTransformer(get_settings().EMBED_MODEL)


def _encode_query(query: str, embedder=None) -> bytes:
    model = embedder if embedder is not None else _default_embedder()
    vec = model.encode(
        [query],
        show_progress_bar=False,
        convert_to_numpy=True,
        normalize_embeddings=True,
    )[0]
    return np.asarray(vec, dtype=np.float32).tobytes()


# ---------------------------------------------------------------------------
# source filter
# ---------------------------------------------------------------------------

def _source_clause(source) -> tuple[str, list]:
    if source is None:
        return "", []
    if isinstance(source, str):
        return "AND a.source = ?", [source]
    sources = list(source)
    if not sources:
        return "", []
    placeholders = ",".join("?" * len(sources))
    return f"AND a.source IN ({placeholders})", sources


# ---------------------------------------------------------------------------
# FTS5 query sanitisation
# ---------------------------------------------------------------------------

# Tokenise the user query and quote each word so the FTS5 parser can never see
# a stray quote, paren, or operator. Result: implicit AND across tokens, which
# is what we want for legal-style queries ("розірвання договору" → both words
# must appear).
_WORD_RE = re.compile(r"\w+", re.UNICODE)


def _sanitize_fts(query: str) -> str:
    tokens = _WORD_RE.findall(query)
    return " ".join(f'"{t}"' for t in tokens)


# ---------------------------------------------------------------------------
# row helpers
# ---------------------------------------------------------------------------

_COLUMNS = ("id", "article_number", "title", "content", "source")


def _row_to_dict(row: sqlite3.Row | tuple, score: float) -> dict:
    out = {c: row[i] for i, c in enumerate(_COLUMNS)}
    out["score"] = score
    return out


# ---------------------------------------------------------------------------
# public search functions
# ---------------------------------------------------------------------------

def search_by_vector(
    query: str,
    source=None,
    limit: int = DEFAULT_LIMIT,
    *,
    conn: sqlite3.Connection | None = None,
    embedder=None,
) -> list[dict]:
    """Cosine-nearest articles. Score = 1 - cosine_distance ∈ [-1, 1]."""
    qvec = _encode_query(query, embedder=embedder)
    src_sql, src_args = _source_clause(source)

    sql = f"""
        SELECT a.id, a.article_number, a.title, a.content, a.source,
               vec_distance_cosine(a.embedding, ?) AS distance
        FROM articles a
        WHERE a.embedding IS NOT NULL {src_sql}
        ORDER BY distance ASC
        LIMIT ?
    """
    own_conn = conn is None
    c = conn or get_connection()
    try:
        rows = c.execute(sql, [qvec, *src_args, limit]).fetchall()
    finally:
        if own_conn:
            c.close()

    return [_row_to_dict(r, score=1.0 - r[5]) for r in rows]


def search_by_text(
    query: str,
    source=None,
    limit: int = DEFAULT_LIMIT,
    *,
    conn: sqlite3.Connection | None = None,
) -> list[dict]:
    """BM25 keyword search via FTS5. Score is positive (negated bm25)."""
    fts_query = _sanitize_fts(query)
    if not fts_query:
        return []
    src_sql, src_args = _source_clause(source)

    sql = f"""
        SELECT a.id, a.article_number, a.title, a.content, a.source,
               bm25(articles_fts) AS bm25_score
        FROM articles_fts
        JOIN articles a ON a.id = articles_fts.rowid
        WHERE articles_fts MATCH ? {src_sql}
        ORDER BY bm25_score ASC
        LIMIT ?
    """
    own_conn = conn is None
    c = conn or get_connection()
    try:
        rows = c.execute(sql, [fts_query, *src_args, limit]).fetchall()
    finally:
        if own_conn:
            c.close()

    # bm25 returns more-relevant = more-negative; flip sign so higher = better.
    return [_row_to_dict(r, score=-float(r[5])) for r in rows]


def hybrid_search(
    query: str,
    source=None,
    limit: int = DEFAULT_LIMIT,
    *,
    conn: sqlite3.Connection | None = None,
    embedder=None,
    k: int = RRF_K,
) -> list[dict]:
    """Reciprocal rank fusion of `search_by_vector` + `search_by_text`.

    Each search runs at `limit * 2` so the fusion has slack to combine ranks;
    we then trim to `limit`. Documents present in both lists get the largest
    boost, which is the point of hybrid retrieval.
    """
    own_conn = conn is None
    c = conn or get_connection()
    try:
        wide = max(limit * 2, limit + 5)
        vector_hits = search_by_vector(query, source, wide, conn=c, embedder=embedder)
        text_hits = search_by_text(query, source, wide, conn=c)
    finally:
        if own_conn:
            c.close()

    return _reciprocal_rank_fusion([vector_hits, text_hits], k=k, limit=limit)


# ---------------------------------------------------------------------------
# RRF
# ---------------------------------------------------------------------------

def _reciprocal_rank_fusion(
    ranked_lists: Sequence[Iterable[dict]],
    k: int = RRF_K,
    limit: int = DEFAULT_LIMIT,
) -> list[dict]:
    scores: dict[int, float] = {}
    items: dict[int, dict] = {}
    for ranked in ranked_lists:
        for rank, item in enumerate(ranked, start=1):
            key = item["id"]
            scores[key] = scores.get(key, 0.0) + 1.0 / (k + rank)
            items.setdefault(key, item)

    ordered = sorted(items.values(), key=lambda x: scores[x["id"]], reverse=True)
    out = []
    for item in ordered[:limit]:
        merged = dict(item)
        merged["score"] = scores[item["id"]]
        out.append(merged)
    return out
