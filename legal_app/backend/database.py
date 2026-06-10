"""SQLite connection + schema for AG Lex.

Phase 1.1: `articles` table stores codex articles (UA + EU) with a per-article
embedding stored as a raw float32 BLOB. The sqlite-vec extension is loaded on
every connection so Phase 1.2 can run vec0/MATCH queries without rewiring.
"""
from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Generator

import sqlite_vec

from .config import get_settings


SCHEMA = """
CREATE TABLE IF NOT EXISTS articles (
    id              INTEGER PRIMARY KEY,
    article_number  TEXT NOT NULL,
    title           TEXT,
    content         TEXT NOT NULL,
    source          TEXT NOT NULL,
    embedding       BLOB,
    UNIQUE(article_number, source)
);

CREATE INDEX IF NOT EXISTS idx_articles_source ON articles(source);

-- FTS5 mirror of articles for keyword search (Phase 1.2).
-- External-content: rows live in `articles`, the FTS index just points at them.
-- unicode61 with default `remove_diacritics 1` plays nice with Ukrainian — it
-- folds Latin diacritics but leaves Cyrillic letters (й, ї, і) distinct, which
-- matters for legal terminology.
CREATE VIRTUAL TABLE IF NOT EXISTS articles_fts USING fts5(
    article_number, title, content, source,
    content='articles', content_rowid='id',
    tokenize='unicode61'
);

CREATE TRIGGER IF NOT EXISTS articles_ai AFTER INSERT ON articles BEGIN
    INSERT INTO articles_fts(rowid, article_number, title, content, source)
    VALUES (new.id, new.article_number, new.title, new.content, new.source);
END;

CREATE TRIGGER IF NOT EXISTS articles_ad AFTER DELETE ON articles BEGIN
    INSERT INTO articles_fts(articles_fts, rowid, article_number, title, content, source)
    VALUES('delete', old.id, old.article_number, old.title, old.content, old.source);
END;

CREATE TRIGGER IF NOT EXISTS articles_au AFTER UPDATE ON articles BEGIN
    INSERT INTO articles_fts(articles_fts, rowid, article_number, title, content, source)
    VALUES('delete', old.id, old.article_number, old.title, old.content, old.source);
    INSERT INTO articles_fts(rowid, article_number, title, content, source)
    VALUES (new.id, new.article_number, new.title, new.content, new.source);
END;
"""

# Run AFTER the schema script so existing rows (e.g. anything imported in
# Phase 1.1 before FTS5 was wired up) get indexed without a re-import.
_FTS_BACKFILL = """
INSERT INTO articles_fts(rowid, article_number, title, content, source)
SELECT a.id, a.article_number, a.title, a.content, a.source
FROM articles a
LEFT JOIN articles_fts f ON f.rowid = a.id
WHERE f.rowid IS NULL;
"""


# Phase 2.1: users + auth schema. `role` is constrained by application logic
# (Pydantic Literal in auth.py), not a SQL CHECK — easier to evolve when
# Phase 2.3 introduces RBAC and additional roles.
USER_SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id              INTEGER PRIMARY KEY,
    email           TEXT UNIQUE NOT NULL,
    name            TEXT NOT NULL,
    role            TEXT NOT NULL,
    password_hash   TEXT NOT NULL,
    created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
"""


def get_connection(
    db_path: str | Path | None = None,
    *,
    check_same_thread: bool = True,
) -> sqlite3.Connection:
    """Open the AG Lex SQLite DB with the sqlite-vec extension loaded.

    `db_path=None` uses `settings.DB_PATH`. Parent directory is created on demand
    so a fresh checkout (empty `database/`) doesn't blow up on first connect.

    `check_same_thread=False` lets a single connection be reused across threads
    — needed for FastAPI TestClient fixtures that share one in-memory DB across
    several test requests, each of which the test harness may dispatch on a
    different thread. Default stays `True` to keep production usage strict.
    """
    path = Path(db_path) if db_path else Path(get_settings().DB_PATH)
    if str(path) != ":memory:":
        path.parent.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(str(path), check_same_thread=check_same_thread)
    conn.enable_load_extension(True)
    sqlite_vec.load(conn)
    conn.enable_load_extension(False)
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_schema(conn: sqlite3.Connection) -> None:
    """Create `articles`, its index, and the FTS5 mirror. Idempotent.

    Also backfills FTS5 for any pre-existing rows so Phase 1.1 data imported
    before Phase 1.2 becomes searchable without re-running the import script.
    """
    conn.executescript(SCHEMA)
    conn.executescript(_FTS_BACKFILL)
    conn.commit()


def init_user_schema(conn: sqlite3.Connection) -> None:
    """Create the `users` table + index. Idempotent. Phase 2.1."""
    conn.executescript(USER_SCHEMA)
    conn.commit()


def get_db() -> Generator[sqlite3.Connection, None, None]:
    """FastAPI dependency: open a connection per request, close on completion.

    Routes consume this via `conn = Depends(get_db)`. Tests can override the
    dependency with `app.dependency_overrides[get_db] = ...` to inject an
    in-memory connection.
    """
    conn = get_connection()
    try:
        yield conn
    finally:
        conn.close()
