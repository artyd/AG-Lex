"""Storage for the MCP OAuth server + MCP call log. No `mcp` SDK import.

Kept apart from `oauth_server.py` so `main.lifespan` can create/purge these
tables even when the SDK is missing or MCP is disabled — a broken MCP
install must never take the rest of AG Lex down.

Tables (all `CREATE IF NOT EXISTS`, convention #5):
- oauth_clients / oauth_pending / oauth_codes / oauth_tokens — see oauth_server.
- mcp_policy — privilege flag `ai_external=deny`: never hand this data to
  external AI through MCP. Kinds:
    matter   — key = matters.id
    client   — key = client name; compared *normalised* (casefold, quotes,
               whitespace) against matters.client / invoices.client /
               clients.name, which are free text with no FK between them
    document — key = documents.id
    global   — key = 'documents': close every uploaded document
  A separate table instead of new columns keeps the migration additive.
- mcp_audit — one row per MCP tool call. Separate from `audit`, which the
  Team «Аудит-лог» tab reads newest-200; tool traffic would drown RBAC events.
"""
from __future__ import annotations

import json
import sqlite3
import time
from datetime import datetime, timezone

OAUTH_SCHEMA = """
CREATE TABLE IF NOT EXISTS oauth_clients (
    client_id    TEXT PRIMARY KEY,
    client_info  TEXT NOT NULL,          -- OAuthClientInformationFull JSON
    profile      TEXT NOT NULL DEFAULT 'full',
    created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_pending (
    request_id   TEXT PRIMARY KEY,       -- random, single use
    client_id    TEXT NOT NULL,
    params       TEXT NOT NULL,          -- AuthorizationParams JSON
    expires_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_codes (
    code_hash    TEXT PRIMARY KEY,
    client_id    TEXT NOT NULL,
    user_id      INTEGER NOT NULL,
    data         TEXT NOT NULL,          -- AuthorizationCode JSON (code field blanked)
    expires_at   INTEGER NOT NULL,
    used         INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS oauth_tokens (
    token_hash   TEXT PRIMARY KEY,
    kind         TEXT NOT NULL,          -- 'access' | 'refresh'
    client_id    TEXT NOT NULL,
    user_id      INTEGER NOT NULL,
    -- users.id is a plain rowid and can be reused after a delete; binding the
    -- email too means a removed user's tokens never resolve to someone new.
    user_email   TEXT NOT NULL,
    scopes       TEXT NOT NULL,          -- space-separated
    resource     TEXT,
    expires_at   INTEGER NOT NULL,
    revoked      INTEGER NOT NULL DEFAULT 0,
    created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_owner ON oauth_tokens(client_id, user_id);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_exp ON oauth_tokens(expires_at);

CREATE TABLE IF NOT EXISTS mcp_audit (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    ts           TEXT NOT NULL,
    user_id      INTEGER,
    user_name    TEXT,
    client_id    TEXT,
    profile      TEXT,
    tool         TEXT NOT NULL,
    ok           INTEGER NOT NULL,
    args         TEXT
);
CREATE INDEX IF NOT EXISTS idx_mcp_audit_ts ON mcp_audit(ts);

CREATE TABLE IF NOT EXISTS mcp_policy (
    kind         TEXT NOT NULL,          -- 'matter' | 'client' | 'document' | 'global'
    key          TEXT NOT NULL,          -- matter id | client name | document id | 'documents'
    ai_external  TEXT NOT NULL DEFAULT 'deny',
    set_by       INTEGER,
    set_at       TEXT NOT NULL,
    PRIMARY KEY (kind, key)
);
"""

POLICY_KINDS = ("matter", "client", "document", "global")
GLOBAL_DOCUMENTS = "documents"

_QUOTES = str.maketrans({c: '"' for c in "«»“”„‟\'‘’`"})


def norm_name(name: str | None) -> str:
    """Canonical client name: casefold, one quote style, single spaces.

    «ТОВ “Альфа”», 'тов "альфа" ' and ТОВ  "Альфа" all compare equal, so a
    typo-level spelling difference can't silently lift a deny.
    """
    return " ".join((name or "").translate(_QUOTES).casefold().split())

UNUSED_CLIENT_TTL_S = 24 * 60 * 60
REVOKED_KEEP_S = 30 * 24 * 60 * 60
MCP_AUDIT_RETENTION_DAYS = 180


def init_oauth_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(OAUTH_SCHEMA)
    # Pre-release dev DBs got oauth_tokens without user_email. Rows with ''
    # never match users.email, so those tokens simply become invalid.
    cols = {r[1] for r in conn.execute("PRAGMA table_info(oauth_tokens)")}
    if "user_email" not in cols:
        conn.execute("ALTER TABLE oauth_tokens ADD COLUMN user_email TEXT NOT NULL DEFAULT ''")
    code_cols = {r[1] for r in conn.execute("PRAGMA table_info(oauth_codes)")}
    if "used" not in code_cols:
        conn.execute("ALTER TABLE oauth_codes ADD COLUMN used INTEGER NOT NULL DEFAULT 0")
    conn.commit()


def list_grants(conn: sqlite3.Connection, *, user_id: int | None = None) -> list[dict]:
    """Live connections (a non-revoked, unexpired refresh token) per client+user."""
    sql = """
        SELECT t.client_id, t.user_id, u.name, u.email, c.client_info, c.profile,
               MAX(t.created_at), MAX(t.scopes)
        FROM oauth_tokens t
        JOIN users u ON u.id = t.user_id AND u.email = t.user_email
        LEFT JOIN oauth_clients c ON c.client_id = t.client_id
        WHERE t.kind = 'refresh' AND t.revoked = 0 AND t.expires_at > ?
    """
    args: list = [int(time.time())]
    if user_id is not None:
        sql += " AND t.user_id = ?"
        args.append(user_id)
    sql += " GROUP BY t.client_id, t.user_id ORDER BY MAX(t.created_at) DESC"
    out = []
    for r in conn.execute(sql, args).fetchall():
        info = json.loads(r[4]) if r[4] else {}
        out.append({
            "client_id": r[0],
            "client_name": info.get("client_name") or r[0],
            "redirect_uris": info.get("redirect_uris") or [],
            "profile": r[5],
            "user_id": r[1],
            "user_name": r[2],
            "user_email": r[3],
            "last_issued_at": r[6],
            "scopes": (r[7] or "").split(),
        })
    return out


def revoke_grant(conn: sqlite3.Connection, *, client_id: str, user_id: int) -> int:
    cur = conn.execute(
        "UPDATE oauth_tokens SET revoked = 1 WHERE client_id = ? AND user_id = ? AND revoked = 0",
        (client_id, user_id),
    )
    conn.commit()
    return cur.rowcount


def purge_expired_oauth(conn: sqlite3.Connection, now: int | None = None) -> None:
    """Drop dead OAuth rows + old MCP call log. Idempotent; cheap with indexes."""
    now = int(time.time()) if now is None else now
    conn.execute("DELETE FROM oauth_tokens WHERE expires_at < ?", (now - 86400,))
    conn.execute("DELETE FROM oauth_tokens WHERE revoked = 1 AND created_at < ?", (now - REVOKED_KEEP_S,))
    conn.execute("DELETE FROM oauth_codes WHERE expires_at < ?", (now,))
    conn.execute("DELETE FROM oauth_pending WHERE expires_at < ?", (now,))
    # Clients registered but never used (abandoned or spam DCR).
    conn.execute(
        "DELETE FROM oauth_clients WHERE created_at < ? "
        "AND client_id NOT IN (SELECT DISTINCT client_id FROM oauth_tokens)",
        (now - UNUSED_CLIENT_TTL_S,),
    )
    cutoff = datetime.fromtimestamp(now - MCP_AUDIT_RETENTION_DAYS * 86400, tz=timezone.utc).isoformat()
    conn.execute("DELETE FROM mcp_audit WHERE ts < ?", (cutoff,))
    conn.commit()


def log_mcp_call(
    conn: sqlite3.Connection,
    *,
    user: dict | None,
    client_id: str | None,
    profile: str | None,
    tool: str,
    ok: bool,
    args: dict | None,
) -> None:
    conn.execute(
        "INSERT INTO mcp_audit (ts, user_id, user_name, client_id, profile, tool, ok, args) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (
            datetime.now(tz=timezone.utc).isoformat(),
            (user or {}).get("id"),
            (user or {}).get("name"),
            client_id,
            profile,
            tool,
            1 if ok else 0,
            json.dumps(args, ensure_ascii=False) if args else None,
        ),
    )
    conn.commit()


# ---------------------------------------------------------------------------
# privilege policy (ai_external=deny)
# ---------------------------------------------------------------------------

def set_policy(conn: sqlite3.Connection, *, kind: str, key: str, deny: bool, user_id: int | None) -> None:
    if kind not in POLICY_KINDS:
        raise ValueError(f"unknown policy kind: {kind}")
    if deny:
        conn.execute(
            "INSERT OR REPLACE INTO mcp_policy (kind, key, ai_external, set_by, set_at) VALUES (?, ?, 'deny', ?, ?)",
            (kind, key, user_id, datetime.now(tz=timezone.utc).isoformat()),
        )
    else:
        conn.execute("DELETE FROM mcp_policy WHERE kind = ? AND key = ?", (kind, key))
    conn.commit()


def _denied(conn: sqlite3.Connection, kind: str) -> set[str]:
    return {r[0] for r in conn.execute(
        "SELECT key FROM mcp_policy WHERE kind = ? AND ai_external = 'deny'", (kind,)
    )}


def denied_keys(conn: sqlite3.Connection) -> tuple[set[str], set[str]]:
    """(denied matter ids, denied client names — normalised)."""
    return _denied(conn, "matter"), {norm_name(n) for n in _denied(conn, "client")}


def client_denied(conn: sqlite3.Connection, name: str | None) -> bool:
    return norm_name(name) in denied_keys(conn)[1]


def denied_matter_ids(conn: sqlite3.Connection) -> set[str]:
    """Matters closed to external AI: flagged directly or via their client."""
    matters, clients = denied_keys(conn)
    if clients:
        # Python-side compare: SQLite lower() doesn't fold Cyrillic.
        matters |= {mid for mid, client in conn.execute("SELECT id, client FROM matters")
                    if norm_name(client) in clients}
    return matters


def documents_all_denied(conn: sqlite3.Connection) -> bool:
    return GLOBAL_DOCUMENTS in _denied(conn, "global")


def document_denied(conn: sqlite3.Connection, doc_id: str, title: str | None = None,
                    filename: str | None = None) -> bool:
    """Firm-wide switch, per-document flag, or (best effort — documents have no
    client link yet) a denied client's name in the title / filename."""
    if documents_all_denied(conn) or doc_id in _denied(conn, "document"):
        return True
    # Quotes dropped on both sides: «ТД «Вектор»» in a title must match «ТД Вектор».
    def unquote(x: str) -> str:
        return " ".join(x.replace('"', " ").split())

    clients = {unquote(c) for c in denied_keys(conn)[1]}
    hay = unquote(norm_name(f"{title or ''} {filename or ''}"))
    return any(c and c in hay for c in clients)
