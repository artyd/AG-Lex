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
- mcp_links — "secret link" connectors: /mcp/k/<key> works without an
  OAuth login (Claude Desktop custom connector with no auth). Each key
  belongs to one employee, carries their rights, expires, can be revoked;
  only its SHA-256 is stored.
- mcp_audit — one row per MCP tool call. Separate from `audit`, which the
  Team «Аудит-лог» tab reads newest-200; tool traffic would drown RBAC events.
"""
from __future__ import annotations

import hashlib
import json
import secrets
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

CREATE TABLE IF NOT EXISTS mcp_links (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    key_hash     TEXT NOT NULL UNIQUE,
    key_hint     TEXT NOT NULL,          -- last 4 chars, for the UI
    user_id      INTEGER NOT NULL,
    user_email   TEXT NOT NULL,          -- same rowid-reuse guard as oauth_tokens
    label        TEXT,
    profile      TEXT NOT NULL DEFAULT 'full',
    created_at   INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL,
    last_used_at INTEGER,
    revoked      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_mcp_links_user ON mcp_links(user_id);

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

# ---------------------------------------------------------------------------
# secret-link connectors (/mcp/k/<key>)
# ---------------------------------------------------------------------------

LINK_PREFIX = "aglx_lk_"
MAX_LINKS_PER_USER = 10
LINK_TOUCH_EVERY_S = 60
LINK_IDLE_S = 30 * 86400  # unused for 30 days → dead, like an idle session


def _link_hash(key: str) -> str:
    return hashlib.sha256(key.encode("utf-8")).hexdigest()


def create_link(conn: sqlite3.Connection, *, user: dict, label: str, profile: str, ttl_days: int) -> tuple[int, str]:
    (active,) = conn.execute(
        "SELECT COUNT(*) FROM mcp_links WHERE user_id = ? AND revoked = 0 AND expires_at > ?",
        (user["id"], int(time.time())),
    ).fetchone()
    if active >= MAX_LINKS_PER_USER:
        raise ValueError(f"At most {MAX_LINKS_PER_USER} active links per person; revoke an old one first.")
    key = LINK_PREFIX + secrets.token_urlsafe(32)
    now = int(time.time())
    cur = conn.execute(
        "INSERT INTO mcp_links (key_hash, key_hint, user_id, user_email, label, profile, created_at, expires_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (_link_hash(key), key[-4:], user["id"], user["email"], label, profile, now, now + ttl_days * 86400),
    )
    conn.commit()
    return cur.lastrowid, key


def resolve_link(conn: sqlite3.Connection, key: str) -> dict | None:
    """Live link for this key (owner still exists with the same email), or None."""
    row = conn.execute(
        "SELECT l.id, l.user_id, l.profile, l.label, l.expires_at, l.last_used_at "
        "FROM mcp_links l JOIN users u ON u.id = l.user_id AND u.email = l.user_email "
        "WHERE l.key_hash = ? AND l.revoked = 0",
        (_link_hash(key),),
    ).fetchone()
    now = int(time.time())
    if row is None or row[4] < now:
        return None
    created = conn.execute("SELECT created_at FROM mcp_links WHERE id = ?", (row[0],)).fetchone()[0]
    if now - (row[5] or created) > LINK_IDLE_S:
        return None
    if not row[5] or now - row[5] > LINK_TOUCH_EVERY_S:
        conn.execute("UPDATE mcp_links SET last_used_at = ? WHERE id = ?", (now, row[0]))
        conn.commit()
    return {"id": row[0], "user_id": row[1], "profile": row[2], "label": row[3], "expires_at": row[4]}


def link_info(conn: sqlite3.Connection, link_id: int) -> dict | None:
    """Label/profile only. Validity (revoked/expiry/owner) is checked by
    resolve_link when the key is presented — don't use this as an auth check."""
    row = conn.execute("SELECT id, profile, label FROM mcp_links WHERE id = ?", (link_id,)).fetchone()
    return {"id": row[0], "profile": row[1], "label": row[2]} if row else None


def list_links(conn: sqlite3.Connection, *, user_id: int | None = None) -> list[dict]:
    sql = (
        "SELECT l.id, l.label, l.profile, l.key_hint, l.created_at, l.expires_at, l.last_used_at, "
        "l.user_id, u.name, u.email FROM mcp_links l "
        "JOIN users u ON u.id = l.user_id AND u.email = l.user_email "
        "WHERE l.revoked = 0 AND l.expires_at > ?"
    )
    args: list = [int(time.time())]
    if user_id is not None:
        sql += " AND l.user_id = ?"
        args.append(user_id)
    sql += " ORDER BY l.created_at DESC"
    keys = ("id", "label", "profile", "key_hint", "created_at", "expires_at", "last_used_at",
            "user_id", "user_name", "user_email")
    return [dict(zip(keys, r)) for r in conn.execute(sql, args).fetchall()]


def revoke_all_for_user(conn: sqlite3.Connection, user_id: int) -> int:
    """Kill every MCP credential of a user (links + OAuth tokens) — on removal
    from the team, or as an incident-response action."""
    n = 0
    for sql in ("UPDATE mcp_links SET revoked = 1 WHERE user_id = ? AND revoked = 0",
                "UPDATE oauth_tokens SET revoked = 1 WHERE user_id = ? AND revoked = 0"):
        try:
            n += conn.execute(sql, (user_id,)).rowcount
        except sqlite3.OperationalError:
            pass  # MCP tables not created on this DB (e.g. minimal test schema)
    conn.commit()
    return n


def link_owner(conn: sqlite3.Connection, link_id: int) -> dict | None:
    row = conn.execute(
        "SELECT l.label, l.user_id, u.email FROM mcp_links l LEFT JOIN users u ON u.id = l.user_id WHERE l.id = ?",
        (link_id,),
    ).fetchone()
    return {"label": row[0], "user_id": row[1], "email": row[2]} if row else None


def revoke_link(conn: sqlite3.Connection, link_id: int, *, user_id: int | None = None) -> int:
    sql, args = "UPDATE mcp_links SET revoked = 1 WHERE id = ? AND revoked = 0", [link_id]
    if user_id is not None:
        sql += " AND user_id = ?"
        args.append(user_id)
    cur = conn.execute(sql, args)
    conn.commit()
    return cur.rowcount
