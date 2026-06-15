"""Generic SQL CRUD + FastAPI router factory for Phase 2.2 entities.

Each of the 13 workspace entities follows the same shape: a flat row, a TEXT
primary key, no joins. The `Entity` class captures that pattern once; each
table becomes a 4-line declaration. A single `build_router` then mounts five
standard endpoints, all gated by `current_user`.

Why not Pydantic models per entity:
The columns are evolving (especially in Phases 3.x), the wire shape mirrors
the row 1:1, and FastAPI doesn't need a typed model to JSON-encode a dict.
Tightening schemas is straightforward later; the cost now is rigidity.
"""
from __future__ import annotations

import json
import sqlite3
import uuid
from dataclasses import dataclass, field
from typing import Any, Iterable

from fastapi import APIRouter, Body, Depends, HTTPException, status

from .auth import current_user
from .database import get_db
from .rbac import require


# ---------------------------------------------------------------------------
# Entity descriptor
# ---------------------------------------------------------------------------

@dataclass
class Entity:
    """Per-table metadata used by the CRUD helpers and the router factory."""

    table: str
    pk: str = "id"
    # All non-pk columns the API accepts on create/update.
    columns: tuple[str, ...] = field(default_factory=tuple)
    # Columns whose row value is JSON-encoded TEXT but should appear as
    # arrays/objects on the wire. Decoded on read, encoded on write.
    json_columns: frozenset[str] = field(default_factory=frozenset)
    # Wire-name → DB-name. Used to keep React's camelCase ("openTasks",
    # "nextDate") while the table stores snake_case ("open_tasks",
    # "next_date"). Both directions auto-derived from one mapping.
    column_aliases: dict[str, str] = field(default_factory=dict)
    # Prefix for auto-generated IDs (e.g. 'm' → 'm-7c12…').
    id_prefix: str = ""

    @property
    def all_columns(self) -> tuple[str, ...]:
        return (self.pk, *self.columns)

    @property
    def db_to_wire(self) -> dict[str, str]:
        return {v: k for k, v in self.column_aliases.items()}

    def wire_field(self, db_col: str) -> str:
        return self.db_to_wire.get(db_col, db_col)

    def db_field(self, wire_col: str) -> str:
        return self.column_aliases.get(wire_col, wire_col)

    def new_id(self) -> str:
        return f"{self.id_prefix}{uuid.uuid4().hex[:8]}" if self.id_prefix else uuid.uuid4().hex


# ---------------------------------------------------------------------------
# Row encoding / decoding
# ---------------------------------------------------------------------------

def _row_to_dict(entity: Entity, row: sqlite3.Row | tuple | None) -> dict | None:
    if row is None:
        return None
    out: dict[str, Any] = {}
    for db_col, value in zip(entity.all_columns, row):
        if db_col in entity.json_columns and isinstance(value, str):
            try:
                value = json.loads(value)
            except json.JSONDecodeError:
                pass
        out[entity.wire_field(db_col)] = value
    return out


def _wire_to_db(entity: Entity, payload: dict) -> dict:
    """Translate a wire payload (camelCase, JSON-decoded) to a DB row dict.

    Only known columns are kept — extras are silently dropped, which keeps
    the frontend free to ship richer objects than the table strictly tracks.
    """
    result: dict[str, Any] = {}
    accepted = {*entity.columns, entity.pk}
    for wire_key, value in payload.items():
        db_key = entity.db_field(wire_key)
        if db_key not in accepted:
            continue
        if db_key in entity.json_columns and not isinstance(value, (str, type(None))):
            value = json.dumps(value, ensure_ascii=False)
        result[db_key] = value
    return result


# ---------------------------------------------------------------------------
# SQL operations
# ---------------------------------------------------------------------------

def list_rows(conn: sqlite3.Connection, entity: Entity) -> list[dict]:
    cols = ", ".join(entity.all_columns)
    rows = conn.execute(f"SELECT {cols} FROM {entity.table}").fetchall()
    return [_row_to_dict(entity, r) for r in rows]


def get_row(conn: sqlite3.Connection, entity: Entity, pk_value: str) -> dict | None:
    cols = ", ".join(entity.all_columns)
    row = conn.execute(
        f"SELECT {cols} FROM {entity.table} WHERE {entity.pk} = ?",
        (pk_value,),
    ).fetchone()
    return _row_to_dict(entity, row)


def insert_row(conn: sqlite3.Connection, entity: Entity, payload: dict) -> dict:
    db_payload = _wire_to_db(entity, payload)
    db_payload.setdefault(entity.pk, entity.new_id())
    cols = list(db_payload.keys())
    placeholders = ", ".join("?" * len(cols))
    try:
        conn.execute(
            f"INSERT INTO {entity.table} ({', '.join(cols)}) VALUES ({placeholders})",
            tuple(db_payload[c] for c in cols),
        )
        conn.commit()
    except sqlite3.IntegrityError as e:
        raise HTTPException(status.HTTP_409_CONFLICT, str(e)) from e
    return get_row(conn, entity, db_payload[entity.pk])


def update_row(conn: sqlite3.Connection, entity: Entity, pk_value: str, payload: dict) -> dict | None:
    db_payload = _wire_to_db(entity, payload)
    db_payload.pop(entity.pk, None)  # PK is in the URL, not the body
    if not db_payload:
        return get_row(conn, entity, pk_value)
    set_clause = ", ".join(f"{c} = ?" for c in db_payload)
    conn.execute(
        f"UPDATE {entity.table} SET {set_clause} WHERE {entity.pk} = ?",
        (*db_payload.values(), pk_value),
    )
    conn.commit()
    return get_row(conn, entity, pk_value)


def delete_row(conn: sqlite3.Connection, entity: Entity, pk_value: str) -> bool:
    cur = conn.execute(
        f"DELETE FROM {entity.table} WHERE {entity.pk} = ?",
        (pk_value,),
    )
    conn.commit()
    return cur.rowcount > 0


def upsert_many(conn: sqlite3.Connection, entity: Entity, rows: Iterable[dict]) -> int:
    """Bulk seed helper: INSERT OR IGNORE so re-running the seed is a no-op."""
    rows_list = list(rows)
    if not rows_list:
        return 0
    db_rows = [_wire_to_db(entity, r) for r in rows_list]
    # Find the union of populated columns across all rows.
    cols: list[str] = []
    seen: set[str] = set()
    for r in db_rows:
        for k in r:
            if k not in seen:
                seen.add(k)
                cols.append(k)
    placeholders = ", ".join("?" * len(cols))
    sql = (
        f"INSERT OR IGNORE INTO {entity.table} ({', '.join(cols)}) "
        f"VALUES ({placeholders})"
    )
    conn.executemany(
        sql,
        [tuple(r.get(c) for c in cols) for r in db_rows],
    )
    conn.commit()
    return conn.total_changes


# ---------------------------------------------------------------------------
# Router factory
# ---------------------------------------------------------------------------

def build_router(
    entity: Entity,
    *,
    tag: str | None = None,
    read_capability: str | None = None,
    write_capability: str | None = None,
) -> APIRouter:
    """Mount GET list / GET one / POST / PATCH / DELETE for one entity.

    `read_capability` / `write_capability` add an `rbac.require()` gate on top
    of the bare authentication check. Pass `None` (default) to require only
    a valid bearer token. Used in Phase 2.3 to gate `invoices` by `billing`.
    """
    prefix = f"/api/{entity.table.replace('_', '-')}"
    router = APIRouter(prefix=prefix, tags=[tag or entity.table])

    read_deps = [Depends(require(read_capability))] if read_capability else [Depends(current_user)]
    write_deps = [Depends(require(write_capability))] if write_capability else [Depends(current_user)]

    @router.get("", dependencies=read_deps)
    def list_(conn: sqlite3.Connection = Depends(get_db)) -> list[dict]:
        return list_rows(conn, entity)

    @router.get("/{pk}", dependencies=read_deps)
    def get_one(pk: str, conn: sqlite3.Connection = Depends(get_db)) -> dict:
        row = get_row(conn, entity, pk)
        if row is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, f"{entity.table[:-1]} not found")
        return row

    @router.post("", status_code=status.HTTP_201_CREATED, dependencies=write_deps)
    def create_(
        payload: dict = Body(...),
        conn: sqlite3.Connection = Depends(get_db),
    ) -> dict:
        return insert_row(conn, entity, payload)

    @router.patch("/{pk}", dependencies=write_deps)
    def update_(
        pk: str,
        payload: dict = Body(...),
        conn: sqlite3.Connection = Depends(get_db),
    ) -> dict:
        row = update_row(conn, entity, pk, payload)
        if row is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, f"{entity.table[:-1]} not found")
        return row

    @router.delete("/{pk}", status_code=status.HTTP_204_NO_CONTENT, dependencies=write_deps)
    def delete_(pk: str, conn: sqlite3.Connection = Depends(get_db)):
        if not delete_row(conn, entity, pk):
            raise HTTPException(status.HTTP_404_NOT_FOUND, f"{entity.table[:-1]} not found")

    return router


# ---------------------------------------------------------------------------
# Entity registry — one row per Phase 2.2 table
# ---------------------------------------------------------------------------

# camelCase wire fields map to snake_case DB columns where they differ. All
# other columns pass through unchanged. The list mirrors models.py's DDL.

MATTERS = Entity(
    table="matters",
    # Phase 2.4 expanded shape — original 10 columns plus the migration-added
    # ones. Frontend can ship camelCase keys; `column_aliases` lowers them.
    columns=("code", "title", "client", "type", "status", "lead",
             "docs", "open_tasks", "hours", "color",
             "summary", "priority", "opponent", "court", "judge", "outcome",
             "next_deadline", "next_label", "description", "started_at",
             "closed_at", "updated_at"),
    column_aliases={
        "openTasks": "open_tasks",
        "nextDeadline": "next_deadline",
        "nextLabel": "next_label",
        "startedAt": "started_at",
        "closedAt": "closed_at",
        "updatedAt": "updated_at",
    },
    id_prefix="m-",
)

TASKS = Entity(
    table="tasks",
    columns=("title", "matter", "assignee", "due", "priority", "col"),
    id_prefix="tk-",
)

CLIENTS = Entity(
    table="clients",
    columns=("name", "sector", "contracts", "open", "color"),
    id_prefix="cl-",
)

TEMPLATES = Entity(
    table="templates",
    columns=("name", "cat", "uses", "fields"),
    id_prefix="t-",
)

INVOICES = Entity(
    table="invoices",
    columns=("num", "client", "period", "amount", "status"),
    id_prefix="inv-",
)

TIME_ENTRIES = Entity(
    table="time_entries",
    columns=("date", "matter", "who", "descr", "hours", "rate", "billable"),
    column_aliases={"desc": "descr"},  # JS reserved-ish word avoided in DDL
    id_prefix="te-",
)

CLAUSE_LIB = Entity(
    table="clause_lib",
    columns=("cat", "title", "text", "tags"),
    json_columns=frozenset({"tags"}),
    id_prefix="cl-",
)

LAWS = Entity(
    table="laws",
    columns=("type", "title", "ref", "snippet", "date", "tag"),
    id_prefix="l-",
)

COMMENTS = Entity(
    table="comments",
    columns=("clause", "author", "ts", "text", "mentions", "resolved"),
    json_columns=frozenset({"mentions"}),
    id_prefix="cm-",
)

APPROVAL = Entity(
    table="approval",
    columns=("role", "user_id", "status", "date", "ord"),
    column_aliases={"user": "user_id"},
    id_prefix="ap-",
)

DEADLINES = Entity(
    table="deadlines",
    columns=("date", "title", "basis", "risk"),
    id_prefix="d-",
)

OBLIGATIONS = Entity(
    table="obligations",
    columns=("title", "party", "freq", "basis", "next_date", "risk"),
    column_aliases={"nextDate": "next_date"},
    id_prefix="o-",
)

VERSIONS = Entity(
    table="versions",
    columns=("label", "author", "date", "changes", "note", "current", "draft"),
    id_prefix="v-",
)

# Contract ↔ Handover reconciliation runs. POST goes through the custom
# `/api/reconcile` endpoint (multipart + Claude), but list/get/delete are
# served by the generic router.
RECONCILIATIONS = Entity(
    table="reconciliations",
    columns=(
        "user_id", "contract_file", "handover_file",
        "product", "counterparty", "verdict",
        "must_count", "should_count",
        "pair_json", "rows_json", "findings_json", "docs_json",
        "created_at",
    ),
    json_columns=frozenset({"pair_json", "rows_json", "findings_json", "docs_json"}),
    column_aliases={
        "userId": "user_id",
        "contractFile": "contract_file",
        "handoverFile": "handover_file",
        "mustCount": "must_count",
        "shouldCount": "should_count",
        "pair": "pair_json",
        "rows": "rows_json",
        "findings": "findings_json",
        "docs": "docs_json",
        "createdAt": "created_at",
    },
    id_prefix="rec-",
)

# Phase 3.2: persisted single-contract analyses. The heavy `analysis` payload
# (findings/comparison/legal_basis/score/warnings — exactly what
# /api/analyze/contract returns) rides in a JSON column; the small derived
# fields are kept top-level so list views don't have to JSON-parse 13 rows
# just to render a table.
CONTRACTS = Entity(
    table="contracts",
    columns=(
        "user_id", "filename", "title", "counterparty",
        "risk", "score", "findings_count",
        "analysis_json", "created_at",
    ),
    json_columns=frozenset({"analysis_json"}),
    column_aliases={
        "userId": "user_id",
        "findingsCount": "findings_count",
        "analysis": "analysis_json",
        "createdAt": "created_at",
    },
    id_prefix="c-",
)

# Fix 1: drafts moved to a dedicated router (backend/drafts.py) because they
# need per-row authorization (author vs team-shared). The generic CRUD here
# has no row-level auth knobs; rather than complicate it for every other
# entity, drafts ride a custom handler.


ALL_ENTITIES: tuple[Entity, ...] = (
    MATTERS, TASKS, CLIENTS, TEMPLATES, INVOICES, TIME_ENTRIES,
    CLAUSE_LIB, LAWS, COMMENTS, APPROVAL, DEADLINES, OBLIGATIONS, VERSIONS,
    RECONCILIATIONS, CONTRACTS,
)
