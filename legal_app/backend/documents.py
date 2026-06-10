"""Contract ingestion: PDF/DOCX → Markdown → sections + token stats.

Phase 1.3. Used by `POST /api/upload`. The point of the conversion is two-fold:

1. Lawyers see the original; Claude works against the smaller Markdown.
2. Section splitting lets us later send Claude only the relevant clause instead
   of the whole contract — that's where the token savings actually come from.
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Callable


# ---------------------------------------------------------------------------
# raw extraction (used for the token-savings comparison)
# ---------------------------------------------------------------------------

def pdf_raw_text(path: str | Path) -> str:
    import pymupdf
    doc = pymupdf.open(str(path))
    try:
        return "\n".join(page.get_text() for page in doc)
    finally:
        doc.close()


def docx_raw_text(path: str | Path) -> str:
    import mammoth
    with open(str(path), "rb") as f:
        return mammoth.extract_raw_text(f).value


def xlsx_raw_text(path: str | Path) -> str:
    """Flatten every non-empty cell across all sheets into newline-separated text."""
    import openpyxl
    wb = openpyxl.load_workbook(str(path), read_only=True, data_only=True)
    try:
        lines: list[str] = []
        for ws in wb.worksheets:
            for row in ws.iter_rows(values_only=True):
                cells = [str(c).strip() for c in row if c not in (None, "")]
                if cells:
                    lines.append("\t".join(cells))
        return "\n".join(lines)
    finally:
        wb.close()


# ---------------------------------------------------------------------------
# markdown conversion
# ---------------------------------------------------------------------------

def pdf_to_markdown(path: str | Path) -> str:
    """PyMuPDF4LLM produces a Markdown rendering with headings + tables."""
    import pymupdf4llm
    return pymupdf4llm.to_markdown(str(path))


def docx_to_markdown(path: str | Path) -> str:
    """Mammoth renders Word styling (headings, lists, tables) into Markdown."""
    import mammoth
    with open(str(path), "rb") as f:
        result = mammoth.convert_to_markdown(f)
    return result.value


def xlsx_to_markdown(path: str | Path) -> str:
    """Render every sheet as a Markdown table.

    Used for the procurement "Handover (Table 3)" which arrives as an Excel
    form: two-column N/Field/Value layouts and 3+ column tables both work.
    Empty rows are skipped; merged cells aren't expanded (openpyxl read-only
    flattens them to the top-left value, which matches how lawyers read the
    form anyway).
    """
    import openpyxl
    wb = openpyxl.load_workbook(str(path), read_only=True, data_only=True)
    try:
        parts: list[str] = []
        for ws in wb.worksheets:
            rows = [
                ["" if c is None else str(c).strip() for c in row]
                for row in ws.iter_rows(values_only=True)
            ]
            rows = [r for r in rows if any(cell for cell in r)]
            if not rows:
                continue
            width = max(len(r) for r in rows)
            rows = [r + [""] * (width - len(r)) for r in rows]
            if ws.title and ws.title.lower() not in {"sheet", "sheet1", "аркуш1"}:
                parts.append(f"## {ws.title}\n")
            header = rows[0]
            body = rows[1:]
            parts.append("| " + " | ".join(header) + " |")
            parts.append("| " + " | ".join("---" for _ in header) + " |")
            for r in body:
                parts.append("| " + " | ".join(c.replace("|", "\\|") for c in r) + " |")
            parts.append("")
        return "\n".join(parts)
    finally:
        wb.close()


_CONVERTERS: dict[str, Callable[[str | Path], str]] = {
    ".pdf": pdf_to_markdown,
    ".docx": docx_to_markdown,
    ".xlsx": xlsx_to_markdown,
}

_RAW_EXTRACTORS: dict[str, Callable[[str | Path], str]] = {
    ".pdf": pdf_raw_text,
    ".docx": docx_raw_text,
    ".xlsx": xlsx_raw_text,
}


def detect_type_and_convert(path: str | Path) -> str:
    suffix = Path(path).suffix.lower()
    fn = _CONVERTERS.get(suffix)
    if fn is None:
        raise ValueError(f"Unsupported file type: {suffix!r}. Supported: .pdf, .docx, .xlsx")
    return fn(path)


def detect_type_and_extract_raw(path: str | Path) -> str:
    suffix = Path(path).suffix.lower()
    fn = _RAW_EXTRACTORS.get(suffix)
    if fn is None:
        raise ValueError(f"Unsupported file type: {suffix!r}. Supported: .pdf, .docx, .xlsx")
    return fn(path)


# ---------------------------------------------------------------------------
# section splitting
# ---------------------------------------------------------------------------

# Contract section markers. Anchored to line-start so inline references like
# "як зазначено у Статті 5" don't trigger a split. Leading markdown decorations
# (`#`, `**`, `>`, list bullets) are tolerated. The bare-number rule
# `\d+\.(?=\s+\S)` only fires when followed by a non-empty heading word — that
# trims most numbered-list false positives.
_SECTION_RE = re.compile(
    r"^"
    r"[ \t]*(?:[#>\-\*_]+[ \t]*)*"
    r"(?P<number>"
    # Headings: capture digits/Roman numerals but stop at the separating dot so
    # "Стаття 5." doesn't include the trailing dot in the number.
    r"(?:Розділ|Стаття)\s+[^\s\n.]+"
    r"|п\.\s*\d+(?:\.\d+)*"
    r"|\d+(?:\.\d+)+"
    # Bare "1." / "2." numbered points — keep the dot so the label stays
    # distinguishable from a plain integer.
    r"|\d+\.(?=\s+\S)"
    r")"
    r"[ \t\.]*"
    r"(?P<title>[^\n]*)$",
    re.MULTILINE | re.IGNORECASE,
)


def _clean_title(raw: str) -> str | None:
    cleaned = re.sub(r"[\*_`#>]+", " ", raw).strip(" .-–—")
    return cleaned or None


def split_into_sections(markdown: str) -> list[dict]:
    """Slice contract Markdown into `{number, title, text}` sections.

    Splitting is best-effort by design (the Phase 1.3 doc explicitly says even
    rough cuts already give token savings). Empty bodies and a noisy preamble
    before the first marker are kept as a section with `number=None` only when
    they contain visible text.
    """
    matches = list(_SECTION_RE.finditer(markdown))
    if not matches:
        return [{"number": None, "title": None, "text": markdown.strip()}] if markdown.strip() else []

    sections: list[dict] = []

    head = markdown[: matches[0].start()].strip()
    if head:
        sections.append({"number": None, "title": None, "text": head})

    for i, m in enumerate(matches):
        end = matches[i + 1].start() if i + 1 < len(matches) else len(markdown)
        body = markdown[m.end():end].strip()
        sections.append(
            {
                "number": m.group("number").strip(),
                "title": _clean_title(m.group("title") or ""),
                "text": body,
            }
        )
    return sections


# ---------------------------------------------------------------------------
# token estimation
# ---------------------------------------------------------------------------

def estimate_tokens(text: str | None) -> int:
    """Rough heuristic: ~4 characters per token.

    Holds well enough for both English and Ukrainian Cyrillic. Off by ~20% in
    either direction depending on the model, but adequate for the "Markdown vs
    raw" comparison we surface in `/api/upload`. Swap in tiktoken/anthropic
    tokenizer later if exact counts matter.
    """
    if not text:
        return 0
    return max(1, len(text) // 4)


def token_savings(raw: str, markdown: str) -> dict:
    raw_t = estimate_tokens(raw)
    md_t = estimate_tokens(markdown)
    pct = round((1 - md_t / raw_t) * 100, 1) if raw_t else 0.0
    return {"raw_tokens": raw_t, "markdown_tokens": md_t, "savings_pct": pct}
