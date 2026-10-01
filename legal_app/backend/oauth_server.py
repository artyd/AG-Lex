"""OAuth 2.1 Authorization Server for the AG Lex MCP endpoint.

AG Lex is its own authorization server: an MCP client (Claude.ai, ChatGPT,
Claude Code, Cursor) registers dynamically (RFC 7591), sends the user to
`/authorize`, the user signs in with their AG Lex email + password on
`/oauth/consent`, and the client exchanges the code (PKCE S256) at `/token`.

Deliberately separate from the SPA JWTs in `auth.py`:
- SPA JWTs live a year, carry no audience/scope and cannot be revoked.
- MCP tokens are opaque random strings; only their SHA-256 lands in the DB.
  Access tokens live 1 h, refresh tokens 30 d and rotate on every use.
  Every token is bound to the MCP resource URL (RFC 8707) and to scopes.

The protocol plumbing (metadata, PKCE check, client auth, redirects) comes
from the `mcp` SDK (`create_auth_routes`); this module is the storage +
policy behind its `OAuthAuthorizationServerProvider` protocol, plus the
sign-in / consent page.
"""
from __future__ import annotations

import functools
import hashlib
import html
import json
import secrets
import sqlite3
import time
from collections import defaultdict
from contextlib import AbstractContextManager
from typing import Callable
from urllib.parse import urlparse

import anyio.to_thread
from mcp.server.auth.provider import (
    AccessToken,
    AuthorizationCode,
    AuthorizationParams,
    AuthorizeError,
    RefreshToken,
    RegistrationError,
    TokenError,
    construct_redirect_uri,
)
from mcp.shared.auth import OAuthClientInformationFull, OAuthToken
from starlette.requests import Request
from starlette.responses import HTMLResponse, RedirectResponse, Response
from starlette.routing import Route

from . import audit as audit_module
from .auth import (
    TEST_USER_EMAIL,
    VIKTORIA_USER_EMAIL,
    VIKTORIA_USER_PASSWORD,
    get_user_by_email,
    hash_password,
    verify_password,
)
from .oauth_store import LINK_PREFIX, resolve_link
from .oauth_store import init_oauth_schema, purge_expired_oauth  # noqa: F401 — re-export

# ---------------------------------------------------------------------------
# policy
# ---------------------------------------------------------------------------

SCOPE_READ = "aglex.read"
SCOPE_WRITE = "aglex.write"
SCOPE_AI = "aglex.ai"
SCOPE_BILLING = "aglex.billing"
ALL_SCOPES = [SCOPE_READ, SCOPE_WRITE, SCOPE_AI, SCOPE_BILLING]

SCOPE_LABELS = {
    SCOPE_READ: "Перегляд справ, задач, календаря, документів і кодексу",
    SCOPE_WRITE: "Створення задач, нотаток і чернеток",
    SCOPE_AI: "Запуск AI-аналізу договорів і звірки",
    SCOPE_BILLING: "Перегляд білінгу та клієнтів",
}

# Client profiles. `restricted` is for ChatGPT: staff use Plus/Pro plans
# where conversations may be used for training, so documents, billing,
# clients, AI tools and writes are never exposed to it (DESIGN.md §5).
PROFILE_FULL = "full"
PROFILE_RESTRICTED = "restricted"
RESTRICTED_SCOPES = [SCOPE_READ]

# Redirect hosts allowed at dynamic registration. Anything else is rejected
# so a random site cannot register itself and phish an AG Lex login.
_REDIRECT_HOSTS_FULL = {"claude.ai", "claude.com", "www.claude.ai"}
_REDIRECT_HOSTS_RESTRICTED = {"chatgpt.com", "chat.openai.com"}
_LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "[::1]", "::1"}

ACCESS_TTL_S = 60 * 60
REFRESH_TTL_S = 30 * 24 * 60 * 60
CODE_TTL_S = 5 * 60
PENDING_TTL_S = 10 * 60

CONSENT_PATH = "/oauth/consent"
ACTION_MCP_GRANT = "mcp_grant"
# Seeded accounts whose passwords are public (auth.py, one-click login).
PUBLIC_DEMO_EMAILS = frozenset({TEST_USER_EMAIL})
# Seeded real accounts whose initial password is in the repo: MCP access is
# refused until the password has been changed from that value.
SEED_PASSWORDS = {VIKTORIA_USER_EMAIL: VIKTORIA_USER_PASSWORD}
ACTION_MCP_REVOKE = "mcp_revoke"

# Consent-login brute-force guard. Single uvicorn worker (CLAUDE.md #2), so an
# in-process counter is authoritative. nginx adds a per-IP limit_req on top.
LOGIN_FAIL_LIMIT = 5
LOGIN_FAIL_WINDOW_S = 15 * 60
MAX_CLIENTS = 2000

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def _hash(secret: str) -> str:
    return hashlib.sha256(secret.encode("utf-8")).hexdigest()


def _now() -> int:
    return int(time.time())


def classify_redirect_uris(uris: list[str]) -> str:
    """Return the client profile for a set of redirect URIs, or raise.

    All URIs must fall in one bucket: loopback (desktop / CLI clients such as
    Claude Code, Cursor, MCP Inspector), Claude web, or ChatGPT web.
    """
    if not uris:
        raise RegistrationError("invalid_redirect_uri", "redirect_uris is required")
    profiles = set()
    for raw in uris:
        u = urlparse(raw)
        host = (u.hostname or "").lower()
        if host in _LOOPBACK_HOSTS and u.scheme in ("http", "https"):
            profiles.add(PROFILE_FULL)
        elif u.scheme == "https" and host in _REDIRECT_HOSTS_FULL:
            profiles.add(PROFILE_FULL)
        elif u.scheme == "https" and host in _REDIRECT_HOSTS_RESTRICTED:
            profiles.add(PROFILE_RESTRICTED)
        else:
            raise RegistrationError(
                "invalid_redirect_uri",
                f"redirect host not allowed for AG Lex: {host or raw}",
            )
    # Mixed ChatGPT + anything → treat as restricted (safer side).
    return PROFILE_RESTRICTED if PROFILE_RESTRICTED in profiles else PROFILE_FULL


def allowed_scopes_for(profile: str) -> list[str]:
    return list(RESTRICTED_SCOPES) if profile == PROFILE_RESTRICTED else list(ALL_SCOPES)


# ---------------------------------------------------------------------------
# provider
# ---------------------------------------------------------------------------

def _offloaded(fn):
    """Expose a sync DB-bound method as the async one the SDK protocol wants,
    running it in a worker thread so SQLite waits never stall the event loop."""

    @functools.wraps(fn)
    async def wrapper(self, *args, **kwargs):
        return await anyio.to_thread.run_sync(functools.partial(fn, self, *args, **kwargs))

    return wrapper


ConnFactory = Callable[[], AbstractContextManager[sqlite3.Connection]]


class AgLexOAuthProvider:
    """`OAuthAuthorizationServerProvider` backed by the AG Lex SQLite DB."""

    def __init__(self, *, base_url: str, resource_url: str, conn_factory: ConnFactory):
        self.base_url = base_url.rstrip("/")
        self.resource_url = resource_url
        self._conn = conn_factory
        self._fails: dict[str, list[float]] = defaultdict(list)
        # Burned on unknown emails so response time doesn't reveal which exist.
        self._dummy_hash = hash_password(secrets.token_urlsafe(16))

    # -- clients -----------------------------------------------------------

    @_offloaded
    def get_client(self, client_id: str) -> OAuthClientInformationFull | None:
        with self._conn() as conn:
            row = conn.execute(
                "SELECT client_info FROM oauth_clients WHERE client_id = ?", (client_id,)
            ).fetchone()
        if row is None:
            return None
        return OAuthClientInformationFull.model_validate_json(row[0])

    @_offloaded
    def register_client(self, client_info: OAuthClientInformationFull) -> None:
        profile = classify_redirect_uris([str(u) for u in (client_info.redirect_uris or [])])
        with self._conn() as conn:
            purge_expired_oauth(conn)
            (count,) = conn.execute("SELECT COUNT(*) FROM oauth_clients").fetchone()
            if count >= MAX_CLIENTS:
                raise RegistrationError("invalid_client_metadata", "client registration temporarily unavailable")
            conn.execute(
                "INSERT OR REPLACE INTO oauth_clients (client_id, client_info, profile, created_at) "
                "VALUES (?, ?, ?, ?)",
                (client_info.client_id, client_info.model_dump_json(), profile, _now()),
            )
            conn.commit()

    def client_profile(self, conn: sqlite3.Connection, client_id: str) -> str:
        row = conn.execute(
            "SELECT profile FROM oauth_clients WHERE client_id = ?", (client_id,)
        ).fetchone()
        # Unknown client → most restrictive profile.
        return row[0] if row else PROFILE_RESTRICTED

    # -- authorize ---------------------------------------------------------

    @_offloaded
    def authorize(self, client: OAuthClientInformationFull, params: AuthorizationParams) -> str:
        if params.resource and params.resource.rstrip("/") != self.resource_url.rstrip("/"):
            raise AuthorizeError("invalid_target", "unknown resource")
        request_id = secrets.token_urlsafe(32)
        with self._conn() as conn:
            conn.execute("DELETE FROM oauth_pending WHERE expires_at < ?", (_now(),))
            conn.execute(
                "INSERT INTO oauth_pending (request_id, client_id, params, expires_at) VALUES (?, ?, ?, ?)",
                (request_id, client.client_id, params.model_dump_json(), _now() + PENDING_TTL_S),
            )
            conn.commit()
        return f"{self.base_url}{CONSENT_PATH}?request_id={request_id}"

    def _load_pending(self, conn: sqlite3.Connection, request_id: str):
        row = conn.execute(
            "SELECT client_id, params, expires_at FROM oauth_pending WHERE request_id = ?",
            (request_id,),
        ).fetchone()
        if row is None or row[2] < _now():
            return None
        return row[0], AuthorizationParams.model_validate_json(row[1])

    def _grant_scopes(self, requested: list[str] | None, profile: str) -> list[str]:
        allowed = allowed_scopes_for(profile)
        if not requested:
            return allowed
        granted = [s for s in requested if s in allowed]
        return granted or [SCOPE_READ]

    def complete_authorization(self, conn: sqlite3.Connection, request_id: str, user_id: int) -> str:
        """Consume a pending request, mint a code, return the client redirect URL."""
        pending = self._load_pending(conn, request_id)
        if pending is None:
            raise AuthorizeError("invalid_request", "authorization request expired")
        client_id, params = pending
        cur = conn.execute("DELETE FROM oauth_pending WHERE request_id = ?", (request_id,))
        if cur.rowcount != 1:
            raise AuthorizeError("invalid_request", "authorization request already used")
        profile = self.client_profile(conn, client_id)
        code = secrets.token_urlsafe(32)  # 256 bits
        auth_code = AuthorizationCode(
            code="",
            scopes=self._grant_scopes(params.scopes, profile),
            expires_at=time.time() + CODE_TTL_S,
            client_id=client_id,
            code_challenge=params.code_challenge,
            redirect_uri=params.redirect_uri,
            redirect_uri_provided_explicitly=params.redirect_uri_provided_explicitly,
            resource=params.resource or self.resource_url,
            subject=str(user_id),
        )
        conn.execute(
            "INSERT INTO oauth_codes (code_hash, client_id, user_id, data, expires_at) VALUES (?, ?, ?, ?, ?)",
            (_hash(code), client_id, user_id, auth_code.model_dump_json(), int(auth_code.expires_at)),
        )
        conn.commit()
        return construct_redirect_uri(str(params.redirect_uri), code=code, state=params.state)

    def deny_authorization(self, conn: sqlite3.Connection, request_id: str) -> str | None:
        pending = self._load_pending(conn, request_id)
        conn.execute("DELETE FROM oauth_pending WHERE request_id = ?", (request_id,))
        conn.commit()
        if pending is None:
            return None
        _, params = pending
        return construct_redirect_uri(
            str(params.redirect_uri), error="access_denied", state=params.state
        )

    @_offloaded
    def load_authorization_code(
        self, client: OAuthClientInformationFull, authorization_code: str
    ) -> AuthorizationCode | None:
        with self._conn() as conn:
            row = conn.execute(
                "SELECT data, used, user_id FROM oauth_codes WHERE code_hash = ? AND client_id = ?",
                (_hash(authorization_code), client.client_id),
            ).fetchone()
            if row is not None and row[1]:
                # Code replay (RFC 6749 §4.1.2): revoke what it already minted.
                conn.execute(
                    "UPDATE oauth_tokens SET revoked = 1 WHERE client_id = ? AND user_id = ?",
                    (client.client_id, row[2]),
                )
                conn.commit()
                return None
        if row is None:
            return None
        code = AuthorizationCode.model_validate_json(row[0])
        return code.model_copy(update={"code": authorization_code})

    @_offloaded
    def exchange_authorization_code(
        self, client: OAuthClientInformationFull, authorization_code: AuthorizationCode
    ) -> OAuthToken:
        with self._conn() as conn:
            # Keep the row (marked used) until it expires so a replay is detectable.
            cur = conn.execute(
                "UPDATE oauth_codes SET used = 1 WHERE code_hash = ? AND used = 0",
                (_hash(authorization_code.code),),
            )
            if cur.rowcount != 1:  # already used → replay
                conn.commit()
                raise TokenError("invalid_grant", "authorization code already used")
            token = self._issue_pair(
                conn,
                client_id=client.client_id,
                user_id=int(authorization_code.subject or 0),
                scopes=authorization_code.scopes,
                resource=authorization_code.resource,
            )
            conn.commit()
        return token

    # -- tokens ------------------------------------------------------------

    def _issue_pair(
        self,
        conn: sqlite3.Connection,
        *,
        client_id: str,
        user_id: int,
        scopes: list[str],
        resource: str | None,
    ) -> OAuthToken:
        row = conn.execute("SELECT email FROM users WHERE id = ?", (user_id,)).fetchone() if user_id else None
        if row is None:
            raise TokenError("invalid_grant", "no resource owner")
        email = row[0]
        now = _now()
        access = "aglx_at_" + secrets.token_urlsafe(32)
        refresh = "aglx_rt_" + secrets.token_urlsafe(32)
        scope_str = " ".join(scopes)
        conn.executemany(
            "INSERT INTO oauth_tokens (token_hash, kind, client_id, user_id, user_email, scopes, resource, "
            "expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [
                (_hash(access), "access", client_id, user_id, email, scope_str, resource, now + ACCESS_TTL_S, now),
                (_hash(refresh), "refresh", client_id, user_id, email, scope_str, resource, now + REFRESH_TTL_S, now),
            ],
        )
        return OAuthToken(
            access_token=access,
            token_type="Bearer",
            expires_in=ACCESS_TTL_S,
            scope=scope_str,
            refresh_token=refresh,
        )

    def _load_token(self, conn: sqlite3.Connection, token: str, kind: str):
        row = conn.execute(
            "SELECT t.client_id, t.user_id, t.scopes, t.resource, t.expires_at, t.revoked "
            "FROM oauth_tokens t JOIN users u ON u.id = t.user_id AND u.email = t.user_email "
            "WHERE t.token_hash = ? AND t.kind = ?",
            (_hash(token), kind),
        ).fetchone()
        if row is None or row[4] < _now():
            return None
        if row[5]:
            if kind == "refresh":
                # A rotated refresh token came back → assume theft, kill the family
                # (OAuth 2.1 §4.3.1; most DCR clients here are public clients).
                conn.execute(
                    "UPDATE oauth_tokens SET revoked = 1 WHERE client_id = ? AND user_id = ?",
                    (row[0], row[1]),
                )
                conn.commit()
            return None
        return row[:5]

    @_offloaded
    def load_access_token(self, token: str) -> AccessToken | None:
        if token.startswith(LINK_PREFIX):
            return self._link_token(token)
        with self._conn() as conn:
            row = self._load_token(conn, token, "access")
        if row is None:
            return None
        client_id, user_id, scopes, resource, expires_at = row
        return AccessToken(
            token=token,
            client_id=client_id,
            scopes=scopes.split(),
            expires_at=expires_at,
            resource=resource,
            subject=str(user_id),
        )

    def _link_token(self, key: str) -> AccessToken | None:
        """A secret-link key (/mcp/k/<key>, see mcp_dispatch) acts as a
        long-lived access token for one employee — no OAuth dance."""
        with self._conn() as conn:
            link = resolve_link(conn, key)
        if link is None:
            return None
        return AccessToken(
            token=key,
            client_id=f"link:{link['id']}",
            scopes=list(ALL_SCOPES) if link["unrestricted"] else allowed_scopes_for(link["profile"]),
            expires_at=link["expires_at"],
            resource=self.resource_url,
            subject=str(link["user_id"]),
        )

    @_offloaded
    def load_refresh_token(
        self, client: OAuthClientInformationFull, refresh_token: str
    ) -> RefreshToken | None:
        with self._conn() as conn:
            row = self._load_token(conn, refresh_token, "refresh")
        if row is None or row[0] != client.client_id:
            return None
        client_id, user_id, scopes, resource, expires_at = row
        return RefreshToken(
            token=refresh_token,
            client_id=client_id,
            scopes=scopes.split(),
            expires_at=expires_at,
            resource=resource,
            subject=str(user_id),
        )

    @_offloaded
    def exchange_refresh_token(
        self,
        client: OAuthClientInformationFull,
        refresh_token: RefreshToken,
        scopes: list[str],
    ) -> OAuthToken:
        with self._conn() as conn:
            cur = conn.execute(
                "UPDATE oauth_tokens SET revoked = 1 WHERE token_hash = ? AND kind = 'refresh' AND revoked = 0",
                (_hash(refresh_token.token),),
            )
            if cur.rowcount != 1:
                # Replay of a rotated refresh token → assume theft, kill the family.
                conn.execute(
                    "UPDATE oauth_tokens SET revoked = 1 WHERE client_id = ? AND user_id = ?",
                    (client.client_id, int(refresh_token.subject or 0)),
                )
                conn.commit()
                raise TokenError("invalid_grant", "refresh token already used")
            token = self._issue_pair(
                conn,
                client_id=client.client_id,
                user_id=int(refresh_token.subject or 0),
                scopes=scopes or refresh_token.scopes,
                resource=refresh_token.resource,
            )
            conn.commit()
        return token

    @_offloaded
    def revoke_token(self, token: AccessToken | RefreshToken) -> None:
        # Revoking either half kills every live token this client holds for
        # this user — the user-facing meaning of "disconnect".
        with self._conn() as conn:
            conn.execute(
                "UPDATE oauth_tokens SET revoked = 1 WHERE client_id = ? AND user_id = ?",
                (token.client_id, int(token.subject or 0)),
            )
            conn.commit()

    # -- consent page ------------------------------------------------------

    def consent_routes(self) -> list[Route]:
        return [Route(CONSENT_PATH, endpoint=self._consent, methods=["GET", "POST"])]

    def _throttled(self, keys: list[str]) -> bool:
        now = time.time()
        if len(self._fails) > 10_000:  # sweep keys nobody retried (distinct emails/IPs)
            for k in [k for k, v in self._fails.items() if not v or now - v[-1] >= LOGIN_FAIL_WINDOW_S]:
                self._fails.pop(k, None)
        hit = False
        for k in keys:
            recent = [t for t in self._fails.get(k, []) if now - t < LOGIN_FAIL_WINDOW_S]
            if recent:
                self._fails[k] = recent
            else:
                self._fails.pop(k, None)
            hit = hit or len(recent) >= LOGIN_FAIL_LIMIT
        return hit

    def _record_fail(self, keys: list[str]) -> None:
        now = time.time()
        for k in keys:
            self._fails[k].append(now)

    async def _consent(self, request: Request) -> Response:
        # All DB work and bcrypt (~250 ms CPU) run in a worker thread: the
        # single uvicorn worker's event loop also serves /ws and every API call.
        if request.method == "GET":
            request_id = request.query_params.get("request_id", "")
            return await anyio.to_thread.run_sync(self._render_consent, request_id)

        origin = request.headers.get("origin")
        if origin and origin.rstrip("/") != self.base_url:
            return self._render_error("Запит відхилено: невірне джерело форми.", 403)
        form = {k: str(v) for k, v in (await request.form()).items()}
        ip = request.headers.get("x-real-ip") or (request.client.host if request.client else "")
        return await anyio.to_thread.run_sync(self._consent_post, form, ip)

    def _consent_post(self, form: dict, ip: str) -> Response:
        request_id = form.get("request_id", "")
        action = form.get("action", "")
        if action == "deny":
            with self._conn() as conn:
                url = self.deny_authorization(conn, request_id)
            if url is None:
                return self._render_error("Запит на авторизацію застарів. Почніть підключення знову.")
            return RedirectResponse(url, status_code=302)

        email = form.get("email", "").strip().lower()
        password = form.get("password", "")
        keys = [f"email:{email}", f"req:{request_id}", f"ip:{ip}"]
        if self._throttled(keys):
            with self._conn() as conn:
                conn.execute("DELETE FROM oauth_pending WHERE request_id = ?", (request_id,))
                conn.commit()
            return self._render_error("Забагато невдалих спроб входу. Зачекайте 15 хвилин і почніть знову.", 429)

        with self._conn() as conn:
            user = get_user_by_email(conn, email) if email else None
        hashed = user["password_hash"] if user else self._dummy_hash
        ok = verify_password(password, hashed)
        if user is None or not ok:
            self._record_fail(keys)
            return self._render_consent(request_id, error="Невірний email або пароль.", status=401)
        if user["email"] in PUBLIC_DEMO_EMAILS:
            # Its password is in the repo and on the one-click login button —
            # never let it hand a third-party AI a partner-level token.
            return self._render_consent(
                request_id, error="Демо-акаунт не можна підключати до зовнішніх AI.", status=403
            )
        if SEED_PASSWORDS.get(user["email"]) == password:
            return self._render_consent(
                request_id,
                error="Пароль цього акаунта ще початковий (він є в коді). Змініть його, потім підключайте AI.",
                status=403,
            )
        for k in keys[:2]:
            self._fails.pop(k, None)
        with self._conn() as conn:
            pending = self._load_pending(conn, request_id)
            try:
                url = self.complete_authorization(conn, request_id, user["id"])
            except AuthorizeError:
                return self._render_error("Запит на авторизацію застарів. Почніть підключення знову.")
            if pending is not None:
                self._audit_grant(conn, user, pending[0], pending[1])
        return RedirectResponse(url, status_code=302)

    def _audit_grant(self, conn: sqlite3.Connection, user: dict, client_id: str, params: AuthorizationParams) -> None:
        """A third-party AI got standing access — as audit-worthy as a role change."""
        row = conn.execute(
            "SELECT client_info, profile FROM oauth_clients WHERE client_id = ?", (client_id,)
        ).fetchone()
        info = json.loads(row[0]) if row else {}
        try:
            audit_module.log(
                conn,
                actor=user,
                action=ACTION_MCP_GRANT,
                target=info.get("client_name") or client_id,
                meta={
                    "client_id": client_id,
                    "profile": row[1] if row else None,
                    "redirect_host": urlparse(str(params.redirect_uri)).netloc,
                },
            )
        except sqlite3.Error:
            pass

    def _render_consent(self, request_id: str, *, error: str = "", status: int = 200) -> Response:
        with self._conn() as conn:
            pending = self._load_pending(conn, request_id)
            if pending is None:
                return self._render_error("Запит на авторизацію застарів. Почніть підключення знову.")
            client_id, params = pending
            profile = self.client_profile(conn, client_id)
            row = conn.execute(
                "SELECT client_info FROM oauth_clients WHERE client_id = ?", (client_id,)
            ).fetchone()
        info = json.loads(row[0]) if row else {}
        client_name = info.get("client_name") or client_id
        redirect_host = urlparse(str(params.redirect_uri)).netloc
        scopes = self._grant_scopes(params.scopes, profile)
        items = "".join(f"<li>{html.escape(SCOPE_LABELS.get(s, s))}</li>" for s in scopes)
        restricted_note = (
            "<p class='note'>Цей клієнт отримує обмежений доступ: без документів, білінгу, "
            "клієнтів і AI-інструментів (політика фірми для ChatGPT).</p>"
            if profile == PROFILE_RESTRICTED
            else ""
        )
        err = f"<p class='err'>{html.escape(error)}</p>" if error else ""
        body = _PAGE.format(
            content=f"""
            <h1>Підключення до AG Lex</h1>
            <p><b>{html.escape(client_name)}</b> запитує доступ до вашого робочого простору.<br>
            <small>Назва застосунку не перевірена. Після входу вас буде перенаправлено на
            <b>{html.escape(redirect_host)}</b>. Продовжуйте, лише якщо ви самі щойно почали це підключення.</small></p>
            <ul>{items}</ul>
            {restricted_note}
            {err}
            <form method="post" action="{CONSENT_PATH}">
              <input type="hidden" name="request_id" value="{html.escape(request_id)}">
              <label>Email<input name="email" type="email" autocomplete="username" required></label>
              <label>Пароль<input name="password" type="password" autocomplete="current-password" required></label>
              <div class="row">
                <button name="action" value="allow" type="submit">Дозволити</button>
                <button name="action" value="deny" type="submit" formnovalidate class="ghost">Відхилити</button>
              </div>
            </form>
            """
        )
        return HTMLResponse(body, status_code=status, headers=_PAGE_HEADERS)

    def _render_error(self, message: str, status: int = 400) -> Response:
        body = _PAGE.format(content=f"<h1>AG Lex</h1><p class='err'>{html.escape(message)}</p>")
        return HTMLResponse(body, status_code=status, headers=_PAGE_HEADERS)


_PAGE_HEADERS = {
    "Cache-Control": "no-store",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
    # same-origin, not no-referrer: with no-referrer browsers send
    # `Origin: null` on the form POST and the Origin check would reject it.
    "Referrer-Policy": "same-origin",
}

_PAGE = """<!doctype html>
<html lang="uk"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AG Lex — підключення</title>
<style>
body{{font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#f5f5f4;color:#1c1917;margin:0;
display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px}}
main{{background:#fff;border-radius:12px;box-shadow:0 1px 4px rgba(0,0,0,.08);padding:28px;max-width:420px;width:100%}}
h1{{font-size:20px;margin:0 0 12px}} ul{{padding-left:20px}} label{{display:block;margin:12px 0;font-size:14px}}
input{{display:block;width:100%;box-sizing:border-box;margin-top:4px;padding:9px;border:1px solid #d6d3d1;border-radius:8px;font-size:15px}}
.row{{display:flex;gap:8px;margin-top:16px}} button{{flex:1;padding:10px;border:0;border-radius:8px;background:#1e3a8a;color:#fff;font-size:15px;cursor:pointer}}
button.ghost{{background:#e7e5e4;color:#1c1917}} .err{{color:#b91c1c}} .note{{color:#92400e;font-size:14px}}
</style></head><body><main>{content}</main></body></html>"""
