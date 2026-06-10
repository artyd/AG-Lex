"""Phase 1.2 tests: vector, text, and hybrid (RRF) search.

Synthetic 8-dim embeddings are crafted so the relevant article ranks first by
vector distance, while FTS5 BM25 also flags it via the keyword. The hybrid
test then proves RRF rewards documents that win in both rankings.
"""
from __future__ import annotations

import numpy as np
import pytest

from backend.database import get_connection, init_schema
from backend import search as search_mod
from backend.search import (
    _reciprocal_rank_fusion,
    _sanitize_fts,
    hybrid_search,
    search_by_text,
    search_by_vector,
)


# ---------------------------------------------------------------------------
# fixtures
# ---------------------------------------------------------------------------

# (article_number, title, content, source, vec_8d)
SEED = [
    (
        "Стаття 651",
        "Підстави для розірвання договору",
        "Розірвання договору допускається лише за згодою сторін або за рішенням суду.",
        "ЦКУ",
        [1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
    ),
    (
        "Стаття 652",
        "Зміна або розірвання у звʼязку з істотною зміною обставин",
        "У разі істотної зміни обставин договір може бути змінений або розірваний.",
        "ЦКУ",
        [0.95, 0.05, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
    ),
    (
        "Стаття 1",
        "Загальні положення",
        "Цей Кодекс регулює особисті немайнові та майнові відносини між особами.",
        "ЦКУ",
        [0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
    ),
    (
        "Article 5",
        "Principles relating to processing of personal data",
        "Personal data shall be processed lawfully, fairly and transparently.",
        "EU_GDPR",
        [0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0],
    ),
    (
        "Article 17",
        "Right to erasure",
        "Data subject may request erasure and termination of processing.",
        "EU_GDPR",
        [0.5, 0.0, 0.5, 0.0, 0.0, 0.0, 0.0, 0.0],
    ),
]


def _normalize(v):
    arr = np.asarray(v, dtype=np.float32)
    n = np.linalg.norm(arr)
    return arr / n if n else arr


class CraftedEmbedder:
    """Maps any query containing one of the keywords to the matching seed vector.

    Lets us steer vector-search ranking deterministically without loading the
    real Sentence-Transformer model in CI.
    """

    def __init__(self, mapping: dict[str, list[float]]):
        # store normalised so cosine distance lines up with the seed rows
        self.mapping = {k: _normalize(v) for k, v in mapping.items()}

    def encode(self, texts, **_):
        out = []
        for t in texts:
            low = t.lower()
            chosen = next(
                (v for k, v in self.mapping.items() if k in low),
                np.zeros(8, dtype=np.float32),
            )
            out.append(chosen)
        return np.asarray(out, dtype=np.float32)


@pytest.fixture
def conn():
    c = get_connection(":memory:")
    init_schema(c)
    for art_no, title, content, src, vec in SEED:
        v = _normalize(vec).tobytes()
        c.execute(
            "INSERT INTO articles (article_number, title, content, source, embedding) "
            "VALUES (?, ?, ?, ?, ?)",
            (art_no, title, content, src, v),
        )
    c.commit()
    yield c
    c.close()


@pytest.fixture
def embedder():
    return CraftedEmbedder({
        "розірвання": [1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
        "termination": [0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0],
        "загальні": [0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
    })


@pytest.fixture(autouse=True)
def _clear_embedder_cache():
    search_mod._default_embedder.cache_clear()
    yield


# ---------------------------------------------------------------------------
# tests
# ---------------------------------------------------------------------------

def test_search_by_vector_orders_by_cosine(conn, embedder):
    hits = search_by_vector("розірвання договору", conn=conn, embedder=embedder, limit=3)
    nums = [h["article_number"] for h in hits]
    assert nums[0] == "Стаття 651"
    assert nums[1] == "Стаття 652"
    assert hits[0]["score"] > hits[1]["score"] > hits[-1]["score"]
    assert all(set(h.keys()) >= {"article_number", "title", "content", "source", "score"} for h in hits)


def test_search_by_text_uses_bm25_and_finds_keyword(conn):
    hits = search_by_text("розірвання", conn=conn, limit=5)
    nums = {h["article_number"] for h in hits}
    # Both UA articles contain the word; the GDPR rows do not.
    assert {"Стаття 651", "Стаття 652"}.issubset(nums)
    assert "Article 5" not in nums


def test_search_by_text_empty_query_returns_nothing(conn):
    assert search_by_text("   !@#$  ", conn=conn) == []


def test_source_filter_accepts_string(conn, embedder):
    hits = search_by_vector("termination", source="EU_GDPR", conn=conn, embedder=embedder, limit=5)
    assert all(h["source"] == "EU_GDPR" for h in hits)
    assert {h["article_number"] for h in hits} == {"Article 5", "Article 17"}


def test_source_filter_accepts_list(conn, embedder):
    hits = hybrid_search(
        "розірвання договору",
        source=["ЦКУ", "ГКУ"],
        conn=conn,
        embedder=embedder,
        limit=5,
    )
    assert {h["source"] for h in hits} == {"ЦКУ"}


def test_hybrid_search_rewards_overlap(conn, embedder):
    hits = hybrid_search("розірвання договору", conn=conn, embedder=embedder, limit=3)
    nums = [h["article_number"] for h in hits]
    # Стаття 651 wins in both vector and text rankings — RRF should put it first.
    assert nums[0] == "Стаття 651"
    # All hybrid hits must carry the RRF score
    assert all(h["score"] > 0 for h in hits)


def test_hybrid_search_finds_vector_only_match(conn, embedder):
    """A query whose words aren't in any article should still get vector hits."""
    embedder.mapping["неіснуюче_слово"] = _normalize([1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0])
    hits = hybrid_search("неіснуюче_слово", conn=conn, embedder=embedder, limit=3)
    assert hits, "vector path must rescue when keyword path is empty"
    assert hits[0]["article_number"] == "Стаття 651"


def test_rrf_unit_math():
    a = [{"id": 1}, {"id": 2}, {"id": 3}]
    b = [{"id": 2}, {"id": 1}, {"id": 4}]
    fused = _reciprocal_rank_fusion([a, b], k=60, limit=4)
    ids = [h["id"] for h in fused]
    # id 1 and id 2 appear in both lists, so they should outrank 3 and 4.
    assert ids[:2] in ([1, 2], [2, 1])
    assert set(ids[2:]) == {3, 4}


def test_sanitize_fts_quotes_tokens_and_drops_punctuation():
    assert _sanitize_fts("розірвання договору (стаття 651)") == '"розірвання" "договору" "стаття" "651"'
    assert _sanitize_fts("   ") == ""
