"""Document viewer + error-detection pipeline.

Three things live in this module so the feature is self-contained:

  1. Schema for `documents` and `document_errors` (CREATE IF NOT EXISTS,
     mirrors the project's idempotent-init convention; no ALTER calls
     against the production volume, so this is safe to land without the
     migration-safety review gate that protects models.py).
  2. The Claude prompt + structured-output schema used by /analyze.
     Kept here (not in prompts.py) so adding this feature doesn't bump
     the byte-stable shared prompt file and invalidate other cache entries.
  3. FastAPI router with five endpoints:
     POST /api/documents/upload       — convert file → store MD → return id
     GET  /api/documents/{id}         — return stored MD + meta
     POST /api/documents/{id}/analyze — Claude → persist errors
     GET  /api/documents/{id}/errors  — list outstanding errors (panel)
     GET  /api/documents/{id}/errors/{eid} — single error (right panel)
     GET  /api/documents/{id}/highlighted — MD with <mark> spans inlined
     POST /api/documents/{id}/apply-fix — replace excerpt with replacement,
                                          return word-level diff

The pipeline assumes ContentEditable-safe markdown (we wrap excerpts in
<mark class="doc-error ..."> spans). rehype-raw / dangerouslySetInnerHTML
must be used on the client side to render the tags as HTML rather than
literal text — see ErrorHighlighter.jsx.
"""
from __future__ import annotations

import datetime
import difflib
import json
import re
import sqlite3
import sys
import uuid
from pathlib import Path
from typing import Any

import anthropic
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel, Field

from .auth import current_user
from .claude_client import ClaudeError, _client
from .config import get_settings
from .converter_client import (
    ConverterError,
    ConverterUnavailable,
    convert_file_to_markdown,
)
from .database import get_db
from .documents import (
    detect_type_and_convert,
    detect_type_and_extract_raw,
    split_into_sections,
    token_savings,
)
from .rbac import require


# ---------------------------------------------------------------------------
# Schema — idempotent CREATE IF NOT EXISTS, called from lifespan.
# ---------------------------------------------------------------------------

DOCUMENTS_SCHEMA = """
CREATE TABLE IF NOT EXISTS documents (
    id           TEXT PRIMARY KEY,
    user_id      INTEGER REFERENCES users(id),
    filename     TEXT,
    title        TEXT,
    format       TEXT,           -- 'docx' | 'pdf' | 'pdf-ocr' | 'xlsx' | …
    content      TEXT NOT NULL,  -- the markdown
    word_count   INTEGER NOT NULL DEFAULT 0,
    pages        INTEGER,
    created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_documents_user ON documents(user_id);
CREATE INDEX IF NOT EXISTS idx_documents_created ON documents(created_at);

-- One row per AI-detected issue in a document. `text_excerpt` is the
-- literal substring of `documents.content` that the highlight wraps; the
-- ctx_before/after fields exist so we can pick the right occurrence when
-- the same excerpt appears more than once.
CREATE TABLE IF NOT EXISTS document_errors (
    id           TEXT PRIMARY KEY,
    document_id  TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    text_excerpt TEXT NOT NULL,
    ctx_before   TEXT DEFAULT '',
    ctx_after    TEXT DEFAULT '',
    error_type   TEXT NOT NULL,    -- grammar | legal | formatting | terminology | compliance
    severity     TEXT NOT NULL,    -- critical | warning | suggestion
    explanation  TEXT NOT NULL,
    suggestion   TEXT NOT NULL,
    replacement  TEXT NOT NULL,
    is_applied   INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_document_errors_doc ON document_errors(document_id, is_applied);
"""


def init_documents_schema(conn: sqlite3.Connection) -> None:
    """Create the documents + document_errors tables (idempotent)."""
    conn.executescript(DOCUMENTS_SCHEMA)
    conn.commit()


# ---------------------------------------------------------------------------
# Claude prompt + JSON schema for /analyze.
# Self-contained — does NOT touch prompts.py (byte-stable, shared cache).
# ---------------------------------------------------------------------------

DOC_ERROR_PROMPT = (
    "Ти — помічник юриста AG Lex. Проаналізуй наданий юридичний документ "
    "і знайди помилки та недоліки. Відповідай ВИКЛЮЧНО JSON-масивом — "
    "нічого, крім JSON.\n"
    "\n"
    "Формат кожного елемента:\n"
    "{\n"
    "  \"text_excerpt\": \"точний фрагмент тексту з документа (до 200 символів)\",\n"
    "  \"ctx_before\": \"до 80 символів, що йдуть ПЕРЕД text_excerpt\",\n"
    "  \"ctx_after\": \"до 80 символів, що йдуть ПІСЛЯ text_excerpt\",\n"
    "  \"error_type\": \"grammar|legal|formatting|terminology|compliance\",\n"
    "  \"severity\": \"critical|warning|suggestion\",\n"
    "  \"explanation\": \"опис проблеми українською (1-2 речення)\",\n"
    "  \"suggestion\": \"порада як виправити (1-2 речення)\",\n"
    "  \"replacement\": \"виправлений варіант фрагменту\"\n"
    "}\n"
    "\n"
    "Типи помилок:\n"
    "- grammar: граматичні, пунктуаційні, орфографічні\n"
    "- legal: юридичні неточності, суперечності законодавству\n"
    "- formatting: порушення форматування юридичного документа\n"
    "- terminology: неправильна юридична термінологія\n"
    "- compliance: невідповідність вимогам (ЗУ, КЗпП, ЦКУ тощо)\n"
    "\n"
    "КРИТИЧНО: text_excerpt має бути ДОСЛІВНО скопійований з документа. "
    "Не вигадуй фрагменти — лише реальний текст з наданого документа.\n"
    "Якщо проблем немає — поверни []."
)

DOC_ERROR_JSON_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["errors"],
    "properties": {
        "errors": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": [
                    "text_excerpt", "ctx_before", "ctx_after",
                    "error_type", "severity",
                    "explanation", "suggestion", "replacement",
                ],
                "properties": {
                    "text_excerpt": {"type": "string", "minLength": 1, "maxLength": 600},
                    "ctx_before": {"type": "string", "maxLength": 240},
                    "ctx_after": {"type": "string", "maxLength": 240},
                    "error_type": {
                        "type": "string",
                        "enum": ["grammar", "legal", "formatting", "terminology", "compliance"],
                    },
                    "severity": {
                        "type": "string",
                        "enum": ["critical", "warning", "suggestion"],
                    },
                    "explanation": {"type": "string", "maxLength": 1000},
                    "suggestion": {"type": "string", "maxLength": 1000},
                    "replacement": {"type": "string", "maxLength": 1200},
                },
            },
        },
    },
}


def _call_claude_for_errors(content: str) -> list[dict]:
    """Single Claude call to produce a list of structured error dicts."""
    settings = get_settings()
    cli = _client()
    try:
        response = cli.messages.create(
            model=settings.MODEL_NAME,
            max_tokens=4096,
            system=[{
                "type": "text",
                "text": DOC_ERROR_PROMPT,
                "cache_control": {"type": "ephemeral"},
            }],
            messages=[{"role": "user", "content": content}],
            output_config={
                "format": {
                    "type": "json_schema",
                    "schema": DOC_ERROR_JSON_SCHEMA,
                },
            },
        )
    except anthropic.AuthenticationError as e:
        raise ClaudeError(f"Anthropic authentication failed: {e.message}") from e
    except anthropic.RateLimitError as e:
        raise ClaudeError(f"Anthropic rate limit exceeded: {e.message}") from e
    except anthropic.APIConnectionError as e:
        raise ClaudeError(f"Network error contacting Anthropic: {e}") from e
    except anthropic.APIStatusError as e:
        raise ClaudeError(f"Anthropic API error ({e.status_code}): {e.message}") from e

    raw = "".join(
        getattr(b, "text", "") for b in response.content
        if getattr(b, "type", None) == "text"
    ).strip()
    raw = _strip_code_fence(raw)
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as e:
        raise ClaudeError(f"Claude returned non-JSON output: {raw[:200]}…") from e
    if isinstance(parsed, list):
        # Fallback: model emitted a bare array despite the schema.
        return [e for e in parsed if isinstance(e, dict)]
    if isinstance(parsed, dict):
        items = parsed.get("errors") or []
        return [e for e in items if isinstance(e, dict)]
    return []


def _strip_code_fence(text: str) -> str:
    """Pull JSON out of ```json … ``` fences if the model wraps the payload."""
    m = re.match(r"```(?:json)?\s*([\s\S]+?)\s*```\s*$", text)
    return m.group(1) if m else text


# ---------------------------------------------------------------------------
# Excerpt locator — pick the right occurrence using surrounding context.
# ---------------------------------------------------------------------------


def find_in_context(
    text: str, excerpt: str, ctx_before: str = "", ctx_after: str = "",
) -> int:
    """Return the index of the right occurrence of `excerpt` in `text`.

    -1 when not found. When several positions match, score each candidate by
    how many trailing chars of `ctx_before` align with the chars immediately
    preceding the match, plus how many leading chars of `ctx_after` align
    with the chars immediately following. Best score wins (ties → first).
    """
    if not excerpt:
        return -1
    positions = [m.start() for m in re.finditer(re.escape(excerpt), text)]
    if not positions:
        return -1
    if len(positions) == 1:
        return positions[0]

    best_idx, best_score = positions[0], -1
    for pos in positions:
        before_window = text[max(0, pos - len(ctx_before)):pos]
        after_window = text[pos + len(excerpt): pos + len(excerpt) + len(ctx_after)]
        # Count matching characters from the boundary outward.
        score = 0
        for a, b in zip(reversed(ctx_before), reversed(before_window)):
            if a == b:
                score += 1
            else:
                break
        for a, b in zip(ctx_after, after_window):
            if a == b:
                score += 1
            else:
                break
        if score > best_score:
            best_score, best_idx = score, pos
    return best_idx


# ---------------------------------------------------------------------------
# Word-level diff for the right panel after apply-fix.
# ---------------------------------------------------------------------------


def compute_word_diff(original: str, replacement: str) -> list[dict]:
    orig = original.split()
    repl = replacement.split()
    matcher = difflib.SequenceMatcher(None, orig, repl)
    result: list[dict] = []
    for op, i1, i2, j1, j2 in matcher.get_opcodes():
        if op == "equal":
            result.append({"type": "equal", "text": " ".join(orig[i1:i2])})
        elif op == "delete":
            result.append({"type": "delete", "text": " ".join(orig[i1:i2])})
        elif op == "insert":
            result.append({"type": "insert", "text": " ".join(repl[j1:j2])})
        elif op == "replace":
            result.append({"type": "delete", "text": " ".join(orig[i1:i2])})
            result.append({"type": "insert", "text": " ".join(repl[j1:j2])})
    return [c for c in result if c["text"]]


# ---------------------------------------------------------------------------
# Highlighter — inline <mark> tags into the markdown.
# ---------------------------------------------------------------------------


def _html_escape_attr(s: str) -> str:
    return (
        s.replace("&", "&amp;")
         .replace("\"", "&quot;")
         .replace("<", "&lt;")
         .replace(">", "&gt;")
         .replace("\n", " ")
    )


def build_highlighted(content: str, errors: list[dict]) -> tuple[str, int]:
    """Wrap each error's excerpt in a <mark> span — right-to-left insertion
    so positional indices don't shift mid-pass. Overlapping spans are
    dropped (kept the earlier one) to avoid producing broken HTML.

    Returns (markdown_with_marks, applied_error_count).
    """
    insertions: list[tuple[int, int, dict]] = []
    for err in errors:
        idx = find_in_context(
            content,
            err["text_excerpt"],
            err.get("ctx_before") or "",
            err.get("ctx_after") or "",
        )
        if idx == -1:
            continue
        insertions.append((idx, idx + len(err["text_excerpt"]), err))

    insertions.sort(key=lambda t: t[0])

    non_overlapping: list[tuple[int, int, dict]] = []
    last_end = 0
    for start, end, err in insertions:
        if start >= last_end:
            non_overlapping.append((start, end, err))
            last_end = end

    result = content
    for start, end, err in reversed(non_overlapping):
        severity_class = f"err-{err['severity']}"
        opener = (
            f"<mark class=\"doc-error {severity_class}\" "
            f"data-error-id=\"{_html_escape_attr(err['id'])}\" "
            f"data-error-type=\"{_html_escape_attr(err['error_type'])}\" "
            f"data-explanation=\"{_html_escape_attr(err['explanation'])}\">"
        )
        result = result[:start] + opener + result[start:end] + "</mark>" + result[end:]

    return result, len(non_overlapping)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


SUPPORTED_EXTS = {".pdf", ".docx", ".doc", ".xlsx", ".xls", ".csv", ".txt", ".md"}
MAX_UPLOAD_BYTES = 25 * 1024 * 1024


def _now_iso() -> str:
    return datetime.datetime.utcnow().isoformat(timespec="seconds") + "Z"


def _doc_row_to_dict(row: sqlite3.Row | tuple) -> dict:
    return {
        "id": row[0],
        "filename": row[1],
        "title": row[2],
        "format": row[3],
        "word_count": row[4],
        "pages": row[5],
        "created_at": row[6],
        "content": row[7],
    }


def _err_row_to_dict(row: sqlite3.Row | tuple) -> dict:
    return {
        "id": row[0],
        "document_id": row[1],
        "text_excerpt": row[2],
        "ctx_before": row[3],
        "ctx_after": row[4],
        "error_type": row[5],
        "severity": row[6],
        "explanation": row[7],
        "suggestion": row[8],
        "replacement": row[9],
        "is_applied": bool(row[10]),
        "created_at": row[11],
    }


def _load_document(conn: sqlite3.Connection, doc_id: str) -> dict:
    row = conn.execute(
        "SELECT id, filename, title, format, word_count, pages, created_at, content "
        "FROM documents WHERE id = ?",
        (doc_id,),
    ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Документ не знайдено.")
    return _doc_row_to_dict(row)


def _load_error(conn: sqlite3.Connection, doc_id: str, error_id: str) -> dict:
    row = conn.execute(
        "SELECT id, document_id, text_excerpt, ctx_before, ctx_after, "
        "error_type, severity, explanation, suggestion, replacement, "
        "is_applied, created_at "
        "FROM document_errors WHERE id = ? AND document_id = ?",
        (error_id, doc_id),
    ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Помилку не знайдено.")
    return _err_row_to_dict(row)


# ---------------------------------------------------------------------------
# Router
# ---------------------------------------------------------------------------

router = APIRouter(prefix="/api/documents", tags=["documents"])


class ApplyFixRequest(BaseModel):
    error_id: str = Field(..., min_length=1)


@router.post("/upload")
async def upload_document(
    file: UploadFile = File(...),
    user: dict = Depends(current_user),
    conn: sqlite3.Connection = Depends(get_db),
) -> dict:
    """Convert + persist an uploaded document; return its id + meta.

    Conversion goes through the Node.js converter microservice first
    (better DOCX → MD, OCR for scanned PDFs, XLSX support). On any
    transport error we fall back to the existing pymupdf4llm/mammoth
    in-process path so the feature degrades gracefully when the
    converter container is down.
    """
    filename = file.filename or "document"
    suffix = Path(filename).suffix.lower()
    if suffix not in SUPPORTED_EXTS:
        raise HTTPException(
            status_code=415,
            detail=f"Непідтримуваний тип файлу {suffix!r}. Підтримується: {sorted(SUPPORTED_EXTS)}",
        )
    raw_bytes = await file.read()
    if not raw_bytes:
        raise HTTPException(status_code=400, detail="Файл порожній.")
    if len(raw_bytes) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413,
            detail=(
                f"Файл перевищує {MAX_UPLOAD_BYTES // (1024 * 1024)} МБ — "
                "зменшіть розмір і спробуйте ще раз."
            ),
        )

    markdown: str = ""
    meta: dict[str, Any] = {}
    used_converter = False
    try:
        result = await convert_file_to_markdown(
            raw_bytes, filename, content_type=file.content_type,
        )
        markdown = (result.get("markdown") or "").strip()
        meta = result.get("meta") or {}
        used_converter = True
    except ConverterUnavailable as e:
        # Service down → fall back to the legacy in-process converter.
        print(f"[documents] converter unavailable, falling back: {e}", file=sys.stderr, flush=True)
    except ConverterError as e:
        # Service rejected the file (415/413) → bubble up with its status.
        raise HTTPException(status_code=e.status_code, detail=str(e)) from e

    if not used_converter:
        if suffix not in {".pdf", ".docx"}:
            raise HTTPException(
                status_code=503,
                detail=(
                    "Сервіс-конвертер недоступний, а локальний резерв підтримує "
                    "лише .pdf і .docx. Спробуйте пізніше."
                ),
            )
        # Use the same legacy pipeline /api/upload uses today. The legacy path
        # reads from a temp file — write the bytes, parse, then clean up.
        import os
        import tempfile
        fd, tmp_str = tempfile.mkstemp(suffix=suffix, prefix="aglex_doc_")
        os.close(fd)
        tmp_path = Path(tmp_str)
        try:
            tmp_path.write_bytes(raw_bytes)
            raw_text = detect_type_and_extract_raw(tmp_path)
            markdown = detect_type_and_convert(tmp_path).strip()
            sections = split_into_sections(markdown)
            stats = token_savings(raw_text, markdown)
            meta = {
                "title": Path(filename).stem,
                "word_count": len(markdown.split()),
                "format": suffix.lstrip("."),
                "sections": len(sections),
                "token_stats": stats,
            }
        finally:
            tmp_path.unlink(missing_ok=True)

    if not markdown:
        raise HTTPException(
            status_code=422,
            detail=(
                "Не вдалося витягнути текст із файлу. Можливо, це скан без "
                "розпізнаваного тексту або файл захищений паролем."
            ),
        )

    doc_id = f"doc-{uuid.uuid4().hex[:10]}"
    title = (meta.get("title") or Path(filename).stem)[:200]
    fmt = (meta.get("format") or suffix.lstrip("."))[:32]
    word_count = int(meta.get("word_count") or len(markdown.split()))
    pages = meta.get("pages")
    if pages is not None:
        try:
            pages = int(pages)
        except (TypeError, ValueError):
            pages = None

    conn.execute(
        "INSERT INTO documents (id, user_id, filename, title, format, content, "
        "word_count, pages, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (doc_id, user["id"], filename, title, fmt, markdown,
         word_count, pages, _now_iso()),
    )
    conn.commit()
    return {
        "id": doc_id,
        "filename": filename,
        "title": title,
        "format": fmt,
        "word_count": word_count,
        "pages": pages,
        "converter": used_converter,
    }


@router.get("/{doc_id}")
def get_document(
    doc_id: str,
    _user: dict = Depends(current_user),
    conn: sqlite3.Connection = Depends(get_db),
) -> dict:
    return _load_document(conn, doc_id)


@router.post("/{doc_id}/analyze", dependencies=[Depends(require("ai"))])
def analyze_document(
    doc_id: str,
    conn: sqlite3.Connection = Depends(get_db),
) -> dict:
    """Call Claude → insert one row per detected error → return summary."""
    doc = _load_document(conn, doc_id)
    content = doc["content"] or ""
    if not content.strip():
        raise HTTPException(status_code=400, detail="Документ порожній.")

    # Drop previously detected (still-outstanding) errors so re-running
    # /analyze doesn't double up. Applied errors stay in the audit trail.
    conn.execute(
        "DELETE FROM document_errors WHERE document_id = ? AND is_applied = 0",
        (doc_id,),
    )

    try:
        items = _call_claude_for_errors(content)
    except ClaudeError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e

    now = _now_iso()
    rows = []
    for raw in items:
        excerpt = (raw.get("text_excerpt") or "").strip()
        if not excerpt:
            continue
        if excerpt not in content:
            # Hallucinated excerpt — skip rather than create an un-findable
            # highlight that confuses the user.
            continue
        rows.append((
            f"err-{uuid.uuid4().hex[:10]}",
            doc_id,
            excerpt,
            (raw.get("ctx_before") or "")[:240],
            (raw.get("ctx_after") or "")[:240],
            raw.get("error_type") or "grammar",
            raw.get("severity") or "suggestion",
            (raw.get("explanation") or "").strip(),
            (raw.get("suggestion") or "").strip(),
            (raw.get("replacement") or "").strip(),
            0,
            now,
        ))
    if rows:
        conn.executemany(
            "INSERT INTO document_errors (id, document_id, text_excerpt, "
            "ctx_before, ctx_after, error_type, severity, explanation, "
            "suggestion, replacement, is_applied, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            rows,
        )
    conn.commit()
    return {"errors_inserted": len(rows), "discarded": len(items) - len(rows)}


@router.get("/{doc_id}/errors")
def list_errors(
    doc_id: str,
    include_applied: int = 0,
    _user: dict = Depends(current_user),
    conn: sqlite3.Connection = Depends(get_db),
) -> list[dict]:
    _load_document(conn, doc_id)  # 404 check
    where = "document_id = ?"
    params: tuple = (doc_id,)
    if not include_applied:
        where += " AND is_applied = 0"
    rows = conn.execute(
        "SELECT id, document_id, text_excerpt, ctx_before, ctx_after, "
        "error_type, severity, explanation, suggestion, replacement, "
        "is_applied, created_at "
        f"FROM document_errors WHERE {where} ORDER BY created_at",
        params,
    ).fetchall()
    return [_err_row_to_dict(r) for r in rows]


@router.get("/{doc_id}/errors/{error_id}")
def get_error(
    doc_id: str,
    error_id: str,
    _user: dict = Depends(current_user),
    conn: sqlite3.Connection = Depends(get_db),
) -> dict:
    return _load_error(conn, doc_id, error_id)


@router.get("/{doc_id}/highlighted")
def get_highlighted(
    doc_id: str,
    _user: dict = Depends(current_user),
    conn: sqlite3.Connection = Depends(get_db),
) -> dict:
    doc = _load_document(conn, doc_id)
    rows = conn.execute(
        "SELECT id, document_id, text_excerpt, ctx_before, ctx_after, "
        "error_type, severity, explanation, suggestion, replacement, "
        "is_applied, created_at "
        "FROM document_errors WHERE document_id = ? AND is_applied = 0 "
        "ORDER BY created_at",
        (doc_id,),
    ).fetchall()
    errors = [_err_row_to_dict(r) for r in rows]
    highlighted, count = build_highlighted(doc["content"], errors)
    return {
        "content": highlighted,
        "error_count": count,
        "errors": errors,
    }


@router.post("/{doc_id}/apply-fix")
def apply_fix(
    doc_id: str,
    body: ApplyFixRequest,
    _user: dict = Depends(current_user),
    conn: sqlite3.Connection = Depends(get_db),
) -> dict:
    err = _load_error(conn, doc_id, body.error_id)
    if err["is_applied"]:
        raise HTTPException(status_code=409, detail="Виправлення вже застосовано.")

    doc = _load_document(conn, doc_id)
    content = doc["content"]
    excerpt = err["text_excerpt"]
    idx = find_in_context(content, excerpt, err["ctx_before"], err["ctx_after"])
    if idx == -1:
        # Excerpt no longer exists (probably stale after another apply-fix).
        conn.execute(
            "UPDATE document_errors SET is_applied = 1 WHERE id = ?",
            (body.error_id,),
        )
        conn.commit()
        raise HTTPException(
            status_code=410,
            detail="Фрагмент більше не знайдено у документі — позначаю помилку як неактуальну.",
        )

    updated = content[:idx] + err["replacement"] + content[idx + len(excerpt):]
    diff = compute_word_diff(excerpt, err["replacement"])
    conn.execute(
        "UPDATE documents SET content = ?, word_count = ? WHERE id = ?",
        (updated, len(updated.split()), doc_id),
    )
    conn.execute(
        "UPDATE document_errors SET is_applied = 1 WHERE id = ?",
        (body.error_id,),
    )
    conn.commit()
    return {
        "diff": diff,
        "updated_content": updated,
        "error_id": body.error_id,
    }
