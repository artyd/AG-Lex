"""Constitutional Court of Ukraine (ccu.gov.ua).

The site's own document filter stops at 2022, so we use its full-text site
search (`/search/node/<words>`), which covers decisions, press releases and
news up to today, then read a result page and — on request — the decision
PDF attached to it (text via PyMuPDF). Decision texts are also on
zakon.rada.gov.ua (ua_get_act) when their nreg is known.
"""
from __future__ import annotations

import html as html_lib
import re
from urllib.parse import quote, urljoin, urlparse

from .fetcher import HostPolicy, LiveFetcher, SourceError

HOST = "ccu.gov.ua"
BASE = f"https://{HOST}"
CCU_POLICY = HostPolicy(min_interval=3.0, max_wait=20.0, daily_bytes=150 * 1024 * 1024)

TTL_SEARCH = 6 * 3600.0
TTL_PAGE = 7 * 24 * 3600.0
MAX_PDF_CHARS = 200_000
MAX_PDF_BYTES = 5 * 1024 * 1024
MAX_PDF_PAGES = 300

# One result = one <li>; parse each chunk separately so a result without a
# snippet or date can't borrow its neighbour's (and hide the next result).
_LI = re.compile(r'<li class="search-result[^"]*"[^>]*>(.*?)</li>', re.S)
_A = re.compile(r'<h3[^>]*class="title"[^>]*>\s*<a\s[^>]*?href="([^"]+)"[^>]*>(.*?)</a>', re.S)
_SNIPPET = re.compile(r'<p class="search-snippet"[^>]*>(.*?)</p>', re.S)
_INFO = re.compile(r'<p class="search-info"[^>]*>(.*?)</p>', re.S)
_TITLE = re.compile(r"<h1[^>]*>(.*?)</h1>", re.S)
_FILE = re.compile(r'href="([^"]+?\.pdf(?:\?[^"]*)?)"', re.I)
# "№ 1-р(II)/2019", "3-рп/2016", "1-в/2020", with en-dash / NBSP-hyphen,
# upper case and Latin look-alikes (p, y, B) that creep into site texts.
_DECISION_NO = re.compile(
    r"(?:№|N[oº]?\.?)?\s*(\d{1,3}[-–‑](?:[рp][пn]?|[уy][пn]?|[вB]|зп)(?:\([ІI]{1,2}\))?/\d{4})", re.I
)
_BLOCKED_PREFIXES = ("/user", "/admin", "/search", "/node/add", "/filter", "/batch")


def _plain(fragment: str) -> str:
    s = re.sub(r"<script.*?</script>|<style.*?</style>", " ", fragment, flags=re.S | re.I)
    s = re.sub(r"<(br|/p|/li|/div|/h\d|/tr)\b[^>]*>", "\n", s, flags=re.I)
    s = html_lib.unescape(re.sub(r"<[^>]+>", " ", s)).replace("\xa0", " ")
    return "\n".join(" ".join(ln.split()) for ln in s.split("\n") if ln.strip())


def _decision_no(*texts: str) -> str | None:
    for t in texts:
        m = _DECISION_NO.search(t or "")
        if m:
            return m.group(1).replace("–", "-").replace("‑", "-")
    return None


def _valid_html(f) -> None:
    if "<html" not in f.text()[:2000].lower():
        raise SourceError("ccu.gov.ua returned an unexpected page.")


def _check_url(url: str) -> str:
    """https, exact host, no traversal, no admin/search paths → canonical URL."""
    u = urlparse(url.strip())
    if u.scheme != "https" or (u.hostname or "").lower() not in (HOST, "www." + HOST) \
            or u.username or u.port not in (None, 443):
        raise SourceError("url must be an https://ccu.gov.ua/... page from ua_ccu_search.")
    path = u.path or "/"
    if ".." in path.split("/") or path.lower().startswith(_BLOCKED_PREFIXES):
        raise SourceError("url must point to a ccu.gov.ua decision/news page or its PDF.")
    return f"{BASE}{quote(path, safe='/-_.%()')}"


def search(fetcher: LiveFetcher, query: str, limit: int = 10) -> dict:
    q = " ".join(query.split())[:120]
    if len(q) < 3:
        raise SourceError("query must be at least 3 characters.")
    url = f"{BASE}/search/node/{quote(q)}"
    got = fetcher.fetch(url, ttl=TTL_SEARCH, validate=_valid_html)
    results = []
    for li in _LI.finditer(got.text()):
        chunk = li.group(1)
        a = _A.search(chunk)
        if not a:
            continue
        try:
            link = _check_url(urljoin(BASE, html_lib.unescape(a.group(1))))
        except SourceError:
            continue  # off-site or admin link: not something ua_ccu_document may open
        sn, info = _SNIPPET.search(chunk), _INFO.search(chunk)
        title_t = _plain(a.group(2))
        snippet = _plain(sn.group(1)) if sn else ""
        date = re.search(r"(\d{2}\.\d{2}\.\d{4})", _plain(info.group(1))) if info else None
        results.append({
            "title": title_t,
            "url": link,
            "date": date.group(1) if date else None,
            "decision_number": _decision_no(title_t, snippet),
            "snippet": snippet[:400],
        })
    n = max(1, min(30, int(limit)))
    return {"query": q, "results": results[:n], "total_on_page": len(results), "source_url": url,
            "retrieved_at": got.retrieved_at, "cached": got.cached}


def _body_html(page: str) -> str | None:
    """Inner HTML of the Drupal body field, found by <div> depth (content often
    nests divs/tables, so a fixed number of closers would cut it short)."""
    start = page.find("field-name-body")
    if start < 0:
        return None
    open_at = page.rfind("<div", 0, start)
    if open_at < 0:
        return None
    depth = 0
    for m in re.finditer(r"<(/?)div\b[^>]*>", page[open_at:], re.I):
        depth += -1 if m.group(1) else 1
        if depth == 0:
            return page[open_at: open_at + m.end()]
    return page[open_at:]


def _pdf_text(fetcher: LiveFetcher, url: str) -> tuple[str, bool, object]:
    import pymupdf

    def valid(f) -> None:
        if not f.body.startswith(b"%PDF"):
            raise SourceError("The attached file is not a PDF.")

    got = fetcher.fetch(url, ttl=TTL_PAGE, validate=valid)
    if len(got.body) > MAX_PDF_BYTES:
        raise SourceError("The decision PDF is too large to read here; open it in a browser.")
    try:
        with pymupdf.open(stream=got.body, filetype="pdf") as doc:
            if doc.needs_pass or doc.is_encrypted:
                raise SourceError("The attached PDF is encrypted.")
            if doc.page_count > MAX_PDF_PAGES:
                raise SourceError(f"The attached PDF has {doc.page_count} pages; open it in a browser.")
            parts, size = [], 0
            for p in doc:
                t = p.get_text()
                parts.append(t)
                size += len(t)
                if size > MAX_PDF_CHARS:
                    break
    except SourceError:
        raise
    except Exception as e:  # noqa: BLE001 — malformed PDF (FileDataError, RuntimeError …)
        raise SourceError("The attached PDF could not be read.") from e
    text = "\n".join(parts)
    if not text.strip():
        raise SourceError("The PDF has no text layer (likely a scan); open it in a browser.")
    return text[:MAX_PDF_CHARS], size > MAX_PDF_CHARS, got


def document(fetcher: LiveFetcher, url: str, with_pdf: bool = True) -> dict:
    target = _check_url(url)
    if urlparse(target).path.lower().endswith(".pdf"):
        text, trunc, got = _pdf_text(fetcher, target)
        return {"url": target, "title": None, "decision_number": _decision_no(text[:3000]),
                "text": text, "truncated": trunc, "pdfs": [target],
                "retrieved_at": got.retrieved_at, "cached": got.cached}
    got = fetcher.fetch(target, ttl=TTL_PAGE, validate=_valid_html)
    page = got.text()
    title_m = _TITLE.search(page)
    title = _plain(title_m.group(1)) if title_m else None
    body = _body_html(page)
    text = _plain(body) if body else ""
    pdfs = []
    for h in dict.fromkeys(_FILE.findall(body or "")):  # only links inside the decision body
        try:  # same strict check as tool input: https, exact host, allowed path
            pdfs.append(_check_url(urljoin(BASE, html_lib.unescape(h))))
        except SourceError:
            continue
    out = {
        "url": target,
        "title": title,
        # prefer the page's own number (title / first paragraph) over later citations
        "decision_number": _decision_no(title or "", text[:600], text),
        "text": text,
        "pdfs": pdfs,
        "retrieved_at": got.retrieved_at,
        "cached": got.cached,
    }
    if body is None:
        out["body_not_found"] = True
    if with_pdf and pdfs:
        try:
            out["pdf_text"], out["pdf_truncated"], _ = _pdf_text(fetcher, pdfs[0])
            out["pdf_url"] = pdfs[0]
        except SourceError as e:
            out["pdf_error"] = str(e)
    return out
