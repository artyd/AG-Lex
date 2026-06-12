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

-- Contract ↔ Handover (Table 3) reconciliations. One row per run.
CREATE TABLE IF NOT EXISTS reconciliations (
    id             TEXT PRIMARY KEY,
    user_id        INTEGER REFERENCES users(id),
    contract_file  TEXT,
    handover_file  TEXT,
    product        TEXT,
    counterparty   TEXT,
    verdict        TEXT,           -- critical | minor | clean
    must_count     INTEGER NOT NULL DEFAULT 0,
    should_count   INTEGER NOT NULL DEFAULT 0,
    pair_json      TEXT NOT NULL,
    rows_json      TEXT NOT NULL,
    findings_json  TEXT NOT NULL,
    docs_json      TEXT NOT NULL,
    created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reconciliations_user ON reconciliations(user_id);
CREATE INDEX IF NOT EXISTS idx_reconciliations_created ON reconciliations(created_at);

-- Phase 2.4: realtime collaboration. Six new tables turn `matters` into a
-- shared workspace with row-level access (case_members), richer child data
-- (case_hearings, case_parties, case_notes), an append-only edit trail
-- (activity_log), and per-user notifications. user_id columns stay TEXT to
-- match the prototype identifiers (`u1`, `u2`, …); the bridge to the auth
-- INTEGER users.id lives in users.legacy_id (see migrate_users).
CREATE TABLE IF NOT EXISTS case_members (
    case_id        TEXT NOT NULL,
    user_id        TEXT NOT NULL,
    role_in_case   TEXT NOT NULL DEFAULT 'collaborator',  -- lead | collaborator
    added_at       TEXT NOT NULL,
    added_by       TEXT,
    PRIMARY KEY (case_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_case_members_user ON case_members(user_id);
CREATE INDEX IF NOT EXISTS idx_case_members_case ON case_members(case_id);

CREATE TABLE IF NOT EXISTS case_hearings (
    id          TEXT PRIMARY KEY,
    case_id     TEXT NOT NULL,
    date        TEXT NOT NULL,           -- ISO YYYY-MM-DD
    court       TEXT,
    judge       TEXT,
    location    TEXT,
    outcome     TEXT,
    notes       TEXT,
    created_at  TEXT NOT NULL,
    created_by  TEXT
);
CREATE INDEX IF NOT EXISTS idx_case_hearings_case ON case_hearings(case_id);
CREATE INDEX IF NOT EXISTS idx_case_hearings_date ON case_hearings(date);

CREATE TABLE IF NOT EXISTS case_parties (
    id        TEXT PRIMARY KEY,
    case_id   TEXT NOT NULL,
    role      TEXT NOT NULL,             -- client | clientRep | opponent | opponentRep | court | judge | other
    name      TEXT NOT NULL,
    contact   TEXT,
    notes     TEXT
);
CREATE INDEX IF NOT EXISTS idx_case_parties_case ON case_parties(case_id);

CREATE TABLE IF NOT EXISTS case_notes (
    id          TEXT PRIMARY KEY,
    case_id     TEXT NOT NULL,
    author_id   TEXT,
    text        TEXT NOT NULL,
    created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_case_notes_case ON case_notes(case_id);

CREATE TABLE IF NOT EXISTS activity_log (
    id          TEXT PRIMARY KEY,
    case_id     TEXT NOT NULL,
    user_id     TEXT,
    action      TEXT NOT NULL,            -- case.created | case.updated | task.added | …
    field       TEXT,                     -- column name for case.updated, else null
    old_value   TEXT,
    new_value   TEXT,
    created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activity_log_case ON activity_log(case_id, created_at);

CREATE TABLE IF NOT EXISTS notifications (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    case_id     TEXT,
    type        TEXT NOT NULL,            -- member.added | case.updated | task.assigned | …
    message     TEXT,
    payload     TEXT,                     -- JSON blob with extra context
    is_read     INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read);
CREATE INDEX IF NOT EXISTS idx_notifications_case ON notifications(case_id);
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


def migrate_users(conn) -> None:
    """Phase 2.4: add legacy_id bridge to auth users.

    The auth `users` table uses INTEGER PKs (Phase 2.1), but the rest of the
    domain (`matters.lead`, `tasks.assignee`, `case_members.user_id`, …) uses
    the prototype TEXT identifiers `u1, u2, …`. `legacy_id` lets us map
    deterministically without renumbering everything.

    No-op when the column already exists. Backfill: rows without a
    legacy_id get one fabricated as `u{users.id}` so case_members lookups
    never see NULL.
    """
    cols = {row[1] for row in conn.execute("PRAGMA table_info(users)").fetchall()}
    if "legacy_id" not in cols:
        conn.execute("ALTER TABLE users ADD COLUMN legacy_id TEXT")
        # Backfill so subsequent JOINs against case_members never miss.
        conn.execute(
            "UPDATE users SET legacy_id = 'u' || id WHERE legacy_id IS NULL"
        )
    # UNIQUE constraint can't be added by ALTER in SQLite, so enforce via index.
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS uniq_users_legacy_id "
        "ON users(legacy_id) WHERE legacy_id IS NOT NULL"
    )
    conn.commit()


def migrate_matters(conn) -> None:
    """Phase 2.4: extend matters with the full case shape.

    The original `matters` table had a minimal card-only shape. Realtime
    Matters needs richer columns to back the detail view: summary, parties
    metadata that doesn't fit a child row (court/judge live on the case
    itself for fast list rendering), priority, outcome+closed_at for the
    close-modal flow, next_deadline+next_label for the always-visible
    "наступний крок" card, and updated_at for the last-write-wins PATCH.

    No-op when columns already exist. New columns default to NULL; only
    started_at is backfilled (using today's date) because the UI uses it
    to anchor the timeline and an unknown value there breaks sorting.
    """
    cols = {row[1] for row in conn.execute("PRAGMA table_info(matters)").fetchall()}
    additions = [
        ("summary", "TEXT"),
        ("priority", "TEXT DEFAULT 'med'"),
        ("opponent", "TEXT"),
        ("court", "TEXT"),
        ("judge", "TEXT"),
        ("outcome", "TEXT"),
        ("next_deadline", "TEXT"),
        ("next_label", "TEXT"),
        ("description", "TEXT"),
        ("started_at", "TEXT"),
        ("closed_at", "TEXT"),
        ("updated_at", "TEXT"),
    ]
    for col, ddl in additions:
        if col not in cols:
            conn.execute(f"ALTER TABLE matters ADD COLUMN {col} {ddl}")
    # Backfill: rows added before this migration have no started_at; assume
    # they started today so the timeline renders something rather than `—`.
    conn.execute(
        "UPDATE matters SET started_at = date('now') WHERE started_at IS NULL"
    )
    conn.commit()


def init_entity_schema(conn: sqlite3.Connection) -> None:
    """Create all Phase 2.2 + 2.4 tables. Idempotent."""
    conn.executescript(ENTITY_SCHEMA)
    conn.commit()
