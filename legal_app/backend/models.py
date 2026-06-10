"""Schema for Phase 2.2 workspace data.

Thirteen entities from AG-Lex-Specification §7: matters, tasks, clients,
templates, invoices, time_entries, clause_lib, laws, comments, approval,
deadlines, obligations, versions.

Design notes:
- Primary keys are TEXT, matching the existing prototype IDs (`m1`, `tk1`,
  `cl1`, …). Keeps the React side working without an `id` translation layer
  and makes seeding from `demo.js` / `lx.js` 1:1.
- `comments`, `time_entries`, `versions`, and `tasks.assignee` reference users
  by user_id (TEXT, like `u1`) — they are *display* references for now; not
  foreign-keyed because the prototype IDs (`u1`–`u6`) are separate from
  Phase 2.1's integer `users.id`. Phase 2.3 (RBAC) is when the team gets a
  real `team_members` table, at which point we tighten the FKs.
- Date columns store ISO `YYYY-MM-DD`. The display layer formats to `DD.MM.YYYY`
  per the spec.
- Excluded from this phase per the source doc: litigation, review, esign,
  conflict, portal, due-diligence. They have their own later phases.
"""
from __future__ import annotations

import sqlite3

# 13 tables, all CREATE IF NOT EXISTS so init is idempotent and order-insensitive.
ENTITY_SCHEMA = """
CREATE TABLE IF NOT EXISTS matters (
    id            TEXT PRIMARY KEY,
    code          TEXT NOT NULL UNIQUE,
    title         TEXT NOT NULL,
    client        TEXT NOT NULL,
    type          TEXT,
    status        TEXT NOT NULL DEFAULT 'active',
    lead          TEXT,
    docs          INTEGER NOT NULL DEFAULT 0,
    open_tasks    INTEGER NOT NULL DEFAULT 0,
    hours         REAL NOT NULL DEFAULT 0,
    color         INTEGER
);
CREATE INDEX IF NOT EXISTS idx_matters_status ON matters(status);

CREATE TABLE IF NOT EXISTS tasks (
    id        TEXT PRIMARY KEY,
    title     TEXT NOT NULL,
    matter    TEXT,          -- matter code (e.g. 'SEV-2026-04'), not a numeric FK by design
    assignee  TEXT,          -- user_id like 'u1'
    due       TEXT,          -- ISO YYYY-MM-DD or short 'DD.MM' (legacy seed)
    priority  TEXT,
    col       TEXT NOT NULL DEFAULT 'todo'
);
CREATE INDEX IF NOT EXISTS idx_tasks_matter ON tasks(matter);
CREATE INDEX IF NOT EXISTS idx_tasks_col ON tasks(col);

CREATE TABLE IF NOT EXISTS clients (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    sector     TEXT,
    contracts  INTEGER NOT NULL DEFAULT 0,
    open       INTEGER NOT NULL DEFAULT 0,
    color      INTEGER
);

CREATE TABLE IF NOT EXISTS templates (
    id      TEXT PRIMARY KEY,
    name    TEXT NOT NULL,
    cat     TEXT,
    uses    INTEGER NOT NULL DEFAULT 0,
    fields  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS invoices (
    id      TEXT PRIMARY KEY,
    num     TEXT,
    client  TEXT,
    period  TEXT,
    amount  REAL NOT NULL DEFAULT 0,
    status  TEXT NOT NULL DEFAULT 'draft'
);

CREATE TABLE IF NOT EXISTS time_entries (
    id        TEXT PRIMARY KEY,
    date      TEXT,
    matter    TEXT,
    who       TEXT,
    descr     TEXT,
    hours     REAL NOT NULL DEFAULT 0,
    rate      REAL NOT NULL DEFAULT 0,
    billable  INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_time_entries_matter ON time_entries(matter);

CREATE TABLE IF NOT EXISTS clause_lib (
    id     TEXT PRIMARY KEY,
    cat    TEXT NOT NULL,
    title  TEXT NOT NULL,
    text   TEXT NOT NULL,
    tags   TEXT             -- JSON array of strings, kept opaque on the server
);
CREATE INDEX IF NOT EXISTS idx_clause_lib_cat ON clause_lib(cat);

CREATE TABLE IF NOT EXISTS laws (
    id       TEXT PRIMARY KEY,
    type     TEXT,
    title    TEXT NOT NULL,
    ref      TEXT,
    snippet  TEXT,
    date     TEXT,
    tag      TEXT
);

CREATE TABLE IF NOT EXISTS comments (
    id        TEXT PRIMARY KEY,
    clause    TEXT,
    author    TEXT,
    ts        TEXT,
    text      TEXT NOT NULL,
    mentions  TEXT,          -- JSON array
    resolved  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS approval (
    id      TEXT PRIMARY KEY,
    role    TEXT NOT NULL,
    user_id TEXT,
    status  TEXT NOT NULL DEFAULT 'pending',
    date    TEXT,
    ord     INTEGER NOT NULL DEFAULT 0   -- ordering for the approval chain
);

CREATE TABLE IF NOT EXISTS deadlines (
    id     TEXT PRIMARY KEY,
    date   TEXT,
    title  TEXT NOT NULL,
    basis  TEXT,
    risk   TEXT
);
CREATE INDEX IF NOT EXISTS idx_deadlines_date ON deadlines(date);

CREATE TABLE IF NOT EXISTS obligations (
    id         TEXT PRIMARY KEY,
    title      TEXT NOT NULL,
    party      TEXT,
    freq       TEXT,
    basis      TEXT,
    next_date  TEXT,
    risk       TEXT
);

CREATE TABLE IF NOT EXISTS versions (
    id        TEXT PRIMARY KEY,
    label     TEXT NOT NULL,
    author    TEXT,
    date      TEXT,
    changes   INTEGER NOT NULL DEFAULT 0,
    note      TEXT,
    current   INTEGER NOT NULL DEFAULT 0,
    draft     INTEGER NOT NULL DEFAULT 0
);

-- Phase 3.3: document-builder drafts. Replaces the prototype's
-- localStorage['aglex_drafts'] with a real table so the team library survives
-- browser swaps and per-user state.
-- Fix 1: personal vs team scoping. `user_id` is the author (nullable so
-- legacy rows aren't orphaned); `is_shared = 1` means the whole team sees it.
-- Fresh installs get the full shape via this CREATE; existing DBs get
-- ALTERed by `migrate_drafts()` below.
CREATE TABLE IF NOT EXISTS drafts (
    id                  TEXT PRIMARY KEY,
    type_id             TEXT NOT NULL,
    name                TEXT NOT NULL,
    party               TEXT,
    document_markdown   TEXT NOT NULL,
    params              TEXT,    -- JSON
    options             TEXT,    -- JSON
    created_at          TEXT NOT NULL,
    user_id             INTEGER REFERENCES users(id),
    is_shared           INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_drafts_type ON drafts(type_id);
CREATE INDEX IF NOT EXISTS idx_drafts_created ON drafts(created_at);
-- Indexes on user_id/is_shared live in migrate_drafts() so legacy DBs (which
-- still lack those columns until migration runs) don't crash here.
"""


def migrate_drafts(conn) -> None:
    """Bring an existing `drafts` table up to Fix 1's shape.

    No-op when the columns already exist. Backfill rule: rows with NULL
    `user_id` get `is_shared = 1`, so legacy global drafts become team drafts
    and don't disappear from the UI.
    """
    cols = {row[1] for row in conn.execute("PRAGMA table_info(drafts)").fetchall()}
    if "user_id" not in cols:
        conn.execute("ALTER TABLE drafts ADD COLUMN user_id INTEGER REFERENCES users(id)")
    if "is_shared" not in cols:
        conn.execute("ALTER TABLE drafts ADD COLUMN is_shared INTEGER NOT NULL DEFAULT 0")
        # Backfill: anything without an owner is treated as team-shared so it
        # doesn't vanish from the UI after the migration.
        conn.execute("UPDATE drafts SET is_shared = 1 WHERE user_id IS NULL")
    # Indexes for the new columns. Cheap on small tables; idempotent.
    conn.execute("CREATE INDEX IF NOT EXISTS idx_drafts_user ON drafts(user_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_drafts_shared ON drafts(is_shared)")
    conn.commit()


def init_entity_schema(conn: sqlite3.Connection) -> None:
    """Create all Phase 2.2 tables. Idempotent."""
    conn.executescript(ENTITY_SCHEMA)
    conn.commit()
