"""AG Lex FastAPI app — single-origin: serves /api/* JSON and the Vite build at /.

API routes are all defined above the SPA static mount so they win the route
match against `/{full_path:path}`.
"""
import os
import tempfile
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional, Union

from fastapi import Depends, FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import assist as assist_module
from . import auth as auth_module
from . import builder as builder_module
from . import calendar_routes as calendar_module
from . import drafts as drafts_module
from . import matters_routes as matters_module
from . import notifications_routes as notifications_module
from . import team as team_module
from .audit import init_audit_schema
from .auth import current_user
from .claude_client import ClaudeError
from .codex import get_codex_stats
from .config import get_settings
from .contract_analysis import analyze_contract
from .crud import ALL_ENTITIES, CONTRACTS, RECONCILIATIONS, build_router, insert_row
from .database import get_connection, get_db, init_schema, init_user_schema
from .documents import (
    DisplayPdfError,
    detect_type_and_convert,
    detect_type_and_convert_html,
    detect_type_and_extract_raw,
    split_into_sections,
    to_display_pdf,
    token_savings,
)
from .models import (
    init_entity_schema,
    migrate_contracts_display_pdf,
    migrate_drafts,
    migrate_matters,
    migrate_reconciliations,
    migrate_reconciliations_display_pdf,
    migrate_users,
)
from .pipeline import analyze
from .rbac import (
    init_permissions_schema,
    require,
    seed_default_permissions,
)
from . import reconciliation as reconciliation_module
import datetime
import sqlite3
import uuid

settings = get_settings()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Bring schemas up to date and seed the demo data on boot.

    Idempotent: all DDL is `CREATE IF NOT EXISTS`, `seed_test_user` no-ops
    when the row already exists, and `seed_all` uses INSERT OR IGNORE. Safe to
    run on every restart.
    """
    from scripts.seed_demo import seed_all  # avoid circular import at module load
    # Phase 2.4: capture the main event loop so sync REST handlers running
    # in the threadpool can still schedule realtime broadcasts via
    # `run_coroutine_threadsafe`. Without this the broadcast would silently
    # no-op every time it fires from a sync handler.
    import asyncio as _asyncio
    from .realtime import set_main_loop
    set_main_loop(_asyncio.get_running_loop())

    conn = get_connection()
    try:
        init_schema(conn)             # articles + FTS5 (Phases 1.1/1.2)
        init_user_schema(conn)        # users (Phase 2.1)
        init_entity_schema(conn)      # workspace entities (Phase 2.2)
        init_permissions_schema(conn) # permissions matrix (Phase 2.3)
        init_audit_schema(conn)       # audit log (Phase 2.3)
        migrate_drafts(conn)
        migrate_users(conn)
        migrate_matters(conn)
        migrate_reconciliations(conn)
        migrate_reconciliations_display_pdf(conn)
        migrate_contracts_display_pdf(conn)
        auth_module.seed_test_user(conn)
        seed_default_permissions(conn)
        seed_all(conn)
    finally:
        conn.close()
    yield


app = FastAPI(title="AG Lex", version="0.1.0", lifespan=lifespan)
app.include_router(auth_module.router)
app.include_router(team_module.router)
app.include_router(assist_module.router)
app.include_router(builder_module.router)
app.include_router(drafts_module.router)  # Fix 1: custom router replaces generic CRUD
# Phase 2.4: custom routers for /api/matters, /api/notifications, /api/calendar.
# The matters router enforces row-level access via case_members; the generic
# CRUD loop below skips MATTERS so the two don't shadow each other.
app.include_router(matters_module.router)
app.include_router(notifications_module.router)
app.include_router(calendar_module.router)

# Phase 4.x: custom POST /api/contracts that accepts a base64-encoded display
# PDF (`displayPdfB64`) and writes it to the BLOB column. Registered BEFORE
# the generic ALL_ENTITIES loop so this handler wins the POST route match;
# the loop's GET/PATCH/DELETE handlers for /api/contracts still apply.
class _ContractCreatePayload(BaseModel):
    filename: Optional[str] = None
    title: Optional[str] = None
    counterparty: Optional[str] = None
    risk: Optional[str] = None
    score: Optional[int] = 0
    findingsCount: Optional[int] = 0
    analysis: Optional[dict] = None
    createdAt: Optional[str] = None
    displayPdfB64: Optional[str] = None


@app.post(
    "/api/contracts",
    status_code=201,
    dependencies=[Depends(current_user)],
    tags=["contracts"],
)
def create_contract_with_pdf(
    body: _ContractCreatePayload,
    conn: sqlite3.Connection = Depends(get_db),
) -> dict:
    data = body.model_dump(exclude={"displayPdfB64"}, exclude_none=True)
    if not data.get("createdAt"):
        data["createdAt"] = (
            datetime.datetime.utcnow().isoformat(timespec="seconds") + "Z"
        )
    inserted = insert_row(conn, CONTRACTS, data)
    if body.displayPdfB64:
        import base64 as _b64
        import sys as _sys
        try:
            pdf_bytes = _b64.b64decode(body.displayPdfB64, validate=True)
            if pdf_bytes.startswith(b"%PDF-"):
                conn.execute(
                    "UPDATE contracts SET display_pdf = ? WHERE id = ?",
                    (pdf_bytes, inserted["id"]),
                )
                conn.commit()
            else:
                print(
                    f"[contracts] {inserted['id']}: displayPdfB64 decoded but "
                    f"not a valid PDF (starts {pdf_bytes[:8]!r})",
                    file=_sys.stderr, flush=True,
                )
        except Exception as e:
            print(
                f"[contracts] {inserted['id']}: displayPdfB64 decode failed: {e}",
                file=_sys.stderr, flush=True,
            )
    return inserted


# Phase 2.2: mount /api/<entity> for every workspace table. All are gated by
# `current_user` inside `build_router`. Phase 2.3: invoices reads/writes
# require the `billing` capability per spec §5.2.
for _entity in ALL_ENTITIES:
    if _entity.table == "matters":
        # Replaced by matters_module.router above — skip to avoid conflict.
        continue
    if _entity.table == "invoices":
        app.include_router(build_router(
            _entity, read_capability="billing", write_capability="billing",
        ))
    else:
        app.include_router(build_router(_entity))

# 25 MB cap on uploaded contracts — large enough for typical PDFs, small enough
# to keep a careless mis-upload from filling /tmp.
MAX_UPLOAD_BYTES = 25 * 1024 * 1024
SUPPORTED_EXTS = {".pdf", ".docx"}
# Reconciliation accepts the contract in .pdf/.docx and the handover in
# .pdf/.docx/.xlsx (procurement often hands over Table 3 as Excel).
RECONCILE_CONTRACT_EXTS = {".pdf", ".docx"}
RECONCILE_HANDOVER_EXTS = {".pdf", ".docx", ".xlsx"}


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


# ---------------------------------------------------------------------------
# Phase 2.4: realtime WebSocket. Browsers can't set Authorization headers on
# `new WebSocket()`, so the token comes in via the query string. Validates
# the JWT, resolves the TEXT user id, registers the socket with the singleton
# ConnectionManager, and runs a small receive loop responding to client
# pings to keep proxies happy. Disconnect tears down the registration.
# ---------------------------------------------------------------------------

from fastapi import Query, WebSocket, WebSocketDisconnect
from jose import JWTError
import sqlite3 as _sqlite3
from .auth import decode_token
from .cases_acl import resolve_user_text_id
from .database import get_db
from .realtime import manager as ws_manager


@app.websocket("/ws")
async def realtime_endpoint(
    websocket: WebSocket,
    token: str = Query(..., description="JWT access token from /api/auth/login."),
    conn: _sqlite3.Connection = Depends(get_db),
) -> None:
    # 1. Validate the JWT before accepting the socket.
    try:
        payload = decode_token(token)
        user_id = int(payload["sub"])
    except (JWTError, KeyError, TypeError, ValueError):
        # 1008 = "policy violation" — what browsers see for "401 over WS".
        await websocket.close(code=1008)
        return

    # 2. Resolve to the prototype TEXT id using the same connection the
    # rest of the app shares (the dependency override in tests swaps it
    # for an in-memory DB; production passes through to get_connection).
    try:
        user_text_id = resolve_user_text_id(conn, user_id)
    except Exception:
        await websocket.close(code=1011)
        return

    await websocket.accept()
    await ws_manager.connect(user_text_id, websocket)
    try:
        # Keep the socket alive; respond to client pings, ignore everything
        # else. The server is the publisher — broadcasts come from REST
        # handlers, not from client messages.
        while True:
            msg = await websocket.receive_json()
            if isinstance(msg, dict) and msg.get("type") == "ping":
                await websocket.send_json({"type": "pong"})
    except WebSocketDisconnect:
        pass
    finally:
        await ws_manager.disconnect(user_text_id, websocket)


@app.post("/api/upload", dependencies=[Depends(current_user)])
async def upload_document(file: UploadFile = File(...)):
    """Ingest a contract: PDF or DOCX → Markdown + sections + token stats.

    Pre-deploy audit: gated by `current_user` so anonymous callers can't burn
    server CPU on PDF/DOCX conversion. No specific capability required —
    uploading itself is read-flavored and grants no AI/billing access.
    """
    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in SUPPORTED_EXTS:
        raise HTTPException(
            status_code=415,
            detail=f"Unsupported file type {suffix!r}. Supported: {sorted(SUPPORTED_EXTS)}",
        )

    raw_bytes = await file.read()
    if not raw_bytes:
        raise HTTPException(status_code=400, detail="Empty upload.")
    if len(raw_bytes) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"File exceeds {MAX_UPLOAD_BYTES // (1024 * 1024)} MB limit.",
        )

    # Persist to a temp file: pymupdf4llm and mammoth both want a path/file
    # handle, not raw bytes. `mkstemp` is the cross-platform pattern that
    # avoids the Windows file-locking quirk of NamedTemporaryFile(delete=False).
    fd, tmp_str = tempfile.mkstemp(suffix=suffix, prefix="aglex_upload_")
    os.close(fd)
    tmp_path = Path(tmp_str)

    try:
        tmp_path.write_bytes(raw_bytes)
        raw_text = detect_type_and_extract_raw(tmp_path)
        markdown = detect_type_and_convert(tmp_path)
        sections = split_into_sections(markdown)
        stats = token_savings(raw_text, markdown)

        if not markdown.strip():
            # Likely a scanned PDF (no embedded text layer). Phase 1.3 explicitly
            # leaves OCR for later; surface a clear hint instead of an empty 200.
            raise HTTPException(
                status_code=422,
                detail="No text extracted. The file may be a scan with no text layer (OCR not yet supported).",
            )

        # Phase 4.x: also render the display PDF and ship it base64-encoded
        # in the response. The FE round-trips the same bytes to POST
        # /api/contracts when persisting so the BLOB lands without another
        # upload. Best-effort: missing soffice doesn't block analysis.
        import base64 as _b64
        from .mock_ai import mock_display_pdf_bytes as _mock_pdf
        display_pdf_b64: str | None = None
        display_pdf_bytes: bytes | None = None
        mock_bytes = _mock_pdf()
        if mock_bytes is not None:
            display_pdf_bytes = mock_bytes
        else:
            try:
                display_pdf_bytes = to_display_pdf(tmp_path)
            except (DisplayPdfError, ValueError) as e:
                import sys as _sys
                print(
                    f"[upload] display-PDF failed for {file.filename!r}: "
                    f"{getattr(e, 'kind', 'error')} — {e}",
                    file=_sys.stderr,
                    flush=True,
                )
                display_pdf_bytes = None
        if display_pdf_bytes is not None:
            display_pdf_b64 = _b64.b64encode(display_pdf_bytes).decode("ascii")

        return {
            "filename": file.filename,
            "markdown": markdown,
            "sections": sections,
            "token_stats": stats,
            "display_pdf_b64": display_pdf_b64,
        }
    finally:
        tmp_path.unlink(missing_ok=True)


class AnalyzeRequest(BaseModel):
    # max_length caps protect against DoS via huge prompts (token bill + memory).
    question: str = Field(..., min_length=1, max_length=8000, description="Lawyer's question (UA preferred).")
    contract_section: Optional[dict] = Field(
        default=None,
        description="Optional contract section from /api/upload: {number, title, text}.",
    )
    sources: Optional[Union[str, list[str]]] = Field(
        default=None,
        description='Codex filter: None=all, "ЦКУ", or ["ЦКУ","ГКУ"].',
    )


@app.get("/api/codex/stats", dependencies=[Depends(require("view"))])
def codex_stats(conn: sqlite3.Connection = Depends(get_db)) -> dict:
    """Fix 3: codex inventory + health probe.

    Used by `scripts/check_codex.py` and by ops to confirm the RAG corpus is
    loaded. Any authenticated user with the `view` capability can hit it —
    that's everyone in the default permissions matrix.
    """
    return get_codex_stats(conn)


@app.post("/api/analyze", dependencies=[Depends(require("ai"))])
def analyze_endpoint(req: AnalyzeRequest):
    """RAG turn: search codex → ask Claude → validate citations.

    Phase 2.3: gated by `ai` capability — controls who can burn Claude tokens.
    """
    try:
        return analyze(
            question=req.question,
            contract_section=req.contract_section,
            sources=req.sources,
        )
    except ClaudeError as e:
        # Auth, rate-limit-after-retries, network, upstream 5xx — all surface here.
        raise HTTPException(status_code=502, detail=str(e))


class ContractAnalysisRequest(BaseModel):
    # 200k chars ≈ ~50k tokens — generous for a long contract, hard cap on
    # adversarial multi-MB payloads.
    markdown: Optional[str] = Field(
        default=None,
        max_length=200_000,
        description="Full contract markdown (e.g. from POST /api/upload).",
    )
    sections: Optional[list[dict]] = Field(
        default=None,
        max_length=500,
        description="Optional pre-split sections (output of /api/upload). "
                    "Used to build the contract text when `markdown` is omitted.",
    )


def _sections_to_text(sections: list[dict]) -> str:
    """Re-join Phase 1.3 sections into a markdown-like document for Claude."""
    parts = []
    for s in sections:
        head_bits = [s.get("number") or "", s.get("title") or ""]
        head = " ".join(b for b in head_bits if b).strip()
        body = (s.get("text") or "").strip()
        if head:
            parts.append(f"## {head}\n\n{body}" if body else f"## {head}")
        else:
            parts.append(body)
    return "\n\n".join(p for p in parts if p)


@app.post("/api/analyze/contract", dependencies=[Depends(require("ai"))])
def analyze_contract_endpoint(
    req: ContractAnalysisRequest,
    conn: sqlite3.Connection = Depends(get_db),
):
    """Phase 3.1: full per-contract analysis → findings/comparison/legal_basis/score.

    Accepts either `markdown` or `sections`. Gated by the `ai` capability.
    """
    text = req.markdown
    if not text and req.sections:
        text = _sections_to_text(req.sections)
    if not text or not text.strip():
        raise HTTPException(status_code=400, detail="Provide `markdown` or non-empty `sections`.")

    try:
        return analyze_contract(text, conn=conn)
    except ClaudeError as e:
        raise HTTPException(status_code=502, detail=str(e))


async def _ingest_upload(
    file: UploadFile, allowed: set[str], role: str,
) -> tuple[str, str, bytes | None, str]:
    """Reusable: validate + persist to a temp file + convert to MD, HTML, PDF.

    Returns (markdown, html, display_pdf_bytes, original_filename). Markdown
    feeds Claude; HTML is the source-side fallback; the display PDF is what
    the FE renders pixel-perfect via PDF.js. The PDF is best-effort: when
    soffice is missing or crashes we log and return None so analysis still
    proceeds — the FE shows a "preview unavailable" banner.

    Raises HTTPException on any validation failure of the input file. The
    temp file is deleted before returning.
    """
    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in allowed:
        raise HTTPException(
            status_code=415,
            detail=f"Unsupported {role} file {suffix!r}. Supported: {sorted(allowed)}",
        )
    raw_bytes = await file.read()
    if not raw_bytes:
        raise HTTPException(status_code=400, detail=f"Empty {role} upload.")
    if len(raw_bytes) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"{role.title()} file exceeds {MAX_UPLOAD_BYTES // (1024 * 1024)} MB limit.",
        )
    fd, tmp_str = tempfile.mkstemp(suffix=suffix, prefix=f"aglex_{role}_")
    os.close(fd)
    tmp_path = Path(tmp_str)
    try:
        tmp_path.write_bytes(raw_bytes)
        try:
            markdown = detect_type_and_convert(tmp_path)
        except Exception as e:
            raise HTTPException(
                status_code=422,
                detail=f"Could not parse {role} file: {e}",
            ) from e
        if not markdown.strip():
            raise HTTPException(
                status_code=422,
                detail=f"No text extracted from {role} file (possibly a scan without OCR).",
            )
        # HTML is best-effort — if the format doesn't have a converter or one
        # blows up, we still return the markdown and the FE falls back to it.
        try:
            html = detect_type_and_convert_html(tmp_path)
        except Exception:
            html = ""
        # Display PDF is also best-effort: missing soffice or a crash
        # should not block analysis — the FE just shows a banner.
        display_pdf: bytes | None = None
        # Mock-mode short-circuit so e2e never reaches soffice — keeps the
        # test hermetic on hosts where LibreOffice isn't installed.
        from .mock_ai import mock_display_pdf_bytes as _mock_pdf
        mock_bytes = _mock_pdf()
        if mock_bytes is not None:
            display_pdf = mock_bytes
        else:
            try:
                display_pdf = to_display_pdf(tmp_path)
            except (DisplayPdfError, ValueError) as e:
                import sys as _sys
                print(
                    f"[_ingest_upload] display-PDF failed for {role} {file.filename!r}: "
                    f"{getattr(e, 'kind', 'error')} — {e}",
                    file=_sys.stderr,
                    flush=True,
                )
                display_pdf = None
        return markdown, html, display_pdf, file.filename or ""
    finally:
        tmp_path.unlink(missing_ok=True)


@app.post("/api/reconcile", dependencies=[Depends(require("ai"))])
async def reconcile_endpoint(
    contract_file: UploadFile = File(...),
    handover_file: UploadFile = File(...),
    user: dict = Depends(current_user),
    conn: sqlite3.Connection = Depends(get_db),
) -> dict:
    """Contract ↔ Handover (Table 3) reconciliation.

    Two-file multipart upload. Each file is parsed (PDF/DOCX/XLSX → Markdown)
    and handed to Claude with the reconciliation schema. The result is
    persisted to `reconciliations` so it shows up in Library/History.
    """
    contract_md, contract_html, contract_pdf, contract_name = await _ingest_upload(
        contract_file, RECONCILE_CONTRACT_EXTS, "contract",
    )
    handover_md, handover_html, handover_pdf, handover_name = await _ingest_upload(
        handover_file, RECONCILE_HANDOVER_EXTS, "handover",
    )

    try:
        result = reconciliation_module.reconcile(contract_md, handover_md)
    except ClaudeError as e:
        raise HTTPException(status_code=502, detail=str(e))

    pair = result["pair"]
    rows = result["rows"]
    findings = result["findings"]
    docs = result["docs"]
    verdict, must_count, should_count = reconciliation_module.compute_verdict(findings)

    payload = {
        "id": f"rec-{uuid.uuid4().hex[:8]}",
        "userId": user["id"],
        "contractFile": contract_name,
        "handoverFile": handover_name,
        "product": pair.get("product") or "",
        "counterparty": pair.get("counterparty") or "",
        "verdict": verdict,
        "mustCount": must_count,
        "shouldCount": should_count,
        "pair": pair,
        "rows": rows,
        "findings": findings,
        "docs": docs,
        # Phase 3.3: ship the raw source back so the FE can render the
        # original look (tables, layout) instead of Claude's compressed docs.
        # HTML is preferred for display (preserves tables); MD stays as the
        # token-cheap version and a fallback for older parsers.
        "contractMarkdown": contract_md,
        "handoverMarkdown": handover_md,
        "contractHtml": contract_html,
        "handoverHtml": handover_html,
        "createdAt": datetime.datetime.utcnow().isoformat(timespec="seconds") + "Z",
    }
    inserted = insert_row(conn, RECONCILIATIONS, payload)
    # Phase 4.x: write the display PDFs with a direct UPDATE since the
    # BLOB columns are intentionally kept out of RECONCILIATIONS.columns
    # so the generic CRUD list/get never serializes binary garbage.
    if contract_pdf is not None or handover_pdf is not None:
        conn.execute(
            "UPDATE reconciliations "
            "SET contract_display_pdf = ?, handover_display_pdf = ? "
            "WHERE id = ?",
            (contract_pdf, handover_pdf, inserted["id"]),
        )
        conn.commit()
    # Stable URLs the FE can fetch with `authHeaders()`. We return them
    # regardless of whether the BLOB landed — a 404 from the endpoint is
    # what the FE uses to swap to the "preview unavailable" banner.
    inserted["displayPdfUrl"] = (
        f"/api/reconciliations/{inserted['id']}/contract-display.pdf"
    )
    inserted["handoverDisplayPdfUrl"] = (
        f"/api/reconciliations/{inserted['id']}/handover-display.pdf"
    )
    return inserted


# ---------------------------------------------------------------------------
# Phase 4.x: display-PDF binary endpoints. FE pre-fetches the bytes via
# `fetch(url, { headers: authHeaders() })` → ArrayBuffer → PDF.js. We
# explicitly opt out of caching (`no-store`) because the BLOB carries
# potentially-confidential contract content. Three routes (contract,
# reconcile-contract, reconcile-handover) instead of one ?role=… handler —
# clearer URLs and FastAPI gets per-route dependency injection.
# ---------------------------------------------------------------------------

def _stream_display_pdf(
    conn: sqlite3.Connection, table: str, blob_col: str, row_id: str,
) -> "Response":
    from fastapi.responses import Response as _Response
    row = conn.execute(
        f"SELECT {blob_col} FROM {table} WHERE id = ?",
        (row_id,),
    ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail=f"{table[:-1]} not found")
    blob = row[0]
    if not blob:
        raise HTTPException(
            status_code=404,
            detail="display PDF not available for this record",
        )
    return _Response(
        content=bytes(blob),
        media_type="application/pdf",
        headers={
            "Cache-Control": "no-store",
            "Content-Length": str(len(blob)),
        },
    )


@app.get(
    "/api/contracts/{rid}/display.pdf",
    dependencies=[Depends(current_user)],
    include_in_schema=False,
)
def contract_display_pdf(rid: str, conn: sqlite3.Connection = Depends(get_db)):
    return _stream_display_pdf(conn, "contracts", "display_pdf", rid)


@app.get(
    "/api/reconciliations/{rid}/contract-display.pdf",
    dependencies=[Depends(current_user)],
    include_in_schema=False,
)
def reconciliation_contract_display_pdf(
    rid: str, conn: sqlite3.Connection = Depends(get_db),
):
    return _stream_display_pdf(conn, "reconciliations", "contract_display_pdf", rid)


@app.get(
    "/api/reconciliations/{rid}/handover-display.pdf",
    dependencies=[Depends(current_user)],
    include_in_schema=False,
)
def reconciliation_handover_display_pdf(
    rid: str, conn: sqlite3.Connection = Depends(get_db),
):
    return _stream_display_pdf(conn, "reconciliations", "handover_display_pdf", rid)


# All future API routes go above this line. The static mount below is registered
# LAST so it doesn't shadow JSON routes.

FRONTEND_DIR = Path(settings.FRONTEND_DIR)
if FRONTEND_DIR.is_dir():
    # Vite emits hashed bundles into assets/. Mount it explicitly so unknown URLs
    # under /assets/* return 404 instead of falling through to the SPA shell.
    assets_dir = FRONTEND_DIR / "assets"
    if assets_dir.is_dir():
        app.mount("/assets", StaticFiles(directory=str(assets_dir)), name="assets")

    index_html = FRONTEND_DIR / "index.html"

    @app.get("/{full_path:path}", include_in_schema=False)
    def spa_fallback(full_path: str):
        # API routes are declared above this handler, so they win the match.
        # Anything else returns index.html — the React app handles client-side routing.
        candidate = FRONTEND_DIR / full_path
        if full_path and candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(index_html)
else:
    @app.get("/", include_in_schema=False)
    def missing_frontend():
        return JSONResponse(
            status_code=503,
            content={
                "error": "frontend_not_built",
                "hint": f"Expected Vite build at {FRONTEND_DIR}. Run `npm run build` in the parent project.",
            },
        )
