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
                scope = rewritten
            await target(scope, receive, send)
            return
        await self.app(scope, receive, send)


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
