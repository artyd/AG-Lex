"""ASGI dispatch of MCP/OAuth paths. No `mcp` SDK import (see oauth_store.py).

`McpDispatchMiddleware` sends `/mcp`, the OAuth endpoints and
`/.well-known/oauth-*` to the MCP Starlette app built in `main.lifespan`,
and everything else to FastAPI untouched. A `Mount("/")` would shadow the
SPA catch-all, and copying the SDK's routes would drop its auth middleware.
When MCP is disabled or failed to build, those paths answer 503.
"""
from __future__ import annotations

from typing import Any

from starlette.types import ASGIApp, Receive, Scope, Send

MCP_PATH = "/mcp"
_EXACT_PATHS = {MCP_PATH, "/authorize", "/token", "/register", "/revoke"}
_PREFIXES = ("/.well-known/oauth-", "/oauth/")

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
            await target(scope, receive, send)
            return
        await self.app(scope, receive, send)


async def _unavailable(send: Send) -> None:
    body = b'{"error":"mcp_unavailable","error_description":"MCP is not configured on this server"}'
    await send({
        "type": "http.response.start",
        "status": 503,
        "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())],
    })
    await send({"type": "http.response.body", "body": body})
