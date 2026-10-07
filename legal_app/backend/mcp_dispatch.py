"""ASGI dispatch of MCP/OAuth paths. No `mcp` SDK import (see oauth_store.py).

`McpDispatchMiddleware` sends `/mcp`, the OAuth endpoints and
`/.well-known/oauth-*` to the MCP Starlette app built in `main.lifespan`,
and everything else to FastAPI untouched. A `Mount("/")` would shadow the
SPA catch-all, and copying the SDK's routes would drop its auth middleware.
When MCP is disabled or failed to build, those paths answer 503.
"""
from __future__ import annotations

import logging
import re
from typing import Any

from starlette.types import ASGIApp, Receive, Scope, Send

MCP_PATH = "/mcp"
LINK_PATH_PREFIX = "/mcp/k/"
_EXACT_PATHS = {MCP_PATH, "/authorize", "/token", "/register", "/revoke"}
_PREFIXES = ("/.well-known/oauth-", "/oauth/", LINK_PATH_PREFIX)
_LINK = re.compile(r"^/mcp/k/(aglx_lk_[A-Za-z0-9_\-]{20,80})/?$")


def _link_scope(scope: Scope) -> Scope | None:
    """/mcp/k/<key> → the regular /mcp endpoint with `Authorization: Bearer
    <key>`; the OAuth provider resolves the key (oauth_server._link_token).
    Any Authorization header the client sent is replaced."""
    m = _LINK.match(scope.get("path", ""))
    if not m:
        return None
    headers = [(k, v) for k, v in scope.get("headers", []) if k.lower() != b"authorization"]
    headers.append((b"authorization", b"Bearer " + m.group(1).encode("ascii")))
    return {**scope, "path": MCP_PATH, "raw_path": MCP_PATH.encode("ascii"), "headers": headers}

_state: dict[str, Any] = {}


def set_open_key(key: str | None) -> None:
    """Key of the open connector (oauth_store.sync_open_link), or None when
    plain /mcp must keep asking for OAuth."""
    if key is None:
        _state.pop("open_key", None)
    else:
        _state["open_key"] = key


def _has_auth(scope: Scope) -> bool:
    return any(k.lower() == b"authorization" for k, _ in scope.get("headers", []))


def _open_scope(scope: Scope) -> Scope | None:
    """Plain /mcp without a credential → the open connector's key, so
    `https://<domain>/mcp` works pasted as-is. Requests that carry their own
    token (OAuth, link) keep their identity."""
    key = _state.get("open_key")
    if not key or scope.get("path") != MCP_PATH or _has_auth(scope):
        return None
    headers = [*scope.get("headers", []), (b"authorization", b"Bearer " + key.encode("ascii"))]
    return {**scope, "headers": headers}


def is_mcp_path(path: str) -> bool:
    return path in _EXACT_PATHS or path.startswith(_PREFIXES)


def set_active_app(app: ASGIApp | None) -> None:
    if app is None:
        _state.pop("app", None)
    else:
        _state["app"] = app


class McpDispatchMiddleware:
    def __init__(self, app: ASGIApp):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http" and is_mcp_path(scope.get("path", "")):
            target = _state.get("app")
            if target is None:
                await _unavailable(send)
                return
            if scope["path"].startswith(LINK_PATH_PREFIX):
                rewritten = _link_scope(scope)
                if rewritten is None:
                    await _unavailable(send, status=404, error="not_found")
                    return
                if scope.get("method") in ("HEAD", "OPTIONS"):
                    # Connector "check the server" probes: the SDK answers 405
                    # to these, which Claude's add-connector wizard reports as
                    # "Couldn't check the server". Answer them here — they carry
                    # no MCP traffic, so no auth decision is made on them.
                    await _probe_ok(scope["method"], send)
                    return
                scope = rewritten
            elif scope["path"] == MCP_PATH and (opened := _open_scope(scope)) is not None:
                if scope.get("method") in ("HEAD", "OPTIONS"):
                    await _probe_ok(scope["method"], send)
                    return
                scope = opened
            elif scope["path"] == MCP_PATH and scope.get("method") in ("HEAD", "OPTIONS") and _has_auth(scope):
                # Same probe, arriving as /mcp + Authorization (the stack's nginx
                # rewrites /mcp/k/<key> that way). Without a credential the SDK
                # still answers 401 so OAuth clients discover the login.
                await _probe_ok(scope["method"], send)
                return
            await target(scope, receive, send)
            return
        await self.app(scope, receive, send)


async def _probe_ok(method: str, send: Send) -> None:
    status = 204 if method == "OPTIONS" else 200
    await send({
        "type": "http.response.start",
        "status": status,
        "headers": [
            (b"allow", b"GET, POST, DELETE, HEAD, OPTIONS"),
            (b"content-type", b"application/json"),
            (b"content-length", b"0"),
        ],
    })
    await send({"type": "http.response.body", "body": b""})


async def _unavailable(send: Send, status: int = 503, error: str = "mcp_unavailable") -> None:
    desc = "MCP is not configured on this server" if status == 503 else "Unknown MCP link"
    body = ('{"error":"%s","error_description":"%s"}' % (error, desc)).encode()
    await send({
        "type": "http.response.start",
        "status": status,
        "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())],
    })
    await send({"type": "http.response.body", "body": body})


_KEY_IN_PATH = re.compile(r"(/mcp/k/)[^/?\s\"]+")


class RedactLinkKeys(logging.Filter):
    """Access logs must never contain a secret-link key (it is a credential)."""

    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.args, tuple):
            record.args = tuple(
                _KEY_IN_PATH.sub(r"\1***", a) if isinstance(a, str) else a for a in record.args
            )
        if isinstance(record.msg, str) and "/mcp/k/" in record.msg:
            record.msg = _KEY_IN_PATH.sub(r"\1***", record.msg)
        return True


def install_log_redaction() -> None:
    for name in ("uvicorn.access", "uvicorn.error", "httpx"):
        lg = logging.getLogger(name)
        if not any(isinstance(f, RedactLinkKeys) for f in lg.filters):
            lg.addFilter(RedactLinkKeys())
