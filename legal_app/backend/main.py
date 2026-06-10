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
from . import drafts as drafts_module
from . import team as team_module
from .audit import init_audit_schema
from .auth import current_user
from .claude_client import ClaudeError
from .codex import get_codex_stats
from .config import get_settings
from .contract_analysis import analyze_contract
from .crud import ALL_ENTITIES, build_router
from .database import get_connection, get_db, init_schema, init_user_schema
from .documents import (
    detect_type_and_convert,
    detect_type_and_extract_raw,
    split_into_sections,
    token_savings,
)
from .models import init_entity_schema, migrate_drafts
from .pipeline import analyze
from .rbac import (
    init_permissions_schema,
    require,
    seed_default_permissions,
)
import sqlite3

settings = get_settings()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Bring schemas up to date and seed the demo data on boot.

    Idempotent: all DDL is `CREATE IF NOT EXISTS`, `seed_test_user` no-ops
    when the row already exists, and `seed_all` uses INSERT OR IGNORE. Safe to
    run on every restart.
    """
    from scripts.seed_demo import seed_all  # avoid circular import at module load

    conn = get_connection()
    try:
        init_schema(conn)             # articles + FTS5 (Phases 1.1/1.2)
        init_user_schema(conn)        # users (Phase 2.1)
        init_entity_schema(conn)      # workspace entities (Phase 2.2)
        init_permissions_schema(conn) # permissions matrix (Phase 2.3)
        init_audit_schema(conn)       # audit log (Phase 2.3)
        migrate_drafts(conn)          # Fix 1: add user_id + is_shared, backfill legacy rows
        auth_module.seed_test_user(conn)
        seed_default_permissions(conn)
        seed_all(conn)                # populate workspace tables from demo data
    finally:
        conn.close()
    yield


app = FastAPI(title="AG Lex", version="0.1.0", lifespan=lifespan)
app.include_router(auth_module.router)
app.include_router(team_module.router)
app.include_router(assist_module.router)
app.include_router(builder_module.router)
app.include_router(drafts_module.router)  # Fix 1: custom router replaces generic CRUD

# Phase 2.2: mount /api/<entity> for every workspace table. All are gated by
# `current_user` inside `build_router`. Phase 2.3: invoices reads/writes
# require the `billing` capability per spec §5.2.
for _entity in ALL_ENTITIES:
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


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


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

        return {
            "filename": file.filename,
            "markdown": markdown,
            "sections": sections,
            "token_stats": stats,
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
