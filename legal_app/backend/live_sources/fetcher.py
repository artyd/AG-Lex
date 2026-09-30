"""Polite HTTP fetcher with per-host throttling, a TTL cache and a block breaker.

- One request per host at a time, at least `min_interval` seconds apart
  (rada: 6 s — inside its 5–7 s guidance). Callers never queue for long:
  at most `max_waiters` may wait for a host and none longer than
  `max_wait`; the rest get `SourceBusy` instead of pinning worker threads.
- Daily byte budget per host (rada: 150 MB of its 200 MB/day allowance),
  checked against Content-Length before downloading and enforced while
  streaming; bodies are capped at `MAX_BODY`. The counter is in memory and
  keyed by the UTC day — a restart resets it; it is a guard rail, the
  official limit is enforced by rada itself.
- Block breaker: 403/429, or a *small non-JSON* page carrying a known
  block marker, opens the breaker for the host for `block_cooldown`
  seconds; calls fail fast with `SourceBlocked` rather than digging an IP
  ban deeper. Large pages never trip it (a court text quoting "Доступ
  заборонено" must not pause the registry for the whole firm).
- Redirects are followed manually, only to https hosts that have a policy.
- Cache: raw bodies in a separate SQLite file (not the firm DB), keyed by
  URL, stored only after the caller's `validate` accepts the body (no
  week-long cached captcha pages). 404s are negative-cached for an hour.
  Deleting the file loses nothing but speed.
"""
from __future__ import annotations

import logging
import sqlite3
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable
from urllib.parse import urljoin, urlparse

import httpx

log = logging.getLogger("aglex.live")


class SourceError(Exception):
    """Base for user-facing source failures (message is safe to show)."""


class SourceBusy(SourceError):
    pass


class SourceBlocked(SourceError):
    pass


class SourceNotFound(SourceError):
    pass


@dataclass
class HostPolicy:
    min_interval: float = 3.0
    max_wait: float = 20.0
    max_waiters: int = 3
    daily_bytes: int = 50 * 1024 * 1024
    block_cooldown: float = 30 * 60.0
    user_agent: str = "AGLex-MCP/1.0 (law firm research tool; low volume)"
    block_markers: tuple[str, ...] = ()


@dataclass
class _HostState:
    lock: threading.Lock = field(default_factory=threading.Lock)
    waiters: int = 0
    last_request: float = 0.0
    blocked_until: float = 0.0
    day: str = ""
    bytes_today: int = 0


@dataclass
class Fetched:
    url: str
    status: int
    body: bytes
    content_type: str
    retrieved_at: str
    cached: bool

    def text(self, fallback_encoding: str = "utf-8") -> str:
        ct = self.content_type.lower()
        enc = ct.split("charset=")[-1].split(";")[0].strip().strip('"\'') if "charset=" in ct else None
        # latin-1/ascii are generic server defaults that decode *anything*
        # (cp1251 bytes → mojibake); never trust them for Cyrillic sources.
        if enc in ("iso-8859-1", "latin-1", "latin1", "ascii", "us-ascii"):
            enc = None
        for candidate in (enc, "utf-8", fallback_encoding, "cp1251"):
            if not candidate:
                continue
            try:
                return self.body.decode(candidate).lstrip("\ufeff")
            except (LookupError, UnicodeDecodeError):
                continue
        return self.body.decode("utf-8", errors="replace")


CACHE_SCHEMA = """
CREATE TABLE IF NOT EXISTS live_cache (
    url          TEXT PRIMARY KEY,
    status       INTEGER NOT NULL,
    content_type TEXT,
    body         BLOB NOT NULL,
    fetched_at   REAL NOT NULL,
    retrieved_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_live_cache_fetched ON live_cache(fetched_at);
"""

MAX_BODY = 10 * 1024 * 1024
MAX_CACHED_BODY = 8 * 1024 * 1024
CACHE_MAX_AGE = 7 * 24 * 3600.0
NEGATIVE_TTL = 3600.0
MARKER_SCAN_MAX = 20 * 1024       # only small pages can be block pages
MAX_REDIRECTS = 3


class LiveFetcher:
    def __init__(
        self,
        *,
        cache_path: str | Path,
        policies: dict[str, HostPolicy],
        transport: httpx.BaseTransport | None = None,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
        timeout: float = 30.0,
    ):
        self._policies = policies
        self._states: dict[str, _HostState] = {}
        self._states_lock = threading.Lock()
        self._clock = clock
        self._sleep = sleep
        self._client = httpx.Client(
            timeout=httpx.Timeout(timeout, connect=10.0), follow_redirects=False, transport=transport
        )
        self._cache_path = str(cache_path)
        if self._cache_path != ":memory:":
            Path(self._cache_path).parent.mkdir(parents=True, exist_ok=True)
        self._cache_lock = threading.Lock()
        self._cache = sqlite3.connect(self._cache_path, check_same_thread=False)
        self._cache.executescript(CACHE_SCHEMA)
        self._cache.commit()

    # -- cache -------------------------------------------------------------

    def _cache_get(self, url: str, ttl: float) -> Fetched | None:
        try:
            with self._cache_lock:
                row = self._cache.execute(
                    "SELECT status, content_type, body, fetched_at, retrieved_at FROM live_cache WHERE url = ?", (url,)
                ).fetchone()
        except sqlite3.Error as e:  # a broken cache is a miss, never a failure
            log.warning("live cache read failed: %r", e)
            return None
        if row is None:
            return None
        age = time.time() - row[3]
        if row[0] == 404:
            if age <= NEGATIVE_TTL:
                raise SourceNotFound(f"Not found at the official source: {url}")
            return None
        if age > ttl:
            return None
        return Fetched(url=url, status=row[0], content_type=row[1] or "", body=row[2],
                       retrieved_at=row[4], cached=True)

    def _cache_put(self, url: str, status: int, content_type: str, body: bytes, retrieved_at: str) -> None:
        if len(body) > MAX_CACHED_BODY:
            return
        try:
            with self._cache_lock:
                self._cache.execute(
                    "INSERT OR REPLACE INTO live_cache (url, status, content_type, body, fetched_at, retrieved_at) "
                    "VALUES (?, ?, ?, ?, ?, ?)",
                    (url, status, content_type, body, time.time(), retrieved_at),
                )
                self._cache.execute("DELETE FROM live_cache WHERE fetched_at < ?", (time.time() - CACHE_MAX_AGE,))
                self._cache.commit()
        except sqlite3.Error as e:
            log.warning("live cache write failed: %r", e)

    def close(self) -> None:
        try:
            self._client.close()
        finally:
            with self._cache_lock:
                self._cache.close()

    # -- throttling --------------------------------------------------------

    def _state(self, host: str) -> _HostState:
        with self._states_lock:
            return self._states.setdefault(host, _HostState())

    def policy(self, host: str) -> HostPolicy:
        return self._policies.get(host) or self._policies.get("*") or HostPolicy()

    def _allowed_redirect(self, url: str) -> bool:
        u = urlparse(url)
        return u.scheme == "https" and (u.hostname or "").lower() in self._policies

    def fetch(
        self,
        url: str,
        *,
        ttl: float,
        headers: dict[str, str] | None = None,
        validate: Callable[[Fetched], None] | None = None,
    ) -> Fetched:
        """GET with throttling/breaker/cache. `validate` raises SourceError to
        reject a body (then it is neither returned nor cached)."""
        cached = self._cache_get(url, ttl)
        if cached is not None:
            return cached

        host = (urlparse(url).hostname or "").lower()
        pol = self.policy(host)
        st = self._state(host)
        if self._clock() < st.blocked_until:
            mins = int((st.blocked_until - self._clock()) // 60) + 1
            raise SourceBlocked(f"{host} temporarily refuses requests from AG Lex; retry in ~{mins} min.")
        deadline = self._clock() + pol.max_wait  # one budget for queueing + throttle pause
        with self._states_lock:
            if st.waiters >= pol.max_waiters:
                raise SourceBusy(f"{host} is busy; retry in a minute.")
            st.waiters += 1
        try:
            if not st.lock.acquire(timeout=max(0.0, deadline - self._clock())):
                raise SourceBusy(f"{host} is busy; retry in a minute.")
        finally:
            with self._states_lock:
                st.waiters -= 1
        try:
            # Another caller may have fetched this URL while we queued.
            cached = self._cache_get(url, ttl)
            if cached is not None:
                return cached
            status, ctype, body = self._request(url, host, pol, st, headers, deadline)
        finally:
            st.lock.release()

        retrieved_at = datetime.now(tz=timezone.utc).isoformat(timespec="seconds")
        if status == 404:
            self._cache_put(url, 404, ctype, b"", retrieved_at)
            raise SourceNotFound(f"Not found at the official source: {url}")
        f = Fetched(url=url, status=status, body=body, content_type=ctype, retrieved_at=retrieved_at, cached=False)
        if validate is not None:
            validate(f)
        self._cache_put(url, status, ctype, body, retrieved_at)
        return f

    def _request(self, url: str, host: str, pol: HostPolicy, st: _HostState,
                 headers: dict[str, str] | None, deadline: float) -> tuple[int, str, bytes]:
        now = self._clock()
        if now < st.blocked_until:
            raise SourceBlocked(f"{host} temporarily refuses requests from AG Lex; retry later.")
        wait = st.last_request + pol.min_interval - now
        if wait > deadline - now:
            raise SourceBusy(f"{host} is busy; retry in a minute.")
        if wait > 0:
            self._sleep(wait)
        today = datetime.now(tz=timezone.utc).strftime("%Y-%m-%d")
        if st.day != today:
            st.day, st.bytes_today = today, 0
        remaining = pol.daily_bytes - st.bytes_today
        if remaining <= 0:
            raise SourceBusy(f"Daily download budget for {host} is used up; try tomorrow.")

        h = {"User-Agent": pol.user_agent, "Accept-Encoding": "identity", **(headers or {})}
        target = url
        try:
            for _ in range(MAX_REDIRECTS + 1):
                with self._client.stream("GET", target, headers=h) as r:
                    st.last_request = self._clock()
                    if r.status_code in (301, 302, 303, 307, 308):
                        nxt = urljoin(target, r.headers.get("location", ""))
                        if not self._allowed_redirect(nxt):
                            raise SourceError(f"{host} redirected outside the allowed official sources.")
                        target = nxt
                        continue
                    declared = int(r.headers.get("content-length") or 0)
                    if declared > min(MAX_BODY, remaining):
                        raise SourceBusy(f"Response from {host} is too large for today's budget.")
                    chunks, size = [], 0
                    for chunk in r.iter_bytes():
                        size += len(chunk)
                        if size > MAX_BODY or size > remaining:
                            raise SourceBusy(f"Response from {host} is too large.")
                        chunks.append(chunk)
                    status, ctype, body = r.status_code, r.headers.get("content-type", ""), b"".join(chunks)
                    break
            else:
                raise SourceError(f"{host}: too many redirects.")
        except httpx.HTTPError as e:
            st.last_request = self._clock()
            raise SourceError(f"{host} did not respond ({type(e).__name__}).") from e
        st.bytes_today += len(body)

        if status in (403, 429) or self._looks_blocked(body, ctype, pol):
            st.blocked_until = self._clock() + pol.block_cooldown
            raise SourceBlocked(f"{host} refused the request (anti-bot protection); paused for 30 min.")
        if status >= 400 and status != 404:
            raise SourceError(f"{host} answered HTTP {status}.")
        return status, ctype, body

    @staticmethod
    def _looks_blocked(body: bytes, ctype: str, pol: HostPolicy) -> bool:
        if not pol.block_markers or len(body) > MARKER_SCAN_MAX or "json" in ctype.lower():
            return False
        head = body.decode("utf-8", errors="ignore") + body.decode("cp1251", errors="ignore")
        return any(m in head for m in pol.block_markers)
