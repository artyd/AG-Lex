"""Thin HTTP client for the Node.js converter microservice.

The Node side handles DOCX (mammoth → turndown), DOC (word-extractor),
PDF (text + optional OCR), XLSX/CSV (tabular markdown), and TXT/MD.
The FastAPI side proxies files to it via `multipart/form-data`.

CONVERTER_URL points at the in-network service hostname inside
docker-compose; for local dev override with e.g. `http://localhost:3031`.

A network error here is surfaced as `ConverterUnavailable` so the caller
can choose to fall back to the legacy in-process conversion path.
"""
from __future__ import annotations

import os
from typing import Any

import httpx


CONVERTER_URL = os.getenv("CONVERTER_URL", "http://converter:3031").rstrip("/")
CONVERTER_TIMEOUT = float(os.getenv("CONVERTER_TIMEOUT", "180"))


class ConverterUnavailable(RuntimeError):
    """Raised when the converter service is unreachable / errored."""


class ConverterError(RuntimeError):
    """Raised when the converter returns a non-2xx response (e.g. 415, 413)."""

    def __init__(self, message: str, *, status_code: int = 500) -> None:
        super().__init__(message)
        self.status_code = status_code


async def convert_file_to_markdown(
    file_bytes: bytes, filename: str, content_type: str | None = None,
) -> dict[str, Any]:
    """Send `file_bytes` to the converter and return its JSON response.

    Returns: {"markdown": str, "meta": {...}}.
    Raises:  ConverterUnavailable on transport errors;
             ConverterError(status_code=...) on a non-2xx response.
    """
    url = f"{CONVERTER_URL}/convert"
    files = {
        "file": (
            filename or "upload.bin",
            file_bytes,
            content_type or "application/octet-stream",
        ),
    }
    try:
        async with httpx.AsyncClient(timeout=CONVERTER_TIMEOUT) as client:
            resp = await client.post(url, files=files)
    except httpx.RequestError as e:
        raise ConverterUnavailable(
            f"converter unreachable at {url}: {e}"
        ) from e

    if resp.status_code >= 400:
        # Try to surface the converter's own error message; fall back to text.
        msg: str
        try:
            payload = resp.json()
            msg = str(payload.get("error") or payload)
        except Exception:
            msg = resp.text or f"HTTP {resp.status_code}"
        raise ConverterError(msg, status_code=resp.status_code)

    data = resp.json()
    if not isinstance(data, dict) or "markdown" not in data:
        raise ConverterError(
            "converter returned unexpected payload (missing markdown).",
            status_code=502,
        )
    return data


async def probe_converter() -> dict[str, Any]:
    """Hit the converter's /health endpoint with a short timeout.

    Returns {"ok": True, "url": ..., "body": ...} on a 2xx response,
    {"ok": False, "url": ..., "error": "..."} when unreachable or 5xx.
    Used by the diagnostic endpoint so ops can verify the container is
    actually up without SSH'ing into the host.
    """
    url = f"{CONVERTER_URL}/health"
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(url)
    except httpx.RequestError as e:
        return {"ok": False, "url": url, "error": f"unreachable: {e}"}
    if resp.status_code >= 400:
        return {"ok": False, "url": url, "status": resp.status_code, "body": resp.text}
    try:
        body = resp.json()
    except Exception:
        body = resp.text
    return {"ok": True, "url": url, "status": resp.status_code, "body": body}
