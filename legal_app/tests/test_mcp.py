"""MCP server + OAuth 2.1 authorization server (docs/mcp/DESIGN.md, stage 1).

End-to-end over TestClient:
- discovery metadata, dynamic client registration with redirect allowlist;
- authorize → consent page login → code → token (PKCE S256);
- tools/list + tools/call with the bearer token;
- matter ACL (non-members see nothing), restricted ChatGPT profile,
  code replay, refresh rotation, revocation, audit rows.
"""
from __future__ import annotations

import base64
import hashlib
import json
import re
import secrets
from urllib.parse import parse_qs, urlparse

import pytest
from fastapi.testclient import TestClient

from backend.audit import init_audit_schema
from backend.database import get_connection, get_db, init_schema, init_user_schema
from backend.documents_routes import init_documents_schema
from backend.main import app
from backend.models import init_entity_schema, migrate_matters, migrate_users
from backend.oauth_server import init_oauth_schema
from backend.rbac import init_permissions_schema, seed_default_permissions

BASE = "http://localhost:8000"  # default PUBLIC_BASE_URL
CLAUDE_REDIRECT = "https://claude.ai/api/mcp/auth_callback"
CHATGPT_REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect"
MCP_HEADERS = {"Accept": "application/json, text/event-stream", "Content-Type": "application/json"}


@pytest.fixture
def db_conn():
    conn = get_connection(":memory:", check_same_thread=False)
    init_schema(conn)
    init_user_schema(conn)
    init_entity_schema(conn)
    init_documents_schema(conn)
    init_permissions_schema(conn)
    seed_default_permissions(conn)
    init_audit_schema(conn)
    init_oauth_schema(conn)
    migrate_users(conn)
    migrate_matters(conn)
    yield conn
    conn.close()


@pytest.fixture
def client(db_conn):
    def _override():
        yield db_conn
    app.dependency_overrides[get_db] = _override
    try:
        with TestClient(app, base_url=BASE) as c:
            yield c
    finally:
        app.dependency_overrides.pop(get_db, None)


def _register_user(client, email, role="lawyer"):
    r = client.post("/api/auth/register", json={
        "name": email.split("@")[0].title(), "email": email, "password": "supersecret", "role": role,
    })
    assert r.status_code == 201, r.text
    return r.json()["user"]["id"]


@pytest.fixture
def seeded(client, db_conn):
    alice = _register_user(client, "alice@aglex.ua", "partner")
    bob = _register_user(client, "bob@aglex.ua", "lawyer")
    db_conn.execute("UPDATE users SET legacy_id = 'ua' WHERE id = ?", (alice,))
    db_conn.execute("UPDATE users SET legacy_id = 'ub' WHERE id = ?", (bob,))
    db_conn.execute(
        "INSERT INTO matters (id, code, title, client, status) VALUES ('m-1', 'SEV-1', 'Поставка зерна', 'Acme', 'active')"
    )
    db_conn.execute("INSERT INTO case_members (case_id, user_id, role_in_case, added_at) VALUES ('m-1', 'ua', 'lead', '2026-09-01')")
    db_conn.execute(
        "INSERT INTO tasks (id, title, matter, assignee, due, priority, col) "
        "VALUES ('t-1', 'Підготувати позов', 'SEV-1', 'ua', '2026-10-05', 'high', 'todo')"
    )
    db_conn.execute(
        "INSERT INTO documents (id, user_id, filename, title, format, content, word_count, created_at) "
        "VALUES ('d-1', ?, 'contract.docx', 'Договір поставки', 'docx', 'Постачальник зобов''язується поставити зерно.', 5, '2026-09-01')",
        (alice,),
    )
    db_conn.execute(
        "INSERT INTO articles (article_number, title, content, source) "
        "VALUES ('625', 'Відповідальність за порушення грошового зобов''язання', 'Боржник не звільняється від відповідальності...', 'ЦКУ')"
    )
    db_conn.commit()
    return {"alice": alice, "bob": bob}


def _pkce():
    verifier = secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    return verifier, challenge


def _register_client(client, redirect=CLAUDE_REDIRECT, name="Claude"):
    r = client.post("/register", json={
        "client_name": name,
        "redirect_uris": [redirect],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "none",
    })
    return r


def _connect(client, email="alice@aglex.ua", redirect=CLAUDE_REDIRECT, scope=None):
    """Run the whole OAuth dance; return (client_info, token_json)."""
    reg = _register_client(client, redirect)
    assert reg.status_code == 201, reg.text
    info = reg.json()
    verifier, challenge = _pkce()
    params = {
        "response_type": "code",
        "client_id": info["client_id"],
        "redirect_uri": redirect,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "state": "xyz",
        "resource": f"{BASE}/mcp",
    }
    if scope:
        params["scope"] = scope
    r = client.get("/authorize", params=params, follow_redirects=False)
    assert r.status_code == 302, r.text
    consent_url = r.headers["location"]
    assert consent_url.startswith(f"{BASE}/oauth/consent?request_id=")
    request_id = parse_qs(urlparse(consent_url).query)["request_id"][0]

    page = client.get(f"/oauth/consent?request_id={request_id}")
    assert page.status_code == 200 and "Підключення до AG Lex" in page.text

    r = client.post("/oauth/consent", data={
        "request_id": request_id, "email": email, "password": "supersecret", "action": "allow",
    }, follow_redirects=False)
    assert r.status_code == 302, r.text
    loc = urlparse(r.headers["location"])
    q = parse_qs(loc.query)
    assert q["state"] == ["xyz"]
    code = q["code"][0]

    tok = client.post("/token", data={
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": redirect,
        "client_id": info["client_id"],
        "code_verifier": verifier,
        "resource": f"{BASE}/mcp",
    })
    assert tok.status_code == 200, tok.text
    return info, tok.json(), code, verifier


def _rpc(client, token, method, params=None, id_=1):
    r = client.post("/mcp", headers={**MCP_HEADERS, "Authorization": f"Bearer {token}"},
                    json={"jsonrpc": "2.0", "id": id_, "method": method, "params": params or {}})
    return r


def _init(client, token):
    r = _rpc(client, token, "initialize", {
        "protocolVersion": "2025-06-18",
        "capabilities": {},
        "clientInfo": {"name": "pytest", "version": "0"},
    })
    assert r.status_code == 200, r.text
    return r


def _call(client, token, name, arguments=None):
    r = _rpc(client, token, "tools/call", {"name": name, "arguments": arguments or {}}, id_=2)
    assert r.status_code == 200, r.text
    result = r.json()["result"]
    text = result["content"][0]["text"] if result.get("content") else ""
    return result, text


# ---------------------------------------------------------------------------
# discovery + registration
# ---------------------------------------------------------------------------

def test_metadata_endpoints(client):
    r = client.get("/.well-known/oauth-authorization-server")
    assert r.status_code == 200
    meta = r.json()
    assert meta["issuer"].rstrip("/") == BASE
    assert meta["authorization_endpoint"] == f"{BASE}/authorize"
    assert "S256" in meta["code_challenge_methods_supported"]
    assert "aglex.read" in meta["scopes_supported"]

    r = client.get("/.well-known/oauth-protected-resource/mcp")
    assert r.status_code == 200
    assert r.json()["resource"] == f"{BASE}/mcp"
    # Must not narrow clients to read-only (they request what PRM lists).
    assert r.json().get("scopes_supported") in (None, ["aglex.read", "aglex.write", "aglex.ai", "aglex.billing"])


def test_mcp_requires_token(client):
    r = client.post("/mcp", headers=MCP_HEADERS, json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
    assert r.status_code == 401
    assert "resource_metadata" in r.headers.get("www-authenticate", "")


def test_spa_and_api_untouched(client):
    assert client.get("/api/health").status_code in (200, 404)  # not hijacked by MCP dispatch
    assert client.get("/authorize-something").status_code != 503


def test_registration_rejects_unknown_redirect(client):
    r = _register_client(client, "https://evil.example.com/cb")
    assert r.status_code == 400
    assert r.json()["error"] == "invalid_redirect_uri"


# ---------------------------------------------------------------------------
# full flow + tools
# ---------------------------------------------------------------------------

def test_full_flow_and_tools(client, seeded, db_conn):
    info, tok, _, _ = _connect(client)
    assert tok["token_type"].lower() == "bearer"
    assert set(tok["scope"].split()) == {"aglex.read", "aglex.write", "aglex.ai", "aglex.billing"}
    at = tok["access_token"]
    assert at.startswith("aglx_at_")
    # only hashes are stored
    assert db_conn.execute("SELECT COUNT(*) FROM oauth_tokens WHERE token_hash = ?", (at,)).fetchone()[0] == 0

    _init(client, at)
    r = _rpc(client, at, "tools/list")
    names = {t["name"] for t in r.json()["result"]["tools"]}
    assert {"whoami", "search", "fetch", "firm_list_matters", "firm_get_matter", "firm_list_tasks",
            "firm_calendar", "firm_search_documents", "firm_get_document",
            "codex_search", "codex_get_article"} <= names

    _, text = _call(client, at, "whoami")
    me = json.loads(text)
    assert me["email"] == "alice@aglex.ua" and me["client_profile"] == "full"

    _, text = _call(client, at, "firm_list_matters", {"query": "зерн"})
    assert [m["id"] for m in json.loads(text)["matters"]] == ["m-1"]

    _, text = _call(client, at, "firm_list_tasks", {"assignee": "me"})
    assert [t["id"] for t in json.loads(text)["tasks"]] == ["t-1"]

    _, text = _call(client, at, "firm_get_document", {"document_id": "d-1"})
    assert "зерно" in json.loads(text)["content"]

    _, text = _call(client, at, "codex_get_article", {"source": "ЦКУ", "article_number": "625"})
    assert json.loads(text)["article_number"] == "625"

    _, text = _call(client, at, "search", {"query": "зерн"})
    ids = [r["id"] for r in json.loads(text)["results"]]
    assert "matter:m-1" in ids and "doc:d-1" in ids

    _, text = _call(client, at, "fetch", {"id": "matter:m-1"})
    assert "Поставка зерна" in json.loads(text)["text"]

    rows = db_conn.execute("SELECT tool FROM mcp_audit").fetchall()
    assert {"whoami", "firm_list_matters", "fetch"} <= {r[0] for r in rows}
    # Tool traffic stays out of the Team audit tab; the grant itself is there.
    assert db_conn.execute("SELECT COUNT(*) FROM audit WHERE action = 'mcp_tool'").fetchone()[0] == 0
    assert db_conn.execute("SELECT COUNT(*) FROM audit WHERE action = 'mcp_grant'").fetchone()[0] == 1


def test_non_member_cannot_see_matter(client, seeded):
    _, tok, _, _ = _connect(client, email="bob@aglex.ua")
    at = tok["access_token"]
    _init(client, at)
    _, text = _call(client, at, "firm_list_matters")
    assert json.loads(text)["matters"] == []
    result, text = _call(client, at, "firm_get_matter", {"matter_id": "m-1"})
    assert result.get("isError") is True
    _, text = _call(client, at, "firm_list_tasks")
    assert json.loads(text)["tasks"] == []


def test_wrong_password_does_not_issue_code(client, seeded):
    info = _register_client(client).json()
    _, challenge = _pkce()
    r = client.get("/authorize", params={
        "response_type": "code", "client_id": info["client_id"], "redirect_uri": CLAUDE_REDIRECT,
        "code_challenge": challenge, "code_challenge_method": "S256", "state": "s",
    }, follow_redirects=False)
    request_id = parse_qs(urlparse(r.headers["location"]).query)["request_id"][0]
    r = client.post("/oauth/consent", data={
        "request_id": request_id, "email": "alice@aglex.ua", "password": "nope", "action": "allow",
    }, follow_redirects=False)
    assert r.status_code == 401
    assert "Невірний" in r.text


def test_deny_redirects_with_access_denied(client, seeded):
    info = _register_client(client).json()
    _, challenge = _pkce()
    r = client.get("/authorize", params={
        "response_type": "code", "client_id": info["client_id"], "redirect_uri": CLAUDE_REDIRECT,
        "code_challenge": challenge, "code_challenge_method": "S256", "state": "s",
    }, follow_redirects=False)
    request_id = parse_qs(urlparse(r.headers["location"]).query)["request_id"][0]
    r = client.post("/oauth/consent", data={"request_id": request_id, "action": "deny"}, follow_redirects=False)
    assert r.status_code == 302
    assert "error=access_denied" in r.headers["location"]


# ---------------------------------------------------------------------------
# ChatGPT restricted profile
# ---------------------------------------------------------------------------

def test_chatgpt_gets_restricted_profile(client, seeded):
    _, tok, _, _ = _connect(client, redirect=CHATGPT_REDIRECT)
    assert tok["scope"] == "aglex.read"
    at = tok["access_token"]
    _init(client, at)
    _, text = _call(client, at, "whoami")
    assert json.loads(text)["client_profile"] == "restricted"

    result, text = _call(client, at, "firm_get_document", {"document_id": "d-1"})
    assert result.get("isError")
    assert "restricted" in text

    _, text = _call(client, at, "search", {"query": "зерн"})
    ids = [r["id"] for r in json.loads(text)["results"]]
    assert "matter:m-1" in ids and not any(i.startswith("doc:") for i in ids)

    # Matter payloads are redacted: no client, parties, notes, member contacts.
    _, text = _call(client, at, "firm_list_matters")
    card = json.loads(text)["matters"][0]
    assert "client" not in card and card["code"] == "SEV-1"
    _, text = _call(client, at, "firm_get_matter", {"matter_id": "m-1"})
    case = json.loads(text)
    for k in ("client", "parties", "notes", "members", "timeline", "hours", "description"):
        assert k not in case
    # …and client names can't be probed through search.
    _, text = _call(client, at, "firm_list_matters", {"query": "acme"})
    assert json.loads(text)["matters"] == []


# ---------------------------------------------------------------------------
# token lifecycle
# ---------------------------------------------------------------------------

def test_code_replay_rejected(client, seeded):
    info, _, code, verifier = _connect(client)
    r = client.post("/token", data={
        "grant_type": "authorization_code", "code": code, "redirect_uri": CLAUDE_REDIRECT,
        "client_id": info["client_id"], "code_verifier": verifier,
    })
    assert r.status_code == 400
    assert r.json()["error"] == "invalid_grant"


def test_refresh_rotates_and_old_refresh_dies(client, seeded):
    info, tok, _, _ = _connect(client)
    r = client.post("/token", data={
        "grant_type": "refresh_token", "refresh_token": tok["refresh_token"], "client_id": info["client_id"],
    })
    assert r.status_code == 200, r.text
    new = r.json()
    assert new["refresh_token"] != tok["refresh_token"]
    _init(client, new["access_token"])

    r = client.post("/token", data={
        "grant_type": "refresh_token", "refresh_token": tok["refresh_token"], "client_id": info["client_id"],
    })
    assert r.status_code == 400


def test_revoke_kills_access(client, seeded):
    info, tok, _, _ = _connect(client)
    _init(client, tok["access_token"])
    r = client.post("/revoke", data={"token": tok["access_token"], "client_id": info["client_id"], "client_secret": ""})
    assert r.status_code == 200, r.text
    r = _rpc(client, tok["access_token"], "tools/list")
    assert r.status_code == 401


def test_role_permission_change_applies_immediately(client, seeded, db_conn):
    _, tok, _, _ = _connect(client, email="bob@aglex.ua")
    at = tok["access_token"]
    _init(client, at)
    db_conn.execute("UPDATE permissions SET allowed = 0 WHERE role = 'lawyer' AND capability = 'view'")
    db_conn.commit()
    result, text = _call(client, at, "firm_list_matters")
    assert result.get("isError")
    assert re.search(r"lacks the 'view' permission", text)


# ---------------------------------------------------------------------------
# review fixes
# ---------------------------------------------------------------------------

def _start_authorize(client):
    info = _register_client(client).json()
    _, challenge = _pkce()
    r = client.get("/authorize", params={
        "response_type": "code", "client_id": info["client_id"], "redirect_uri": CLAUDE_REDIRECT,
        "code_challenge": challenge, "code_challenge_method": "S256", "state": "s",
    }, follow_redirects=False)
    return parse_qs(urlparse(r.headers["location"]).query)["request_id"][0]


def test_consent_login_is_throttled(client, seeded):
    request_id = _start_authorize(client)
    for _ in range(5):
        r = client.post("/oauth/consent", data={
            "request_id": request_id, "email": "alice@aglex.ua", "password": "wrong", "action": "allow",
        }, follow_redirects=False)
        assert r.status_code == 401
    r = client.post("/oauth/consent", data={
        "request_id": request_id, "email": "alice@aglex.ua", "password": "supersecret", "action": "allow",
    }, follow_redirects=False)
    assert r.status_code == 429  # even the right password is refused now


def test_consent_rejects_foreign_origin(client, seeded):
    request_id = _start_authorize(client)
    r = client.post("/oauth/consent", headers={"Origin": "https://evil.example.com"}, data={
        "request_id": request_id, "email": "alice@aglex.ua", "password": "supersecret", "action": "allow",
    }, follow_redirects=False)
    assert r.status_code == 403


def test_consent_accepts_same_origin(client, seeded):
    request_id = _start_authorize(client)
    r = client.post("/oauth/consent", headers={"Origin": BASE}, data={
        "request_id": request_id, "email": "alice@aglex.ua", "password": "supersecret", "action": "allow",
    }, follow_redirects=False)
    assert r.status_code == 302
    page = client.get(f"/oauth/consent?request_id={_start_authorize(client)}")
    assert page.headers["referrer-policy"] == "same-origin"


def test_refresh_reuse_kills_family(client, seeded):
    info, tok, _, _ = _connect(client)
    r = client.post("/token", data={
        "grant_type": "refresh_token", "refresh_token": tok["refresh_token"], "client_id": info["client_id"],
    })
    new = r.json()
    # attacker replays the old refresh token → everything for this grant dies
    client.post("/token", data={
        "grant_type": "refresh_token", "refresh_token": tok["refresh_token"], "client_id": info["client_id"],
    })
    assert _rpc(client, new["access_token"], "tools/list").status_code == 401


def test_tokens_die_when_user_removed_and_id_reused(client, seeded, db_conn):
    _, tok, _, _ = _connect(client, email="bob@aglex.ua")
    _init(client, tok["access_token"])
    bob = seeded["bob"]
    db_conn.execute("DELETE FROM users WHERE id = ?", (bob,))
    db_conn.execute(
        "INSERT INTO users (id, email, name, role, password_hash, created_at) "
        "VALUES (?, 'carol@aglex.ua', 'Carol', 'partner', 'x', date('now'))",
        (bob,),
    )
    db_conn.commit()
    assert _rpc(client, tok["access_token"], "tools/list").status_code == 401


def test_connected_apps_list_and_revoke(client, seeded):
    info, tok, _, _ = _connect(client)
    login = client.post("/api/auth/login", json={"email": "alice@aglex.ua", "password": "supersecret"})
    auth = {"Authorization": f"Bearer {login.json()['access_token']}"}
    apps = client.get("/api/me/connected-apps", headers=auth).json()
    assert [a["client_id"] for a in apps] == [info["client_id"]]
    assert apps[0]["client_name"] == "Claude"
    r = client.delete(f"/api/me/connected-apps/{info['client_id']}", headers=auth)
    assert r.status_code == 200
    assert _rpc(client, tok["access_token"], "tools/list").status_code == 401
    assert client.get("/api/me/connected-apps", headers=auth).json() == []


def test_admin_connected_apps_requires_manage(client, seeded):
    _connect(client, email="bob@aglex.ua")
    login = client.post("/api/auth/login", json={"email": "bob@aglex.ua", "password": "supersecret"})
    auth = {"Authorization": f"Bearer {login.json()['access_token']}"}
    assert client.get("/api/admin/connected-apps", headers=auth).status_code == 403


def test_document_search_escapes_like_wildcards(client, seeded):
    _, tok, _, _ = _connect(client)
    at = tok["access_token"]
    _init(client, at)
    _, text = _call(client, at, "firm_search_documents", {"query": "%"})
    assert json.loads(text)["documents"] == []


def test_calendar_one_sided_bound(client, seeded):
    _, tok, _, _ = _connect(client)
    at = tok["access_token"]
    _init(client, at)
    _, text = _call(client, at, "firm_calendar", {"date_from": "2026-10-06"})
    assert json.loads(text)["events"] == []
    _, text = _call(client, at, "firm_calendar", {"date_to": "2026-10-06"})
    assert [e["id"] for e in json.loads(text)["events"]] == ["t-1"]


def test_public_demo_account_cannot_connect(client, seeded, db_conn):
    from backend.auth import TEST_USER_EMAIL, hash_password
    db_conn.execute(
        "INSERT INTO users (email, name, role, password_hash, created_at) VALUES (?, 'Demo', 'partner', ?, date('now'))",
        (TEST_USER_EMAIL, hash_password("test1234")),
    )
    db_conn.commit()
    request_id = _start_authorize(client)
    r = client.post("/oauth/consent", data={
        "request_id": request_id, "email": TEST_USER_EMAIL, "password": "test1234", "action": "allow",
    }, follow_redirects=False)
    assert r.status_code == 403
    assert "Демо-акаунт" in r.text


def test_code_replay_revokes_issued_tokens(client, seeded):
    info, tok, code, verifier = _connect(client)
    _init(client, tok["access_token"])
    r = client.post("/token", data={
        "grant_type": "authorization_code", "code": code, "redirect_uri": CLAUDE_REDIRECT,
        "client_id": info["client_id"], "code_verifier": verifier,
    })
    assert r.status_code == 400
    assert _rpc(client, tok["access_token"], "tools/list").status_code == 401


def test_documents_require_pdata(client, seeded, db_conn):
    db_conn.execute("UPDATE permissions SET allowed = 0 WHERE role = 'partner' AND capability = 'pdata'")
    db_conn.commit()
    _, tok, _, _ = _connect(client)
    at = tok["access_token"]
    _init(client, at)
    result, text = _call(client, at, "firm_get_document", {"document_id": "d-1"})
    assert result.get("isError") and "pdata" in text
    _, text = _call(client, at, "search", {"query": "зерн"})
    assert not any(r["id"].startswith("doc:") for r in json.loads(text)["results"])


def test_mcp_call_rate_limit(client, seeded, monkeypatch):
    import backend.mcp_server as ms
    monkeypatch.setattr(ms, "RATE_LIMIT_CALLS", 3)
    _, tok, _, _ = _connect(client)
    at = tok["access_token"]
    _init(client, at)
    for _ in range(3):
        result, _ = _call(client, at, "whoami")
        assert not result.get("isError")
    result, text = _call(client, at, "whoami")
    assert result.get("isError") and "Too many" in text


def test_seed_account_with_repo_password_can_connect(client, seeded, db_conn):
    """Firm decision 2026-10-01: viktoria@ may connect on her seed password."""
    from backend.auth import VIKTORIA_USER_EMAIL, VIKTORIA_USER_PASSWORD, hash_password
    db_conn.execute(
        "INSERT INTO users (email, name, role, password_hash, created_at) VALUES (?, 'V', 'partner', ?, date('now'))",
        (VIKTORIA_USER_EMAIL, hash_password(VIKTORIA_USER_PASSWORD)),
    )
    db_conn.commit()
    request_id = _start_authorize(client)
    r = client.post("/oauth/consent", data={
        "request_id": request_id, "email": VIKTORIA_USER_EMAIL, "password": VIKTORIA_USER_PASSWORD, "action": "allow",
    }, follow_redirects=False)
    assert r.status_code == 302, r.text
    # after rotation it still works
    request_id = _start_authorize(client)
    db_conn.execute("UPDATE users SET password_hash = ? WHERE email = ?", (hash_password("rotated-pass-1"), VIKTORIA_USER_EMAIL))
    db_conn.commit()
    r = client.post("/oauth/consent", data={
        "request_id": request_id, "email": VIKTORIA_USER_EMAIL, "password": "rotated-pass-1", "action": "allow",
    }, follow_redirects=False)
    assert r.status_code == 302
