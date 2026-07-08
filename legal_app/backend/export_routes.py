"""Server-side export for edited contract markdown.

The FE editor holds the contract as a markdown string (Milkdown/CodeMirror).
Clients download .md / .txt / .docx via `src/lib/exportDoc.js`. For .pdf we
route through soffice on the server: MD → DOCX (python-docx) → PDF (soffice).
Preserves cyrillic fonts and gives a printer-ready file without depending on
the browser's print dialog.

Registered in main.py BEFORE the ALL_ENTITIES CRUD loop so `/api/export/*`
can't be shadowed by a generic handler.
"""
from __future__ import annotations

import io
import re
from typing import Optional
from urllib.parse import quote as _url_quote

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

from .auth import current_user
from .documents import DisplayPdfError, docx_bytes_to_pdf


router = APIRouter(prefix="/api/export", tags=["export"])


_HEADING_RE = re.compile(r"^(#{1,6})\s+(.+)$")
# Inline bold/italic/strikethrough markers. We flatten to plain text (no
# python-docx run splitting in v1 — same behaviour as the client-side
# downloadDocxString in src/lib/exportDoc.js).
_INLINE_STRIP_RE = re.compile(r"\*{1,3}([^*]+)\*{1,3}")
_HRULE_RE = re.compile(r"^-{3,}$")


# Heading level → font size (pt). Совпадает с CSS в src/styles/milkdown-theme.css:
# h1=14pt (титул), h2=11pt (нумерованные секции), h3=12pt (подзаголовки),
# h4/h5/h6=11pt. Так DOCX/PDF, скачанные пользователем, выглядят как в редакторе.
_HEADING_SIZE_PT = {1: 14, 2: 11, 3: 12, 4: 11, 5: 11, 6: 11}
# Sans-serif стек совпадает с редактором. Word/Windows подставит первый
# доступный: DejaVu Sans → Verdana → Arial.
_DOC_FONT_NAME = "Verdana"


def _apply_font(run, *, size_pt: int, bold: bool = False) -> None:
    """Set Verdana + point-size + bold-flag на run. Word/Writer при
    отсутствии Verdana подставит ближайший sans-serif — тот же принцип,
    что у CSS-fallback в редакторе."""
    from docx.shared import Pt
    run.font.name = _DOC_FONT_NAME
    run.font.size = Pt(size_pt)
    run.bold = bold


def _markdown_to_docx_bytes(markdown: str, title: Optional[str]) -> bytes:
    """MD → DOCX. Стилистика совпадает с редактором (Verdana 10pt, headings
    11/12/14pt bold, justified body) — скачанный DOCX и его soffice-PDF
    выглядят как то, что юрист правил на экране.

    Splits по blank-lines. `# heading` идёт в отдельный параграф с точечным
    размером из `_HEADING_SIZE_PT`. `**bold**` внутри параграфа сплющивается
    в текст без inline-runs (same behaviour as client `downloadDocxString`).
    Горизонтальные линии из sectionsToMarkdown отбрасываются.
    """
    from docx import Document
    from docx.shared import Pt
    from docx.enum.text import WD_ALIGN_PARAGRAPH

    doc = Document()
    style = doc.styles["Normal"]
    style.font.name = _DOC_FONT_NAME
    style.font.size = Pt(10)

    blocks = re.split(r"\n{2,}", markdown)
    for raw in blocks:
        block = raw.strip()
        if not block:
            continue
        if _HRULE_RE.match(block):
            continue

        head = _HEADING_RE.match(block)
        if head:
            level = min(len(head.group(1)), 6)
            heading_text = _INLINE_STRIP_RE.sub(r"\1", head.group(2)).strip()
            if heading_text:
                # Не используем add_heading (Word-стиль Heading N с непредсказуемым
                # размером/цветом); строим параграф руками, чтобы 100% контроль
                # над font/size/bold и alignment (H1 центрируется, как в CSS).
                p = doc.add_paragraph()
                if level == 1:
                    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
                run = p.add_run(heading_text)
                _apply_font(run, size_pt=_HEADING_SIZE_PT.get(level, 11), bold=True)
            rest = block[head.end():].strip()
            if rest:
                clean = _INLINE_STRIP_RE.sub(r"\1", rest).strip()
                if clean:
                    p = doc.add_paragraph()
                    p.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
                    run = p.add_run(clean)
                    _apply_font(run, size_pt=10)
            continue

        clean = _INLINE_STRIP_RE.sub(r"\1", block).strip()
        if clean:
            p = doc.add_paragraph()
            p.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
            run = p.add_run(clean)
            _apply_font(run, size_pt=10)

    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()


class ExportRequest(BaseModel):
    # 500k chars ≈ ~125k tokens — comfortably larger than any real contract,
    # tight enough to reject a malicious multi-MB payload.
    markdown: str = Field(
        ..., min_length=1, max_length=500_000,
        description="Edited contract markdown (Milkdown output).",
    )
    filename: Optional[str] = Field(
        default=None, max_length=200,
        description="Base filename hint (with or without extension). "
                    "Server sanitises + adds '-edited.<fmt>'.",
    )


_FS_HOSTILE_RE = re.compile(r"[<>:\"/\\|?*\x00-\x1f]")
_EXT_RE = re.compile(r"\.[^.]+$")


def _safe_base(name: Optional[str]) -> str:
    base = (name or "contract").strip()
    base = _FS_HOSTILE_RE.sub("", base)
    base = re.sub(r"\s+", " ", base).strip()
    base = _EXT_RE.sub("", base)
    return base or "contract"


def _attachment_headers(filename: str, media_type: str, size: int) -> dict:
    # Content-Disposition with both ASCII fallback + RFC 5987 UTF-8 form so
    # cyrillic filenames survive in Chrome/Firefox/Safari.
    ascii_fallback = filename.encode("ascii", "ignore").decode("ascii") or "download"
    rfc5987 = _url_quote(filename, safe="")
    return {
        "Content-Disposition": (
            f'attachment; filename="{ascii_fallback}"; '
            f"filename*=UTF-8''{rfc5987}"
        ),
        "Content-Length": str(size),
        "Cache-Control": "no-store",
        "Content-Type": media_type,
    }


@router.post("/docx", dependencies=[Depends(current_user)])
def export_docx(req: ExportRequest) -> Response:
    """Markdown → DOCX. Streamed back as an attachment."""
    docx_bytes = _markdown_to_docx_bytes(req.markdown, _safe_base(req.filename))
    filename = _safe_base(req.filename) + "-edited.docx"
    media = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    return Response(
        content=docx_bytes,
        media_type=media,
        headers=_attachment_headers(filename, media, len(docx_bytes)),
    )


@router.post("/pdf", dependencies=[Depends(current_user)])
def export_pdf(req: ExportRequest) -> Response:
    """Markdown → DOCX → PDF via soffice. Streamed back as an attachment.

    502 on soffice failures so the FE can offer the DOCX download as a
    fallback instead of pretending the caller made a mistake.
    """
    docx_bytes = _markdown_to_docx_bytes(req.markdown, _safe_base(req.filename))
    try:
        pdf_bytes = docx_bytes_to_pdf(docx_bytes)
    except DisplayPdfError as e:
        raise HTTPException(
            status_code=502,
            detail={"kind": e.kind, "message": str(e)},
        ) from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    filename = _safe_base(req.filename) + "-edited.pdf"
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers=_attachment_headers(filename, "application/pdf", len(pdf_bytes)),
    )
