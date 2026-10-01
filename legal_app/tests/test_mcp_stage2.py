"""MCP stage 2 (docs/mcp/DESIGN.md §4): writes, billing, AI tools, privilege policy.

Reuses the OAuth + seeding helpers from test_mcp.py.
"""
from __future__ import annotations

import json

import pytest

from tests.test_mcp import (  # noqa: F401 — fixtures re-exported for pytest
    CHATGPT_REDIRECT,
    _call,
    _connect,
    _init,
    _rpc,
    client,
    db_conn,
    seeded,
)


@pytest.fixture
def more(seeded, db_conn):
    """Second matter (bob only) + billing rows + a second document."""
    db_conn.execute(
        "INSERT INTO matters (id, code, title, client, status) VALUES ('m-2', 'VEK-2', 'Спір з орендарем', 'ТД Вектор', 'active')"
    )
    db_conn.execute("INSERT INTO case_members (case_id, user_id, role_in_case, added_at) VALUES ('m-2', 'ub', 'lead', '2026-09-01')")
    db_conn.execute("INSERT INTO clients (id, name) VALUES ('c1', 'Acme'), ('c2', 'ТД Вектор')")
    db_conn.executemany(
        "INSERT INTO time_entries (id, date, matter, who, descr, hours, rate, billable) VALUES (?, ?, ?, ?, ?, ?, ?, 1)",
        [("te1", "2026-09-10", "SEV-1", "ua", "Позов", 2.5, 3000), ("te2", "2026-09-11", "VEK-2", "ub", "Лист", 1.0, 2000)],
    )
    db_conn.executemany(
        "INSERT INTO invoices (id, num, client, period, amount, status) VALUES (?, ?, ?, ?, ?, ?)",
        [("i1", "001", "Acme", "Вересень", 7500, "sent"), ("i2", "002", "ТД Вектор", "Вересень", 2000, "draft")],
    )
    db_conn.execute(
        "INSERT INTO documents (id, user_id, filename, title, format, content, word_count, created_at) "
        "VALUES ('d-2', ?, 'act.docx', 'Акт приймання', 'docx', 'Таблиця 3: зерно 100 т', 4, '2026-09-02')",
        (seeded["alice"],),
    )
    db_conn.commit()
    return seeded


def _alice(client):
    _, tok, _, _ = _connect(client)
    at = tok["access_token"]
    _init(client, at)
    return at


def _ok(client, at, name, args=None):
    result, text = _call(client, at, name, args)
    assert not result.get("isError"), text
    return json.loads(text)


def _err(client, at, name, args=None):
    result, text = _call(client, at, name, args)
    assert result.get("isError"), text
    return text


def _web(client, email="alice@aglex.ua"):
    r = client.post("/api/auth/login", json={"email": email, "password": "supersecret"})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


# ---------------------------------------------------------------------------
# writes
# ---------------------------------------------------------------------------

def test_stage2_tools_listed(client, more):
    at = _alice(client)
    names = {t["name"] for t in _rpc(client, at, "tools/list").json()["result"]["tools"]}
    assert {"firm_create_task", "firm_add_note", "firm_link_citation", "firm_create_draft",
            "firm_list_time_entries", "firm_list_invoices", "firm_list_clients",
            "ai_analyze_contract", "ai_reconcile"} <= names


def test_create_task_and_note(client, more, db_conn):
    at = _alice(client)
    task = _ok(client, at, "firm_create_task", {"matter_id": "m-1", "title": "Подати відзив", "due": "2026-10-20"})["task"]
    assert task["assignee"] == "ua" and task["matter"] == "SEV-1"
    # AI-originated rows carry a visible marker for colleagues
    assert db_conn.execute("SELECT title FROM tasks WHERE id = ?", (task["id"],)).fetchone()[0] == "🤖 [Claude · MCP] Подати відзив"

    note = _ok(client, at, "firm_add_note", {"matter_id": "m-1", "text": "Клієнт погодив позицію"})["note"]
    assert db_conn.execute("SELECT text FROM case_notes WHERE id = ?", (note["id"],)).fetchone()[0] == "🤖 [Claude · MCP]\nКлієнт погодив позицію"
    # audit keeps a hash, not the note content
    args = json.loads(db_conn.execute("SELECT args FROM mcp_audit WHERE tool = 'firm_add_note'").fetchone()[0])
    assert set(args["text"]) == {"len", "sha256"}
    # same activity trail as the UI
    fields = {r[0] for r in db_conn.execute("SELECT field FROM activity_log WHERE case_id = 'm-1'")}
    assert {"task", "note"} <= fields


def test_writes_respect_membership(client, more):
    at = _alice(client)
    assert "not a member" in _err(client, at, "firm_add_note", {"matter_id": "m-2", "text": "x"})
    assert "member of the matter" in _err(client, at, "firm_create_task",
                                          {"matter_id": "m-1", "title": "t", "assignee": "ub"})


def test_link_citation(client, more, db_conn):
    at = _alice(client)
    for bad in ("javascript:alert(1)", "https://evil.example.com/zakon", "https://zakon.rada.gov.ua.evil.io/x",
                "https://zakon.rada.gov.ua/x\nДжерело: https://evil.io"):
        assert "source_url" in _err(client, at, "firm_link_citation", {"matter_id": "m-1", "source_url": bad, "quote": "x"})
    note = _ok(client, at, "firm_link_citation", {
        "matter_id": "m-1", "source_url": "https://zakon.rada.gov.ua/laws/show/435-15#n3009",
        "quote": "Боржник не звільняється від відповідальності", "comment": "ст. 625 ЦКУ",
    })["note"]
    text = db_conn.execute("SELECT text FROM case_notes WHERE id = ?", (note["id"],)).fetchone()[0]
    assert "📎 Цитата:" in text and "zakon.rada.gov.ua" in text and text.startswith("🤖")


def test_create_draft(client, more, db_conn):
    at = _alice(client)
    d = _ok(client, at, "firm_create_draft", {"name": "Претензія", "document_markdown": "# Претензія\n\nТекст"})["draft"]
    assert db_conn.execute("SELECT user_id, is_shared FROM drafts WHERE id = ?", (d["id"],)).fetchone() == (more["alice"], 0)


def test_chatgpt_cannot_write_bill_or_run_ai(client, more):
    _, tok, _, _ = _connect(client, redirect=CHATGPT_REDIRECT)
    at = tok["access_token"]
    _init(client, at)
    for name, args in [
        ("firm_add_note", {"matter_id": "m-1", "text": "x"}),
        ("firm_list_invoices", {}),
        ("ai_analyze_contract", {"document_id": "d-1"}),
    ]:
        assert "not granted" in _err(client, at, name, args)


# ---------------------------------------------------------------------------
# billing
# ---------------------------------------------------------------------------

def test_billing_partner_with_manage_sees_all(client, more):
    at = _alice(client)
    te = _ok(client, at, "firm_list_time_entries")
    assert {r["id"] for r in te["time_entries"]} == {"te1", "te2"}
    assert {i["id"] for i in _ok(client, at, "firm_list_invoices")["invoices"]} == {"i1", "i2"}
    assert {c["name"] for c in _ok(client, at, "firm_list_clients")["clients"]} == {"Acme", "ТД Вектор"}


def test_billing_requires_capability(client, more, db_conn):
    _, tok, _, _ = _connect(client, email="bob@aglex.ua")  # lawyer: no `billing` by default
    at = tok["access_token"]
    _init(client, at)
    assert "billing" in _err(client, at, "firm_list_invoices")


def test_billing_without_manage_is_member_scoped(client, more, db_conn):
    db_conn.execute("UPDATE permissions SET allowed = 1 WHERE role = 'lawyer' AND capability = 'billing'")
    db_conn.commit()
    _, tok, _, _ = _connect(client, email="bob@aglex.ua")
    at = tok["access_token"]
    _init(client, at)
    assert {r["id"] for r in _ok(client, at, "firm_list_time_entries")["time_entries"]} == {"te2"}
    # invoices have no matter link → manage-only
    assert "manage" in _err(client, at, "firm_list_invoices")
    assert {c["name"] for c in _ok(client, at, "firm_list_clients")["clients"]} == {"ТД Вектор"}
    # a matter-level deny also hides that client's billing for non-managers
    db_conn.execute("INSERT INTO mcp_policy (kind, key, set_at) VALUES ('matter', 'm-2', 'now')")
    db_conn.commit()
    assert _ok(client, at, "firm_list_clients")["clients"] == []
    assert _ok(client, at, "firm_list_time_entries")["time_entries"] == []


# ---------------------------------------------------------------------------
# AI (mock mode)
# ---------------------------------------------------------------------------

def test_ai_tools_mock(client, more, monkeypatch):
    monkeypatch.setenv("AGLEX_MOCK_AI", "1")
    at = _alice(client)
    out = _ok(client, at, "ai_analyze_contract", {"document_id": "d-1"})
    assert out["document_id"] == "d-1" and out["analysis"]
    out = _ok(client, at, "ai_reconcile", {"contract_document_id": "d-1", "handover_document_id": "d-2"})
    assert out["reconciliation"]
    assert "not found" in _err(client, at, "ai_analyze_contract", {"document_id": "nope"})


# ---------------------------------------------------------------------------
# privilege policy (ai_external=deny)
# ---------------------------------------------------------------------------

def test_policy_endpoints_require_manage(client, more):
    bob = _web(client, "bob@aglex.ua")
    assert client.get("/api/mcp/policy", headers=bob).status_code == 403
    assert client.put("/api/mcp/policy", headers=bob, json={"kind": "matter", "key": "m-1", "deny": True}).status_code == 403


def test_matter_policy_hides_everything(client, more, db_conn):
    at = _alice(client)
    web = _web(client)
    r = client.put("/api/mcp/policy", headers=web, json={"kind": "matter", "key": "m-1", "deny": True})
    assert r.status_code == 200
    assert db_conn.execute("SELECT COUNT(*) FROM audit WHERE action = 'mcp_policy'").fetchone()[0] == 1

    out = _ok(client, at, "firm_list_matters")
    assert out["matters"] == [] and out["hidden_by_policy"] == 1
    assert "політикою фірми" in _err(client, at, "firm_get_matter", {"matter_id": "m-1"})
    assert "політикою фірми" in _err(client, at, "fetch", {"id": "matter:m-1"})
    assert _ok(client, at, "firm_list_tasks")["tasks"] == []
    assert _ok(client, at, "firm_calendar")["events"] == []
    assert "політикою фірми" in _err(client, at, "firm_add_note", {"matter_id": "m-1", "text": "x"})
    assert "te1" not in {r["id"] for r in _ok(client, at, "firm_list_time_entries")["time_entries"]}

    pol = client.get("/api/mcp/policy", headers=web).json()
    assert next(m for m in pol["matters"] if m["id"] == "m-1")["denied"] is True

    client.put("/api/mcp/policy", headers=web, json={"kind": "matter", "key": "m-1", "deny": False})
    assert [m["id"] for m in _ok(client, at, "firm_list_matters")["matters"]] == ["m-1"]


def test_client_policy_covers_matters_and_billing(client, more):
    at = _alice(client)
    web = _web(client)
    client.put("/api/mcp/policy", headers=web, json={"kind": "client", "key": "Acme", "deny": True})
    assert _ok(client, at, "firm_list_matters")["matters"] == []
    assert {i["id"] for i in _ok(client, at, "firm_list_invoices")["invoices"]} == {"i2"}
    assert "Acme" not in {c["name"] for c in _ok(client, at, "firm_list_clients")["clients"]}
    pol = client.get("/api/mcp/policy", headers=web).json()
    assert next(m for m in pol["matters"] if m["id"] == "m-1")["deniedViaClient"] is True


def test_policy_unknown_matter_404(client, more):
    r = client.put("/api/mcp/policy", headers=_web(client), json={"kind": "matter", "key": "nope", "deny": True})
    assert r.status_code == 404


# ---------------------------------------------------------------------------
# review round: documents policy, AI guards, normalisation, validation
# ---------------------------------------------------------------------------

def test_documents_policy(client, more, db_conn):
    at = _alice(client)
    web = _web(client)
    assert _ok(client, at, "firm_get_document", {"document_id": "d-1"})
    # per-document flag
    assert client.put("/api/mcp/policy", headers=web, json={"kind": "document", "key": "d-1", "deny": True}).status_code == 200
    assert "політикою фірми" in _err(client, at, "firm_get_document", {"document_id": "d-1"})
    assert "d-1" not in {d["id"] for d in _ok(client, at, "firm_search_documents", {"query": "зерн"})["documents"]}
    client.put("/api/mcp/policy", headers=web, json={"kind": "document", "key": "d-1", "deny": False})
    # denied client's name in the title (best effort: documents have no client link)
    db_conn.execute("UPDATE documents SET title = 'Договір з ТД «Вектор»' WHERE id = 'd-2'")
    db_conn.commit()
    client.put("/api/mcp/policy", headers=web, json={"kind": "client", "key": "ТД Вектор", "deny": True})
    assert "політикою фірми" in _err(client, at, "firm_get_document", {"document_id": "d-2"})
    # firm-wide switch
    client.put("/api/mcp/policy", headers=web, json={"kind": "global", "key": "documents", "deny": True})
    assert client.get("/api/mcp/policy", headers=web).json()["documentsDenied"] is True
    assert "політикою фірми" in _err(client, at, "firm_search_documents", {"query": "зерн"})
    assert "політикою фірми" in _err(client, at, "firm_get_document", {"document_id": "d-1"})
    assert not any(r["id"].startswith("doc:") for r in _ok(client, at, "search", {"query": "зерн"})["results"])


def test_ai_tools_guarded(client, more, db_conn, monkeypatch):
    monkeypatch.setenv("AGLEX_MOCK_AI", "1")
    import backend.mcp_server as ms
    monkeypatch.setattr(ms, "AI_LIMIT_PER_MIN", 2)
    # bob (lawyer, no manage) can't run AI on alice's document; same message as missing
    db_conn.execute("UPDATE permissions SET allowed = 1 WHERE role = 'lawyer' AND capability IN ('ai', 'pdata')")
    db_conn.commit()
    _, tok, _, _ = _connect(client, email="bob@aglex.ua")
    bob = tok["access_token"]
    _init(client, bob)
    assert "not found" in _err(client, bob, "ai_analyze_contract", {"document_id": "d-1"})
    # alice: size cap, then per-minute AI budget
    at = _alice(client)
    db_conn.execute("UPDATE documents SET content = ? WHERE id = 'd-2'", ("x" * 200_001,))
    db_conn.commit()
    assert "too large" in _err(client, at, "ai_analyze_contract", {"document_id": "d-2"})
    _ok(client, at, "ai_analyze_contract", {"document_id": "d-1"})
    assert "AI budget" in _err(client, at, "ai_analyze_contract", {"document_id": "d-1"})


def test_client_policy_is_spelling_insensitive(client, more):
    at = _alice(client)
    web = _web(client)
    r = client.put("/api/mcp/policy", headers=web, json={"kind": "client", "key": "  тд   вектор ", "deny": True})
    assert r.status_code == 200
    assert "ТД Вектор" not in {c["name"] for c in _ok(client, at, "firm_list_clients")["clients"]}
    assert "i2" not in {i["id"] for i in _ok(client, at, "firm_list_invoices")["invoices"]}
    # un-deny through yet another spelling reaches the stored row
    client.put("/api/mcp/policy", headers=web, json={"kind": "client", "key": "ТД ВЕКТОР", "deny": False})
    assert "i2" in {i["id"] for i in _ok(client, at, "firm_list_invoices")["invoices"]}


def test_policy_unknown_client_and_stale(client, more, db_conn):
    web = _web(client)
    assert client.put("/api/mcp/policy", headers=web, json={"kind": "client", "key": "Нема Такого", "deny": True}).status_code == 404
    client.put("/api/mcp/policy", headers=web, json={"kind": "client", "key": "Acme", "deny": True})
    db_conn.execute("UPDATE clients SET name = 'Acme Holdings' WHERE id = 'c1'")
    db_conn.execute("UPDATE matters SET client = 'Acme Holdings' WHERE id = 'm-1'")
    db_conn.execute("UPDATE invoices SET client = 'Acme Holdings' WHERE id = 'i1'")
    db_conn.commit()
    assert client.get("/api/mcp/policy", headers=web).json()["staleClients"] == ["Acme"]


def test_policy_noop_not_audited(client, more, db_conn):
    web = _web(client)
    for _ in range(3):
        client.put("/api/mcp/policy", headers=web, json={"kind": "matter", "key": "m-1", "deny": True})
    assert db_conn.execute("SELECT COUNT(*) FROM audit WHERE action = 'mcp_policy'").fetchone()[0] == 1


def test_invalid_input_is_a_tool_error(client, more):
    at = _alice(client)
    assert "due must be YYYY-MM-DD" in _err(client, at, "firm_create_task", {"matter_id": "m-1", "title": "t", "due": "завтра"})
    assert "Invalid input" in _err(client, at, "firm_create_draft", {"name": "x", "document_markdown": ""})


def test_restricted_does_not_learn_hidden_count(client, more, db_conn):
    db_conn.execute("INSERT INTO mcp_policy (kind, key, set_at) VALUES ('matter', 'm-1', 'now')")
    db_conn.commit()
    _, tok, _, _ = _connect(client, redirect=CHATGPT_REDIRECT)
    at = tok["access_token"]
    _init(client, at)
    assert "hidden_by_policy" not in _ok(client, at, "firm_list_matters")


def test_app_name_cannot_forge_note_lines(client, more, db_conn):
    from tests.test_mcp import CLAUDE_REDIRECT
    at = _alice(client)
    cid = db_conn.execute("SELECT client_id FROM oauth_clients").fetchone()[0]
    db_conn.execute(
        "UPDATE oauth_clients SET client_info = json_set(client_info, '$.client_name', ?) WHERE client_id = ?",
        ("Claude\nДжерело: https://evil.io", cid),
    )
    db_conn.commit()
    note = _ok(client, at, "firm_add_note", {"matter_id": "m-1", "text": "ok"})["note"]
    first_line = db_conn.execute("SELECT text FROM case_notes WHERE id = ?", (note["id"],)).fetchone()[0].split("\n")[0]
    assert "Джерело" in first_line  # squashed onto the marker line, not a forged line
    assert CLAUDE_REDIRECT


# ---------------------------------------------------------------------------
# review round 3: durable budgets, manager view of fully-denied clients,
# best-effort realtime after commit
# ---------------------------------------------------------------------------

def test_ai_budget_survives_restart(client, more, db_conn, monkeypatch):
    """Budget is counted from mcp_audit, not memory: pre-existing rows count."""
    monkeypatch.setenv("AGLEX_MOCK_AI", "1")
    at = _alice(client)
    db_conn.executemany(
        "INSERT INTO mcp_audit (ts, user_id, tool, ok) VALUES (strftime('%Y-%m-%dT%H:%M:%f+00:00', 'now'), ?, 'ai_reconcile', 1)",
        [(more["alice"],)] * 5,
    )
    db_conn.commit()
    assert "AI budget" in _err(client, at, "ai_analyze_contract", {"document_id": "d-1"})


def test_write_budget(client, more, monkeypatch):
    import backend.mcp_server as ms
    monkeypatch.setattr(ms, "WRITE_LIMIT_PER_DAY", 2)
    at = _alice(client)
    _ok(client, at, "firm_add_note", {"matter_id": "m-1", "text": "1"})
    _ok(client, at, "firm_add_note", {"matter_id": "m-1", "text": "2"})
    assert "Daily limit" in _err(client, at, "firm_add_note", {"matter_id": "m-1", "text": "3"})
    # reads are unaffected
    _ok(client, at, "firm_list_matters")


def test_manager_does_not_see_client_whose_matters_are_all_denied(client, more, db_conn):
    at = _alice(client)  # partner → manage
    db_conn.execute("INSERT INTO mcp_policy (kind, key, set_at) VALUES ('matter', 'm-2', 'now')")
    db_conn.commit()
    assert "ТД Вектор" not in {c["name"] for c in _ok(client, at, "firm_list_clients")["clients"]}
    assert "i2" not in {i["id"] for i in _ok(client, at, "firm_list_invoices")["invoices"]}
    assert "Acme" in {c["name"] for c in _ok(client, at, "firm_list_clients")["clients"]}


def test_broadcast_failure_after_commit_is_not_an_error(client, more, db_conn, monkeypatch):
    import backend.realtime as rt

    def boom(*a, **k):
        raise RuntimeError("fan-out down")
    monkeypatch.setattr(rt, "list_member_ids", boom)
    at = _alice(client)
    note = _ok(client, at, "firm_add_note", {"matter_id": "m-1", "text": "saved once"})["note"]
    assert db_conn.execute("SELECT COUNT(*) FROM case_notes WHERE id = ?", (note["id"],)).fetchone()[0] == 1
