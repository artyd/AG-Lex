"""MCP stage 2 tools (docs/mcp/DESIGN.md §4): safe writes, billing reads, AI.

- Writes reuse the REST handlers in `matters_routes` / `drafts`, so every
  change gets the same validation, `activity_log` entry and realtime
  broadcast as in the UI. Only additive writes: no delete, no billing edits.
- Billing tools are read-only and need scope `aglex.billing` + capability
  `billing`. Visibility: matters the user is a member of; `manage` sees all.
- AI tools spend the firm's Anthropic tokens: own documents only (unless
  `manage`), input ≤ 200k chars, own per-user budget in mcp_server (5/min,
  100/day); every call is in `mcp_audit`.
- Everything honours the privilege flag (`mcp_policy`, ai_external=deny).
- None of this is available to restricted (ChatGPT) clients: the kinds
  `write` / `billing` / `ai` are outside `RESTRICTED_ALLOWED_KINDS`.
"""
from __future__ import annotations

import json
import re
import sqlite3
from typing import Any, Callable
from urllib.parse import urlparse

from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.types import ToolAnnotations

from .cases_acl import list_member_ids
from .mcp_acl import POLICY_DENIED_MSG, Principal, check_matter_policy, is_matter_member, require
from .oauth_server import SCOPE_AI, SCOPE_BILLING, SCOPE_WRITE
from .oauth_store import denied_keys, denied_matter_ids, document_denied, norm_name

_WRITE = ToolAnnotations(read_only_hint=False, destructive_hint=False, idempotent_hint=False, open_world_hint=False)
_READ_ONLY = ToolAnnotations(read_only_hint=True, destructive_hint=False, open_world_hint=False)
_AI = ToolAnnotations(read_only_hint=True, destructive_hint=False, open_world_hint=True)

MAX_QUOTE_CHARS = 1500
MAX_COMMENT_CHARS = 500
MAX_NOTE_CHARS = 4000          # NoteCreate.max_length
MAX_DRAFT_CHARS = 200_000
MAX_AI_INPUT_CHARS = 200_000   # ~50k tokens; bigger contracts → split first
MAX_ROWS = 200
_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")

# Official legal sources a citation may point to (DESIGN.md §4): stops an
# injected instruction from pinning a phishing link as "the source".
CITATION_HOSTS = (
    "zakon.rada.gov.ua", "rada.gov.ua", "reyestr.court.gov.ua", "court.gov.ua",
    "supreme.court.gov.ua", "ccu.gov.ua", "eur-lex.europa.eu", "hudoc.echr.coe.int",
    "data.gov.ua", "minjust.gov.ua", "kmu.gov.ua",
)


def _ai_marker(p: Principal) -> str:
    """Visible origin marker: colleagues must see a note/task came via an AI app."""
    return f"🤖 [{p.client_name} · MCP]"


def _clamp(n: int, lo: int = 1, hi: int = MAX_ROWS) -> int:
    return max(lo, min(hi, int(n)))


def _writable_matter(conn: sqlite3.Connection, p: Principal, matter_id: str) -> None:
    require(p, scope=SCOPE_WRITE, capability="edit", kind="write")
    if not is_matter_member(conn, p, matter_id):
        raise ToolError("Matter not found or you are not a member of it.")
    check_matter_policy(conn, matter_id)


# ---------------------------------------------------------------------------
# writes
# ---------------------------------------------------------------------------

def create_task_impl(
    conn: sqlite3.Connection,
    p: Principal,
    matter_id: str,
    title: str,
    due: str = "",
    assignee: str = "me",
    priority: str = "med",
) -> dict:
    from .matters_routes import TaskCreate, add_task

    _writable_matter(conn, p, matter_id)
    who = p.text_id if assignee in ("", "me") else assignee
    if not p.unrestricted and who not in list_member_ids(conn, matter_id):
        raise ToolError("Assignee must be a member of the matter.")
    if priority not in ("low", "med", "high"):
        raise ToolError("priority must be low | med | high")
    if due and not _DATE.match(due):
        raise ToolError("due must be YYYY-MM-DD")
    body = TaskCreate(title=f"{_ai_marker(p)} {title.strip()}"[:400], assignee=who, due=due or None, priority=priority)
    return {"task": add_task(matter_id, body, user_text_id=p.text_id, conn=conn)}


def add_note_impl(conn: sqlite3.Connection, p: Principal, matter_id: str, text: str) -> dict:
    from .matters_routes import NoteCreate, add_note

    _writable_matter(conn, p, matter_id)
    body = f"{_ai_marker(p)}\n{text.strip()}"
    if len(body) > MAX_NOTE_CHARS:
        body = body[: MAX_NOTE_CHARS - 1] + "…"
    return {"note": add_note(matter_id, NoteCreate(text=body), user_text_id=p.text_id, conn=conn)}


def link_citation_impl(
    conn: sqlite3.Connection,
    p: Principal,
    matter_id: str,
    source_url: str,
    quote: str,
    comment: str = "",
) -> dict:
    """Pin a statute / court decision to the matter as a structured note."""
    url = source_url.strip()
    if _CONTROL.search(url) or len(url) > 500:
        raise ToolError("source_url must be a single-line URL.")
    u = urlparse(url)
    host = (u.hostname or "").lower()
    if u.scheme not in ("http", "https") or not any(host == h or host.endswith("." + h) for h in CITATION_HOSTS):
        raise ToolError("source_url must point to an official source: " + ", ".join(CITATION_HOSTS))
    comment = _CONTROL.sub(" ", comment).strip()[:MAX_COMMENT_CHARS]
    quote = quote.strip()
    if not quote:
        raise ToolError("quote is required")
    if len(quote) > MAX_QUOTE_CHARS:
        quote = quote[:MAX_QUOTE_CHARS] + "…"
    text = f"📎 Цитата: «{quote}»\nДжерело: {url}"
    if comment:
        text += f"\nКоментар: {comment}"
    return add_note_impl(conn, p, matter_id, text)


def create_draft_impl(
    conn: sqlite3.Connection,
    p: Principal,
    name: str,
    document_markdown: str,
    party: str = "",
) -> dict:
    from .drafts import DraftIn, create_draft

    require(p, scope=SCOPE_WRITE, capability="edit", kind="write")
    if len(document_markdown) > MAX_DRAFT_CHARS:
        raise ToolError(f"Draft too large (max {MAX_DRAFT_CHARS} characters).")
    body = DraftIn(
        typeId="mcp",
        name=f"{_ai_marker(p)} {name.strip()}"[:500],
        party=(party or "")[:300] or None,
        documentMarkdown=document_markdown,
    )
    return {"draft": create_draft(body, user=p.user, conn=conn)}


# ---------------------------------------------------------------------------
# billing (read-only)
# ---------------------------------------------------------------------------

def _billing_matter_codes(conn: sqlite3.Connection, p: Principal) -> list[str]:
    denied = denied_matter_ids(conn)
    if "manage" in p.capabilities:
        rows = conn.execute("SELECT id, code FROM matters").fetchall()
    else:
        rows = conn.execute(
            "SELECT m.id, m.code FROM matters m JOIN case_members cm ON cm.case_id = m.id WHERE cm.user_id = ?",
            (p.text_id,),
        ).fetchall()
    return [code for mid, code in rows if mid not in denied]


def _visible_client_names(conn: sqlite3.Connection, p: Principal) -> set[str]:
    """Normalised names of clients the principal may see billing for."""
    _, denied_clients = denied_keys(conn)
    if "manage" in p.capabilities:
        names = {norm_name(r[0]) for r in conn.execute("SELECT name FROM clients")}
        names |= {norm_name(r[0]) for r in conn.execute("SELECT DISTINCT client FROM invoices")}
        # A client whose every matter is closed is effectively confidential:
        # hide its identity and billing from managers too.
        denied_m = denied_matter_ids(conn)
        per_client: dict[str, list[bool]] = {}
        for mid, client in conn.execute("SELECT id, client FROM matters"):
            per_client.setdefault(norm_name(client), []).append(mid in denied_m)
        names -= {c for c, flags in per_client.items() if flags and all(flags)}
    else:
        # A matter-level deny must also hide that client's billing here —
        # otherwise the confidential client's identity leaks via invoices.
        denied_m = denied_matter_ids(conn)
        names = {
            norm_name(client)
            for mid, client in conn.execute(
                "SELECT m.id, m.client FROM matters m JOIN case_members cm ON cm.case_id = m.id "
                "WHERE cm.user_id = ?",
                (p.text_id,),
            )
            if mid not in denied_m
        }
    return {n for n in names if n} - denied_clients


def list_time_entries_impl(
    conn: sqlite3.Connection,
    p: Principal,
    matter_code: str = "",
    date_from: str = "",
    date_to: str = "",
    limit: int = 100,
) -> dict:
    require(p, scope=SCOPE_BILLING, capability="billing", kind="billing")
    codes = _billing_matter_codes(conn, p)
    if matter_code:
        codes = [c for c in codes if c == matter_code]
    if not codes:
        return {"time_entries": [], "total_hours": 0}
    # one JSON param instead of N placeholders (SQLite's 999-variable cap)
    sql = ("SELECT id, date, matter, who, descr, hours, rate, billable FROM time_entries "
           "WHERE matter IN (SELECT value FROM json_each(?))")
    args: list[Any] = [json.dumps(codes)]
    if date_from:
        sql += " AND date >= ?"
        args.append(date_from)
    if date_to:
        sql += " AND date <= ?"
        args.append(date_to)
    sql += " ORDER BY date DESC LIMIT ?"
    args.append(_clamp(limit))
    keys = ("id", "date", "matter_code", "who", "description", "hours", "rate", "billable")
    rows = [dict(zip(keys, r)) for r in conn.execute(sql, args).fetchall()]
    return {"time_entries": rows, "total_hours": round(sum(r["hours"] or 0 for r in rows), 2)}


def list_invoices_impl(conn: sqlite3.Connection, p: Principal, client: str = "", status: str = "") -> dict:
    # Invoices carry no matter link, so client-level visibility would expose
    # other matters' billing to any member: invoices are `manage`-only.
    require(p, scope=SCOPE_BILLING, capability="billing", kind="billing")
    require(p, scope=SCOPE_BILLING, capability="manage", kind="billing")
    names = _visible_client_names(conn, p)
    if client:
        names &= {norm_name(client)}
    sql = "SELECT id, num, client, period, amount, status FROM invoices"
    args: list[Any] = []
    if status:
        sql += " WHERE status = ?"
        args.append(status)
    keys = ("id", "number", "client", "period", "amount", "status")
    rows = [dict(zip(keys, r)) for r in conn.execute(sql, args).fetchall() if norm_name(r[2]) in names]
    return {"invoices": rows[:MAX_ROWS]}


def list_clients_impl(conn: sqlite3.Connection, p: Principal) -> dict:
    require(p, scope=SCOPE_BILLING, capability="billing", kind="clients")
    names = _visible_client_names(conn, p)
    rows = conn.execute("SELECT id, name, sector, contracts, open FROM clients").fetchall()
    keys = ("id", "name", "sector", "contracts", "open_matters")
    return {"clients": [dict(zip(keys, r)) for r in rows if norm_name(r[1]) in names]}


# ---------------------------------------------------------------------------
# AI
# ---------------------------------------------------------------------------

def _document_text(conn: sqlite3.Connection, p: Principal, document_id: str) -> str:
    """Text for a token-spending AI run: own uploads only (`manage`: any),
    never a document closed by policy, capped in size."""
    require(p, capability="pdata", kind="documents")
    row = conn.execute(
        "SELECT content, user_id, title, filename FROM documents WHERE id = ?", (document_id,)
    ).fetchone()
    not_found = ToolError(f"Document {document_id} not found or empty.")
    if row is None or not (row[0] or "").strip():
        raise not_found
    if row[1] != p.user["id"] and "manage" not in p.capabilities:
        raise not_found  # same message: don't confirm other people's documents exist
    if document_denied(conn, document_id, row[2], row[3]):
        raise ToolError(POLICY_DENIED_MSG)
    if len(row[0]) > MAX_AI_INPUT_CHARS:
        raise ToolError(f"Document too large for AI analysis via MCP (> {MAX_AI_INPUT_CHARS} characters).")
    return row[0]


def ai_analyze_contract_impl(conn: sqlite3.Connection, p: Principal, document_id: str) -> dict:
    from .contract_analysis import analyze_contract

    require(p, scope=SCOPE_AI, capability="ai", kind="ai")
    text = _document_text(conn, p, document_id)
    return {"document_id": document_id, "analysis": analyze_contract(text, conn=conn)}


def ai_reconcile_impl(
    conn: sqlite3.Connection, p: Principal, contract_document_id: str, handover_document_id: str
) -> dict:
    from .reconciliation import reconcile

    require(p, scope=SCOPE_AI, capability="ai", kind="ai")
    contract = _document_text(conn, p, contract_document_id)
    handover = _document_text(conn, p, handover_document_id)
    return {
        "contract_document_id": contract_document_id,
        "handover_document_id": handover_document_id,
        "reconciliation": reconcile(contract, handover),
    }


# ---------------------------------------------------------------------------
# registration
# ---------------------------------------------------------------------------

RunFn = Callable[[str, dict, Callable[..., dict]], dict]


def register_firm_tools(mcp: MCPServer, run: RunFn) -> None:
    @mcp.tool(annotations=_WRITE)
    def firm_create_task(
        matter_id: str, title: str, due: str = "", assignee: str = "me", priority: str = "med"
    ) -> dict:
        """Створити задачу у справі. due — YYYY-MM-DD; assignee — 'me' або id учасника справи;
        priority — low | med | high."""
        return run("firm_create_task", {"matter_id": matter_id, "title": title, "due": due},
                   lambda c, p: create_task_impl(c, p, matter_id, title, due, assignee, priority))

    @mcp.tool(annotations=_WRITE)
    def firm_add_note(matter_id: str, text: str) -> dict:
        """Додати нотатку до справи (видно всім учасникам справи)."""
        return run("firm_add_note", {"matter_id": matter_id, "text": text}, lambda c, p: add_note_impl(c, p, matter_id, text))

    @mcp.tool(annotations=_WRITE)
    def firm_link_citation(matter_id: str, source_url: str, quote: str, comment: str = "") -> dict:
        """Прикріпити до справи цитату з нормативного акта чи судового рішення
        з посиланням на офіційне джерело (zakon.rada.gov.ua, reyestr.court.gov.ua …)."""
        return run("firm_link_citation", {"matter_id": matter_id, "source_url": source_url, "quote": quote, "comment": comment},
                   lambda c, p: link_citation_impl(c, p, matter_id, source_url, quote, comment))

    @mcp.tool(annotations=_WRITE)
    def firm_create_draft(name: str, document_markdown: str, party: str = "") -> dict:
        """Зберегти чернетку документа (markdown) у «Мої чернетки» користувача."""
        return run("firm_create_draft", {"name": name, "document_markdown": document_markdown},
                   lambda c, p: create_draft_impl(c, p, name, document_markdown, party))

    @mcp.tool(annotations=_READ_ONLY)
    def firm_list_time_entries(matter_code: str = "", date_from: str = "", date_to: str = "", limit: int = 100) -> dict:
        """Облік часу по справах (потрібне право «білінг»). Дати — YYYY-MM-DD."""
        return run("firm_list_time_entries", {"matter_code": matter_code, "date_from": date_from, "date_to": date_to},
                   lambda c, p: list_time_entries_impl(c, p, matter_code, date_from, date_to, limit))

    @mcp.tool(annotations=_READ_ONLY)
    def firm_list_invoices(client: str = "", status: str = "") -> dict:
        """Рахунки клієнтам (права «білінг» і «керування»). status — draft | sent | paid."""
        return run("firm_list_invoices", {"client": client, "status": status},
                   lambda c, p: list_invoices_impl(c, p, client, status))

    @mcp.tool(annotations=_READ_ONLY)
    def firm_list_clients() -> dict:
        """Клієнти фірми, доступні користувачу (потрібне право «білінг»)."""
        return run("firm_list_clients", {}, list_clients_impl)

    @mcp.tool(annotations=_AI)
    def ai_analyze_contract(document_id: str) -> dict:
        """AI-аналіз договору (ризики, відсутні умови, правова база ЦКУ/ГКУ) для
        власного завантаженого документа. Витрачає токени фірми (ліміт 5/хв, 100/добу);
        може тривати до хвилини."""
        return run("ai_analyze_contract", {"document_id": document_id},
                   lambda c, p: ai_analyze_contract_impl(c, p, document_id))

    @mcp.tool(annotations=_AI)
    def ai_reconcile(contract_document_id: str, handover_document_id: str) -> dict:
        """AI-звірка договору з актом приймання-передачі (Таблиця 3). Витрачає токени фірми."""
        return run("ai_reconcile",
                   {"contract_document_id": contract_document_id, "handover_document_id": handover_document_id},
                   lambda c, p: ai_reconcile_impl(c, p, contract_document_id, handover_document_id))
