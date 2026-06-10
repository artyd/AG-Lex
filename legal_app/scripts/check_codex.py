"""Codex inventory + sample CLI (Fix 3).

Run from `legal_app/`:

    venv\\Scripts\\python.exe scripts\\check_codex.py

Prints the same stats as `GET /api/codex/stats` plus three random articles per
source so you can eyeball that parsing worked (titles aren't truncated mid-word,
content isn't garbled UTF-8, etc.). Exit code 1 if the codex is empty or either
search path looks broken — useful as a deploy-readiness check.
"""
from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.codex import get_codex_stats, sample_articles  # noqa: E402
from backend.database import get_connection  # noqa: E402


SAMPLES_PER_SOURCE = 3


def _print_stats(stats: dict) -> None:
    total = stats["total_articles"]
    print(f"[check_codex] total articles : {total}")
    print(f"[check_codex] FTS5 ready     : {stats['fts_ready']}")
    print(f"[check_codex] sqlite-vec OK  : {stats['vec_ready']}")
    by_source = stats["by_source"]
    if not by_source:
        print("[check_codex] (no rows in `articles`)")
        return
    print("[check_codex] by source:")
    for row in by_source:
        print(f"  - {row['source']:<10} {row['count']:>6}")


def _print_samples(conn) -> None:
    stats = get_codex_stats(conn)
    for row in stats["by_source"]:
        source = row["source"]
        samples = sample_articles(conn, source, n=SAMPLES_PER_SOURCE)
        if not samples:
            continue
        print()
        print(f"=== sample · {source} ({row['count']} total) ===")
        for s in samples:
            head = s["article_number"]
            if s["title"]:
                head += f" · {s['title']}"
            print(f"- {head}")
            preview = (s["preview"] or "").splitlines()
            if preview:
                # Trim further for the CLI; the API caller can pull the full
                # row directly via /api/codex/stats if they need it.
                joined = " ".join(preview)[:160]
                print(f"  {joined}{'…' if len(joined) >= 160 else ''}")


def main() -> int:
    conn = get_connection()
    try:
        stats = get_codex_stats(conn)
        _print_stats(stats)
        _print_samples(conn)
    finally:
        conn.close()

    if stats["total_articles"] == 0:
        print()
        print("[check_codex] FAIL: codex is empty. Drop .txt files into "
              "data/codex_sources/ and run `python scripts/import_codex.py`.")
        return 1
    if not stats["fts_ready"]:
        print()
        print("[check_codex] WARN: FTS5 mirror is out of sync. Re-run the "
              "importer or reinitialise the schema.")
        return 1
    if not stats["vec_ready"]:
        print()
        print("[check_codex] WARN: sqlite-vec failed to load OR no row has an "
              "embedding. Vector search will return nothing.")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
