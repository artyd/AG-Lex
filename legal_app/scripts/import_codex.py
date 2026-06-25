"""Codex importer: parse `data/codex_sources/*` → embed → write to `articles`.

Run from `legal_app/`:

    python scripts/import_codex.py            # imports every file in data/codex_sources/
    python scripts/import_codex.py path.txt   # imports a single file (source from filename)

Idempotent: a UNIQUE(article_number, source) constraint plus INSERT OR IGNORE
mean re-running won't duplicate rows. Articles whose body exceeds the embedding
model's input window are silently truncated by sentence-transformers; this is a
known precision trade-off documented in Phase 1.1.
"""
from __future__ import annotations

import re
import sqlite3
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Sequence

# Make `backend` importable when invoked as `python scripts/import_codex.py`.
HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.config import get_settings  # noqa: E402
from backend.database import get_connection, init_schema  # noqa: E402


CODEX_DIR = ROOT / "data" / "codex_sources"
EMBED_BATCH_SIZE = 64

# Known filename → canonical source code. Anything else falls back to the
# uppercased filename stem (`mylaw.txt` → `MYLAW`).
SOURCE_BY_STEM: dict[str, str] = {
    "tsku": "ЦКУ", "cku": "ЦКУ",
    "gku": "ГКУ", "hku": "ГКУ",
    "kupap": "КУпАП",
    "kk": "КК", "kku": "КК",
    "kzpp": "КЗпП",
    "pku": "ПКУ",
    "spk": "СКУ", "sku": "СКУ",
    "gdpr": "EU_GDPR",
    "dsa": "EU_DSA", "dma": "EU_DMA",
}

# Matches "Стаття 651", "Article 5", "Стаття 651-1", "Article 7a", anchored to
# the start of a line so we don't trip on inline cross-references.
ARTICLE_RE = re.compile(
    r"^[ \t]*"
    r"(?P<marker>Стаття|Article)"
    r"\s+(?P<num>\d+(?:[\-–]\d+)?[a-zа-яёії]?)\b"
    r"\s*\.?\s*"
    r"(?P<title>[^\n]*)",
    re.MULTILINE | re.IGNORECASE,
)

# Markdown anchor lines emitted by the zakon.rada export pipeline (used in the
# Ukrainian-laws-in-time GitHub mirror). Format: `[]{#n123}` on its own line.
# tsku/kk/kzpp have thousands; kupap has none. Always stripped — it's a no-op
# on files that don't contain them.
_ANCHOR_LINE_RE = re.compile(r"^\[\]\{#n\d+\}[ \t]*\r?$", re.MULTILINE)


def _normalize_codex_text(text: str) -> str:
    """File-level cleanup applied to every codex source before parsing.

    - CRLF / lone CR → LF so MULTILINE anchors fire correctly and stored
      article bodies don't carry stray `\\r` bytes. kupap.txt is CRLF-only
      (6395 CRLFs, 0 LFs); the other Ukrainian codices are already LF.
    - Strip `[]{#nXXX}` anchor lines that the zakon-rada export injects above
      every paragraph. They contribute no semantic content but account for
      thousands of throwaway tokens in the embedding input on ЦКУ/КК/КЗпП.

    Idempotent and safe on already-clean input — GDPR passes through untouched.
    """
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = _ANCHOR_LINE_RE.sub("", text)
    return text


@dataclass
class Article:
    article_number: str
    title: str | None
    content: str
    source: str


def parse_articles(text: str, source: str) -> list[dict]:
    """Slice a codex text into articles by `Стаття N` / `Article N` markers.

    Returns dicts shaped `{article_number, title, content, source}`. Articles
    with no body (e.g. orphan headers at end-of-file) are dropped.
    """
    matches = list(ARTICLE_RE.finditer(text))
    out: list[dict] = []
    for i, m in enumerate(matches):
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        marker = m.group("marker").capitalize() if m.group("marker").lower() == "стаття" else "Article"
        number = m.group("num")
        article_number = f"{marker} {number}"
        title_raw = (m.group("title") or "").strip().rstrip(".").strip()
        title = title_raw or None
        body = text[m.end():end].strip()
        if not body:
            continue
        out.append(
            {
                "article_number": article_number,
                "title": title,
                "content": body,
                "source": source,
            }
        )
    return out


def _load_embedder():
    """Lazy import + load so the heavy model isn't pulled in just to parse."""
    from sentence_transformers import SentenceTransformer
    return SentenceTransformer(get_settings().EMBED_MODEL)


def embed_batch(texts: Sequence[str], model=None) -> list[bytes]:
    """Encode `texts` with the configured Sentence-Transformer model.

    Returns one little-endian float32 BLOB per input. `model` is injectable so
    tests can pass a fake without downloading 100+ MB of weights.
    """
    import numpy as np

    if not texts:
        return []
    if model is None:
        model = _load_embedder()
    vectors = model.encode(
        list(texts),
        batch_size=EMBED_BATCH_SIZE,
        show_progress_bar=False,
        convert_to_numpy=True,
        normalize_embeddings=True,
    )
    return [np.asarray(v, dtype=np.float32).tobytes() for v in vectors]


def _existing_keys(conn: sqlite3.Connection, source: str) -> set[str]:
    rows = conn.execute(
        "SELECT article_number FROM articles WHERE source = ?", (source,)
    ).fetchall()
    return {r[0] for r in rows}


def import_file(
    path: str | Path,
    source: str,
    conn: sqlite3.Connection,
    model=None,
) -> tuple[int, int]:
    """Parse `path`, embed new articles, insert. Returns `(parsed, inserted)`."""
    p = Path(path)
    text = p.read_text(encoding="utf-8")
    text = _normalize_codex_text(text)
    parsed = parse_articles(text, source)
    if not parsed:
        return 0, 0

    seen = _existing_keys(conn, source)
    new = [a for a in parsed if a["article_number"] not in seen]
    if not new:
        return len(parsed), 0

    # Embed full article text (title + body) so the vector reflects both.
    embed_inputs = [
        f"{a['article_number']}. {a['title'] or ''}\n{a['content']}".strip()
        for a in new
    ]
    vectors = embed_batch(embed_inputs, model=model)

    rows = [
        (a["article_number"], a["title"], a["content"], a["source"], vec)
        for a, vec in zip(new, vectors)
    ]
    conn.executemany(
        "INSERT OR IGNORE INTO articles "
        "(article_number, title, content, source, embedding) "
        "VALUES (?, ?, ?, ?, ?)",
        rows,
    )
    conn.commit()
    return len(parsed), len(new)


def source_for(path: Path) -> str:
    return SOURCE_BY_STEM.get(path.stem.lower(), path.stem.upper())


def _iter_codex_files(paths: Iterable[Path]) -> Iterable[Path]:
    for p in paths:
        if p.is_dir():
            yield from sorted(x for x in p.iterdir() if x.is_file() and x.suffix in {".txt", ".md"})
        elif p.is_file():
            yield p


def bootstrap_codex(conn: sqlite3.Connection, source_dir: Path | None = None) -> int:
    """Auto-seed the codex on first boot when the articles table is empty.

    Called from FastAPI's lifespan: if the volume is fresh (no rows in
    `articles`), parse every .txt/.md file in `source_dir` (defaults to
    `legal_app/data/codex_sources/`), embed and insert. Returns the number of
    rows inserted; 0 means the table already had data or no sources were
    found. Failures are caller-handled — the lifespan wraps this in try/except
    so a missing model download doesn't break the API boot.
    """
    existing = conn.execute("SELECT COUNT(*) FROM articles").fetchone()[0]
    if existing > 0:
        return 0
    base = source_dir or CODEX_DIR
    if not base.exists():
        print(f"[bootstrap_codex] {base} not found — skipping auto-import.")
        return 0
    files = list(_iter_codex_files([base]))
    if not files:
        print(f"[bootstrap_codex] {base} is empty — nothing to import.")
        return 0
    print(f"[bootstrap_codex] articles table empty — auto-importing {len(files)} codex file(s)…")
    print(f"[bootstrap_codex] loading embedding model ({get_settings().EMBED_MODEL}) — first run downloads weights…")
    model = _load_embedder()
    total_inserted = 0
    for f in files:
        src = source_for(f)
        try:
            _parsed, inserted = import_file(f, src, conn, model=model)
        except Exception as e:  # noqa: BLE001 — log and continue with the rest
            print(f"[bootstrap_codex] {src} ({f.name}): FAILED {e!r}")
            continue
        print(f"[bootstrap_codex] {src} ({f.name}): inserted={inserted}")
        total_inserted += inserted
    grand = conn.execute("SELECT COUNT(*) FROM articles").fetchone()[0]
    print(f"[bootstrap_codex] DONE. inserted={total_inserted} total_in_db={grand}")
    return total_inserted


def main(argv: list[str] | None = None) -> int:
    argv = list(argv if argv is not None else sys.argv[1:])
    targets = [Path(a) for a in argv] if argv else [CODEX_DIR]

    if not any(p.exists() for p in targets):
        print(f"[import_codex] no inputs found. Drop .txt/.md files into {CODEX_DIR} or pass paths as args.")
        return 1

    files = list(_iter_codex_files(targets))
    if not files:
        print(f"[import_codex] {CODEX_DIR} is empty — nothing to import.")
        return 0

    print(f"[import_codex] loading embedding model ({get_settings().EMBED_MODEL}) — first run downloads weights…")
    model = _load_embedder()

    conn = get_connection()
    init_schema(conn)

    total_parsed = 0
    total_inserted = 0
    for f in files:
        src = source_for(f)
        parsed, inserted = import_file(f, src, conn, model=model)
        print(f"[import_codex] {src} ({f.name}): parsed={parsed} inserted={inserted}")
        total_parsed += parsed
        total_inserted += inserted

    grand = conn.execute("SELECT COUNT(*) FROM articles").fetchone()[0]
    print(f"[import_codex] DONE. parsed={total_parsed} inserted={total_inserted} total_in_db={grand}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
