"""Phase 2.4 — WebSocket fan-out for realtime case collaboration.

`ConnectionManager` tracks every active WebSocket per user. When a REST
mutation lands and we want to push the change to every other member of the
case who's online, we call `broadcast_to_case(conn, case_id, event)` — it
looks up `case_members` for that case and forwards the JSON event to every
socket of every matching user.

Single uvicorn worker for now. The manager is in-process; scaling out to
multiple workers needs Redis pub/sub between them (event payload shape stays
the same — only the transport changes). TODO marked at the dispatch site.
"""
from __future__ import annotations

import asyncio
import datetime
import logging
import sqlite3
from collections import defaultdict
from typing import Iterable

from fastapi import WebSocket

from .cases_acl import list_member_ids


logger = logging.getLogger(__name__)


def _now_iso() -> str:
    return datetime.datetime.now(tz=datetime.timezone.utc).isoformat()


class ConnectionManager:
    """In-process WebSocket registry, keyed by TEXT user id.

    One user can have many active sockets (multiple tabs, mobile + desktop),
    so values are sets. Sends are best-effort — sockets that error during
    send get dropped from the registry.
    """

    def __init__(self) -> None:
        self._connections: dict[str, set[WebSocket]] = defaultdict(set)
        self._lock = asyncio.Lock()

    async def connect(self, user_text_id: str, ws: WebSocket) -> None:
        # FastAPI's WebSocket.accept() is what actually moves the socket into
        # the OPEN state. Caller is responsible for catching auth errors
        # before reaching this method.
        async with self._lock:
            self._connections[user_text_id].add(ws)
        logger.info("ws.connect user=%s total=%d", user_text_id,
                    sum(len(s) for s in self._connections.values()))

    async def disconnect(self, user_text_id: str, ws: WebSocket) -> None:
        async with self._lock:
            sockets = self._connections.get(user_text_id)
            if sockets is None:
                return
            sockets.discard(ws)
            if not sockets:
                # Empty set → drop the key so iteration stays tight.
                self._connections.pop(user_text_id, None)
        logger.info("ws.disconnect user=%s", user_text_id)

    async def send_to_users(
        self,
        user_text_ids: Iterable[str],
        event: dict,
    ) -> None:
        """Fan event out to every socket of every named user.

        Drops sockets that fail mid-send (network closed, peer gone). Safe
        to call from sync code via `asyncio.create_task(...)` — see the
        helpers below.
        """
        targets: list[tuple[str, WebSocket]] = []
        async with self._lock:
            for uid in set(user_text_ids):
                for ws in self._connections.get(uid, ()):
                    targets.append((uid, ws))
        if not targets:
            return
        # Send outside the lock to avoid pinning the registry on slow peers.
        for uid, ws in targets:
            try:
                await ws.send_json(event)
            except Exception as exc:  # network closed, peer gone, etc.
                logger.warning("ws.send failed user=%s err=%s", uid, exc)
                await self.disconnect(uid, ws)

    async def broadcast_to_case(
        self,
        conn: sqlite3.Connection,
        case_id: str,
        event: dict,
    ) -> None:
        """Look up members of a case, fan event out to all of them."""
        member_ids = list_member_ids(conn, case_id)
        if not member_ids:
            return
        await self.send_to_users(member_ids, event)

    async def notify_user(self, user_text_id: str, event: dict) -> None:
        """Single-user fan-out, e.g. for `notification.new`."""
        await self.send_to_users([user_text_id], event)


# Module-level singleton. Works because we run a single uvicorn worker.
# TODO(scaling): replace with Redis pub/sub between workers when we cross
# the single-machine threshold.
manager = ConnectionManager()


# Sync REST handlers run in a threadpool under TestClient and uvicorn, so
# `asyncio.get_running_loop()` won't see the main loop from there. We
# capture the main loop at startup via `set_main_loop()` (called from the
# FastAPI lifespan) so sync handlers can still schedule broadcasts via
# `run_coroutine_threadsafe`.
_main_loop: asyncio.AbstractEventLoop | None = None


def set_main_loop(loop: asyncio.AbstractEventLoop) -> None:
    global _main_loop
    _main_loop = loop


def _schedule(coro) -> None:
    """Dispatch `coro` onto the event loop appropriate for the caller.

    - In async context (e.g., the WS handler) → `create_task` on the
      running loop.
    - In sync context (e.g., REST handlers under threadpool) → fall back
      to the captured main loop via `run_coroutine_threadsafe`.
    - If neither is available (e.g., unit tests without lifespan) → close
      the coroutine cleanly so we don't leak a "coroutine was never
      awaited" warning.
    """
    try:
        loop = asyncio.get_running_loop()
        loop.create_task(coro)
        return
    except RuntimeError:
        pass
    if _main_loop is not None and not _main_loop.is_closed():
        asyncio.run_coroutine_threadsafe(coro, _main_loop)
        return
    # No loop available — discard the coroutine.
    coro.close()


def _build_event(
    type_: str,
    *,
    case_id: str | None,
    actor_id: str | None,
    data: dict | None = None,
) -> dict:
    return {
        "type": type_,
        "case_id": case_id,
        "actor_id": actor_id,
        "data": data or {},
        "ts": _now_iso(),
    }


def schedule_broadcast(
    conn: sqlite3.Connection,
    *,
    case_id: str,
    type_: str,
    actor_id: str | None = None,
    data: dict | None = None,
) -> None:
    """Sync helper called from REST handlers after `conn.commit()`.

    Schedules the async broadcast on the main event loop so the REST
    handler (which may be running on a threadpool) stays sync. The
    broadcast itself is best-effort — REST never blocks on the fan-out.

    Note: we have to capture `member_ids` synchronously here, because the
    REST handler's sqlite connection isn't safe to share across threads
    once it returns. The async broadcast then targets users directly.
    """
    event = _build_event(type_, case_id=case_id, actor_id=actor_id, data=data)
    member_ids = list_member_ids(conn, case_id)
    if not member_ids:
        return
    _schedule(manager.send_to_users(member_ids, event))


def schedule_notify(
    *,
    user_text_id: str,
    type_: str,
    case_id: str | None = None,
    data: dict | None = None,
) -> None:
    """Sync helper for the `notification.new` event addressed to one user."""
    event = _build_event(type_, case_id=case_id, actor_id=None, data=data)
    _schedule(manager.notify_user(user_text_id, event))
