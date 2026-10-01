"""Storage for the MCP OAuth server + MCP call log. No `mcp` SDK import.

Kept apart from `oauth_server.py` so `main.lifespan` can create/purge these
tables even when the SDK is missing or MCP is disabled — a broken MCP
install must never take the rest of AG Lex down.

Tables (all `CREATE IF NOT EXISTS`, convention #5):
- oauth_clients / oauth_pending / oauth_codes / oauth_tokens — see oauth_server.
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
"""

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
