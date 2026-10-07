"""Secret-link MCP connectors: /mcp/k/<key> without an OAuth login."""
from __future__ import annotations

import json
import logging
from urllib.parse import urlparse

import pytest

from tests.test_mcp import MCP_HEADERS, client, db_conn, seeded  # noqa: F401 — fixtures


@pytest.fixture(autouse=True)
def _reset_pw_throttle():
    from backend import mcp_grants_routes
    mcp_grants_routes._PW_FAILS.clear()
    yield
    mcp_grants_routes._PW_FAILS.clear()


def _web(client, email="alice@aglex.ua"):
    r = client.post("/api/auth/login", json={"email": email, "password": "supersecret"})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


def _make_link(client, auth, **kw):
    body = {"label": "Claude Desktop", "password": "supersecret", **kw}
    return client.post("/api/me/mcp-links", headers=auth, json=body)


def _path(url: str) -> str:
    return urlparse(url).path


def _rpc(client, path, method, params=None, headers=None):
    return client.post(path, headers={**MCP_HEADERS, **(headers or {})},
                       json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}})


def _init(client, path):
    r = _rpc(client, path, "initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                          "clientInfo": {"name": "pytest", "version": "0"}})
    assert r.status_code == 200, r.text


def _call(client, path, name, args=None):
    r = _rpc(client, path, "tools/call", {"name": name, "arguments": args or {}})
    assert r.status_code == 200, r.text
    res = r.json()["result"]
    return res, res["content"][0]["text"]


def test_link_works_without_login(client, seeded, db_conn):
    web = _web(client)
    r = _make_link(client, web)
    assert r.status_code == 201, r.text
    url = r.json()["url"]
    assert url.startswith("http://localhost:8000/mcp/k/aglx_lk_")
    assert len(url.rsplit("/", 1)[1]) == len("aglx_lk_") + 22  # short enough to paste by hand
    path = _path(url)
    _init(client, path)
    names = {t["name"] for t in _rpc(client, path, "tools/list").json()["result"]["tools"]}
    assert {"whoami", "firm_list_matters", "ua_sc_legal_positions"} <= names
    res, text = _call(client, path, "whoami")
    me = json.loads(text)
    assert me["email"] == "alice@aglex.ua" and me["client_profile"] == "full"
    assert "aglex.write" in me["scopes"]
    # list never returns the key, only a hint; audit has the creation
    links = client.get("/api/me/mcp-links", headers=web).json()
    assert len(links) == 1 and "key" not in links[0] and links[0]["key_hint"] == url[-4:]
    assert links[0]["last_used_at"]
    assert db_conn.execute("SELECT COUNT(*) FROM audit WHERE action = 'mcp_link_create'").fetchone()[0] == 1
    # only the hash is stored
    key = path.rsplit("/", 1)[1]
    assert db_conn.execute("SELECT COUNT(*) FROM mcp_links WHERE key_hash = ?", (key,)).fetchone()[0] == 0
    # writes are marked with the link label
    _, text = _call(client, path, "firm_add_note", {"matter_id": "m-1", "text": "через посилання"})
    note_id = json.loads(text)["note"]["id"]
    assert db_conn.execute("SELECT text FROM case_notes WHERE id = ?", (note_id,)).fetchone()[0].startswith(
        "🤖 [Claude Desktop · посилання · MCP]")


def test_client_authorization_header_is_replaced(client, seeded):
    path = _path(_make_link(client, _web(client)).json()["url"])
    r = _rpc(client, path, "initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                          "clientInfo": {"name": "x", "version": "0"}},
             headers={"Authorization": "Bearer something-else"})
    assert r.status_code == 200


def test_bad_unknown_revoked_expired_links(client, seeded, db_conn):
    assert _rpc(client, "/mcp/k/aglx_lk_" + "x" * 43, "tools/list").status_code == 401
    assert _rpc(client, "/mcp/k/not-a-key", "tools/list").status_code == 404
    web = _web(client)
    r = _make_link(client, web).json()
    path = _path(r["url"])
    _init(client, path)
    assert client.delete(f"/api/me/mcp-links/{r['id']}", headers=web).status_code == 200
    assert _rpc(client, path, "tools/list").status_code == 401
    r2 = _make_link(client, web).json()
    db_conn.execute("UPDATE mcp_links SET expires_at = 1 WHERE id = ?", (r2["id"],))
    db_conn.commit()
    assert _rpc(client, _path(r2["url"]), "tools/list").status_code == 401


def test_link_dies_when_owner_replaced(client, seeded, db_conn):
    path = _path(_make_link(client, _web(client, "bob@aglex.ua")).json()["url"])
    _init(client, path)
    db_conn.execute("UPDATE users SET email = 'someone@aglex.ua' WHERE id = ?", (seeded["bob"],))
    db_conn.commit()
    assert _rpc(client, path, "tools/list").status_code == 401


def test_restricted_link(client, seeded):
    path = _path(_make_link(client, _web(client), profile="restricted").json()["url"])
    _init(client, path)
    res, text = _call(client, path, "firm_get_document", {"document_id": "d-1"})
    assert res.get("isError") and "restricted access" in text


def test_create_requires_password_and_limits(client, seeded, monkeypatch):
    web = _web(client)
    assert _make_link(client, web, password="wrong").status_code == 403
    import backend.oauth_store as st
    monkeypatch.setattr(st, "MAX_LINKS_PER_USER", 2)
    assert _make_link(client, web).status_code == 201
    assert _make_link(client, web).status_code == 201
    assert _make_link(client, web).status_code == 409


def test_seed_account_can_create_link(client, seeded, db_conn):
    """Firm decision 2026-10-01: viktoria@ may mint links on her seed password."""
    from backend.auth import VIKTORIA_USER_EMAIL, VIKTORIA_USER_PASSWORD, hash_password
    db_conn.execute(
        "INSERT INTO users (email, name, role, password_hash, created_at) VALUES (?, 'V', 'partner', ?, date('now'))",
        (VIKTORIA_USER_EMAIL, hash_password(VIKTORIA_USER_PASSWORD)),
    )
    db_conn.commit()
    login = client.post("/api/auth/login", json={"email": VIKTORIA_USER_EMAIL, "password": VIKTORIA_USER_PASSWORD})
    auth = {"Authorization": f"Bearer {login.json()['access_token']}"}
    r = client.post("/api/me/mcp-links", headers=auth, json={"password": VIKTORIA_USER_PASSWORD})
    assert r.status_code == 201, r.text


def test_admin_links_require_manage(client, seeded):
    _make_link(client, _web(client, "bob@aglex.ua"))
    bob = _web(client, "bob@aglex.ua")
    assert client.get("/api/admin/mcp-links", headers=bob).status_code == 403
    alice = _web(client)
    links = client.get("/api/admin/mcp-links", headers=alice).json()
    assert links[0]["user_email"] == "bob@aglex.ua"
    assert client.delete(f"/api/admin/mcp-links/{links[0]['id']}", headers=alice).status_code == 200


def test_access_log_redacts_keys():
    from backend.mcp_dispatch import RedactLinkKeys
    rec = logging.LogRecord("uvicorn.access", logging.INFO, "", 0, '%s - "%s %s HTTP/%s" %d',
                            ("1.2.3.4", "POST", "/mcp/k/aglx_lk_SECRETSECRETSECRETSECRET", "1.1", 200), None)
    RedactLinkKeys().filter(rec)
    assert "SECRET" not in rec.getMessage() and "/mcp/k/***" in rec.getMessage()



# ---------------------------------------------------------------------------
# review round: idle expiry, demo, throttle, removal, incident revoke-all
# ---------------------------------------------------------------------------

def test_idle_link_stops_working(client, seeded, db_conn):
    r = _make_link(client, _web(client)).json()
    db_conn.execute("UPDATE mcp_links SET created_at = 1, last_used_at = 1 WHERE id = ?", (r["id"],))
    db_conn.commit()
    assert _rpc(client, _path(r["url"]), "tools/list").status_code == 401


def test_default_ttl_is_90_days(client, seeded, db_conn):
    r = _make_link(client, _web(client)).json()
    created, expires = db_conn.execute("SELECT created_at, expires_at FROM mcp_links WHERE id = ?", (r["id"],)).fetchone()
    assert expires - created == 90 * 86400


def test_demo_account_cannot_create_link(client, seeded, db_conn):
    from backend.auth import TEST_USER_EMAIL, hash_password
    db_conn.execute(
        "INSERT INTO users (email, name, role, password_hash, created_at) VALUES (?, 'Demo', 'partner', ?, date('now'))",
        (TEST_USER_EMAIL, hash_password("another-pass-1")),
    )
    db_conn.commit()
    login = client.post("/api/auth/login", json={"email": TEST_USER_EMAIL, "password": "another-pass-1"})
    auth = {"Authorization": f"Bearer {login.json()['access_token']}"}
    r = client.post("/api/me/mcp-links", headers=auth, json={"password": "another-pass-1"})
    assert r.status_code == 403 and "Демо" in r.json()["detail"]


def test_password_recheck_is_throttled(client, seeded):
    web = _web(client, "bob@aglex.ua")
    for _ in range(5):
        assert _make_link(client, web, password="wrong").status_code == 403
    assert _make_link(client, web).status_code == 429  # even the right one, for 15 min


def test_removing_member_revokes_links(client, seeded, db_conn):
    path = _path(_make_link(client, _web(client, "bob@aglex.ua")).json()["url"])
    _init(client, path)
    r = client.delete(f"/api/team/members/{seeded['bob']}", headers=_web(client))
    assert r.status_code == 204, r.text
    assert db_conn.execute("SELECT revoked FROM mcp_links").fetchone()[0] == 1
    assert _rpc(client, path, "tools/list").status_code == 401


def test_admin_revokes_all_mcp_access_of_user(client, seeded):
    bob = _web(client, "bob@aglex.ua")
    p1 = _path(_make_link(client, bob).json()["url"])
    p2 = _path(_make_link(client, bob, label="Cursor").json()["url"])
    r = client.delete(f"/api/admin/mcp-access/{seeded['bob']}", headers=_web(client))
    assert r.status_code == 200 and r.json()["revoked"] >= 2
    assert _rpc(client, p1, "tools/list").status_code == 401 and _rpc(client, p2, "tools/list").status_code == 401
    assert client.delete(f"/api/admin/mcp-access/{seeded['alice']}", headers=bob).status_code == 403



# ---------------------------------------------------------------------------
# unrestricted links (firm decision 2026-10-01)
# ---------------------------------------------------------------------------

@pytest.fixture
def other_matter(seeded, db_conn):
    db_conn.execute("INSERT INTO matters (id, code, title, client, status, next_deadline) "
                    "VALUES ('m-2', 'VEK-2', 'Чужа справа', 'ТД Вектор', 'active', '2026-11-01')")
    db_conn.execute("INSERT INTO case_members (case_id, user_id, role_in_case, added_at) VALUES ('m-2', 'ub', 'lead', 'x')")
    db_conn.execute("INSERT INTO tasks (id, title, matter, assignee, due, priority, col) "
                    "VALUES ('t-2', 'Чужа задача', 'VEK-2', 'ub', '2026-10-10', 'med', 'todo')")
    db_conn.execute("INSERT INTO mcp_policy (kind, key, set_at) VALUES ('matter', 'm-1', 'now')")
    db_conn.commit()
    return seeded


def test_unrestricted_requires_manage(client, seeded):
    r = client.post("/api/me/mcp-links", headers=_web(client, "bob@aglex.ua"), json={"unrestricted": True})
    assert r.status_code == 403


def test_unrestricted_link_sees_everything_without_limits(client, other_matter, db_conn, monkeypatch):
    web = _web(client)  # alice: partner (manage)
    r = client.post("/api/me/mcp-links", headers=web, json={"label": "Віка", "unrestricted": True})  # no password
    assert r.status_code == 201, r.text
    assert r.json()["unrestricted"] is True and r.json()["expires_in_days"] is None
    path = _path(r.json()["url"])
    _init(client, path)

    # firm-wide matters, incl. one alice isn't on and one closed by ai_external policy
    _, text = _call(client, path, "firm_list_matters")
    assert {m["id"] for m in json.loads(text)["matters"]} == {"m-1", "m-2"}
    _, text = _call(client, path, "firm_get_matter", {"matter_id": "m-1"})
    assert json.loads(text)["id"] == "m-1"
    _, text = _call(client, path, "firm_list_tasks")
    assert {t["id"] for t in json.loads(text)["tasks"]} == {"t-1", "t-2"}
    _, text = _call(client, path, "firm_calendar")
    assert {e["case_id"] for e in json.loads(text)["events"]} >= {"m-1", "m-2"}
    # writes into someone else's matter, task for its member
    res, text = _call(client, path, "firm_create_task", {"matter_id": "m-2", "title": "x", "assignee": "ub"})
    assert not res.get("isError"), text

    # role capabilities ignored
    db_conn.execute("UPDATE permissions SET allowed = 0 WHERE role = 'partner'")
    db_conn.commit()
    res, text = _call(client, path, "firm_get_document", {"document_id": "d-1"})
    assert not res.get("isError"), text

    # no rate limit
    import backend.mcp_server as ms
    monkeypatch.setattr(ms, "RATE_LIMIT_CALLS", 1)
    for _ in range(3):
        res, _ = _call(client, path, "whoami")
        assert not res.get("isError")

    # no expiry / idle timeout
    db_conn.execute("UPDATE mcp_links SET created_at = 1, last_used_at = 1 WHERE id = ?", (r.json()["id"],))
    db_conn.commit()
    assert _rpc(client, path, "tools/list").status_code == 200
    assert client.get("/api/me/mcp-links", headers=web).json()[0]["expires_at"] is None

    # still revocable and audited
    assert db_conn.execute("SELECT COUNT(*) FROM mcp_audit WHERE client_id LIKE 'link:%'").fetchone()[0] > 0
    client.delete(f"/api/me/mcp-links/{r.json()['id']}", headers=web)
    assert _rpc(client, path, "tools/list").status_code == 401


def test_regular_link_unchanged_by_unrestricted_feature(client, other_matter):
    path = _path(_make_link(client, _web(client)).json()["url"])
    _init(client, path)
    _, text = _call(client, path, "firm_list_matters")
    assert json.loads(text)["matters"] == []  # m-1 denied by policy, m-2 not a member


def test_link_answers_connector_probes(client, seeded):
    path = _path(_make_link(client, _web(client)).json()["url"])
    assert client.head(path).status_code == 200
    r = client.options(path)
    assert r.status_code == 204 and "POST" in r.headers["allow"]
    # real MCP traffic still goes through auth
    assert _rpc(client, "/mcp/k/aglx_lk_" + "x" * 43, "tools/list").status_code == 401


def test_probe_via_nginx_rewrite_shape(client, seeded):
    # nginx turns /mcp/k/<key> into /mcp + Authorization: Bearer <key>
    assert client.head("/mcp", headers={"Authorization": "Bearer aglx_lk_whatever"}).status_code == 200
    assert client.options("/mcp", headers={"Authorization": "Bearer x"}).status_code == 204
    # no credential: still 401 → OAuth discovery keeps working
    r = client.head("/mcp")
    assert r.status_code == 401


@pytest.fixture
def open_access(db_conn):
    from backend import mcp_dispatch
    from backend.oauth_store import sync_open_link
    mcp_dispatch.set_open_key(sync_open_link(db_conn, enabled=True, owner_email="alice@aglex.ua"))
    yield
    mcp_dispatch.set_open_key(sync_open_link(db_conn, enabled=False))


def test_open_access_plain_mcp_no_credential(client, seeded, db_conn, open_access):
    assert client.head("/mcp").status_code == 200
    _init(client, "/mcp")
    res, text = _call(client, "/mcp", "whoami")
    assert json.loads(text)["email"] == "alice@aglex.ua"
    # boot again → same row, fresh key; the previous key stops working
    from backend import mcp_dispatch
    from backend.oauth_store import OPEN_LINK_LABEL, sync_open_link
    old = mcp_dispatch._state["open_key"]
    mcp_dispatch.set_open_key(sync_open_link(db_conn, enabled=True, owner_email="alice@aglex.ua"))
    assert db_conn.execute("SELECT COUNT(*) FROM mcp_links WHERE label = ?", (OPEN_LINK_LABEL,)).fetchone()[0] == 1
    assert _rpc(client, "/mcp", "tools/list", headers={"Authorization": f"Bearer {old}"}).status_code == 401


def test_open_access_off_keeps_oauth(client, seeded, db_conn):
    from backend import mcp_dispatch
    from backend.oauth_store import sync_open_link
    mcp_dispatch.set_open_key(sync_open_link(db_conn, enabled=False))
    assert client.head("/mcp").status_code == 401


def test_open_access_retires_keyed_links(client, seeded, db_conn):
    from backend import mcp_dispatch
    from backend.oauth_store import sync_open_link
    web = _web(client)
    old_path = _path(_make_link(client, web).json()["url"])
    mcp_dispatch.set_open_key(sync_open_link(db_conn, enabled=True, owner_email="alice@aglex.ua"))
    try:
        assert client.get("/api/mcp/open-link", headers=web).json() == {
            "enabled": True, "url": "http://localhost:8000/mcp"}
        assert _rpc(client, old_path, "tools/list").status_code == 401  # revoked
        assert _make_link(client, web).status_code == 409
        assert client.get("/api/me/mcp-links", headers=web).json() == []  # open row hidden
    finally:
        mcp_dispatch.set_open_key(sync_open_link(db_conn, enabled=False))
    assert client.get("/api/mcp/open-link", headers=web).json()["enabled"] is False
    assert _make_link(client, web).status_code == 201
