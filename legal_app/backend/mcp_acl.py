"""Access control for MCP tools.

Every MCP tool resolves the bearer token to a `Principal` and asks this
module before touching data. Three layers must all agree:

1. OAuth scope granted to the connected client (`aglex.read`, …).
2. RBAC capability of the user's current role (`rbac.has_capability`) —
   re-checked on every call, so a role change applies immediately.
3. Row-level rules — matter membership via `case_members`, plus the client
   profile: `restricted` (ChatGPT) never sees documents, billing or clients.

The REST layer is looser for tasks/documents (see DESIGN.md §6). MCP pushes
data into third-party AI products, so it applies the stricter rules here
instead of reusing the generic CRUD handlers.
"""
from __future__ import annotations

import re
import sqlite3
from dataclasses import dataclass, field

from mcp.server.auth.provider import AccessToken
from mcp.server.mcpserver.exceptions import ToolError

from .auth import get_user_by_id, login_blocked
from .cases_acl import resolve_user_text_id
from .oauth_server import PROFILE_RESTRICTED, SCOPE_READ
from .oauth_store import denied_matter_ids
from .rbac import has_capability

_CONTROL = re.compile(r"[\x00-\x1f\x7f]")

# Kinds of data a tool can expose. Restricted clients get only these:
RESTRICTED_ALLOWED_KINDS = frozenset({"matters", "tasks", "calendar", "codex", "law"})


@dataclass
class Principal:
    user: dict
    text_id: str
    client_id: str
    scopes: list[str]
    profile: str
    capabilities: set[str] = field(default_factory=set)
    client_name: str = ""

    @property
    def role(self) -> str:
        return self.user["role"]

    @property
    def restricted(self) -> bool:
        return self.profile == PROFILE_RESTRICTED


def principal_from_token(conn: sqlite3.Connection, token: AccessToken | None) -> Principal:
    if token is None or not token.subject:
        raise ToolError("Not authenticated.")
    try:
        user_id = int(token.subject)
    except ValueError as e:
        raise ToolError("Invalid token subject.") from e
    user = get_user_by_id(conn, user_id)
    if user is None or login_blocked(user):
        raise ToolError("User no longer exists.")
    row = conn.execute(
        "SELECT profile, json_extract(client_info, '$.client_name') FROM oauth_clients WHERE client_id = ?",
        (token.client_id,),
    ).fetchone()
    profile = row[0] if row else PROFILE_RESTRICTED
    client_name = (row[1] if row else None) or "AI"
    caps = {
        cap
        for cap in ("view", "edit", "ai", "billing", "pdata", "manage")
        if has_capability(conn, user["role"], cap)
    }
    return Principal(
        user={k: v for k, v in user.items() if k != "password_hash"},
        text_id=resolve_user_text_id(conn, user_id),
        client_id=token.client_id,
        scopes=list(token.scopes),
        profile=profile,
        capabilities=caps,
        # App-chosen (DCR) → strip control chars so it can't forge note lines.
        client_name=" ".join(_CONTROL.sub(" ", str(client_name)).split())[:60] or "AI",
    )


def require(p: Principal, *, scope: str = SCOPE_READ, capability: str = "view", kind: str) -> None:
    """Raise ToolError unless scope, role capability and client profile allow `kind`."""
    if scope not in p.scopes:
        raise ToolError(f"The connected app was not granted '{scope}'. Reconnect AG Lex and allow it.")
    if capability not in p.capabilities:
        raise ToolError(f"Your AG Lex role '{p.role}' lacks the '{capability}' permission.")
    if p.restricted and kind not in RESTRICTED_ALLOWED_KINDS:
        raise ToolError(
            "This app has restricted access to AG Lex by firm policy "
            f"({kind} are not shared with it)."
        )


def can_see(p: Principal, kind: str) -> bool:
    return not (p.restricted and kind not in RESTRICTED_ALLOWED_KINDS)


POLICY_DENIED_MSG = (
    "Закрито політикою фірми: ця справа/клієнт позначені як конфіденційні "
    "(ai_external=deny) і не передаються зовнішнім AI."
)


def check_matter_policy(conn: sqlite3.Connection, matter_id: str) -> None:
    if matter_id in denied_matter_ids(conn):
        raise ToolError(POLICY_DENIED_MSG)


def member_matter_ids(conn: sqlite3.Connection, p: Principal) -> set[str]:
    rows = conn.execute(
        "SELECT case_id FROM case_members WHERE user_id = ?", (p.text_id,)
    ).fetchall()
    return {r[0] for r in rows}


def is_matter_member(conn: sqlite3.Connection, p: Principal, matter_id: str) -> bool:
    return (
        conn.execute(
            "SELECT 1 FROM case_members WHERE case_id = ? AND user_id = ?",
            (matter_id, p.text_id),
        ).fetchone()
        is not None
    )
