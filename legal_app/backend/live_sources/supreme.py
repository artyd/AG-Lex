"""Supreme Court legal positions (lpd.court.gov.ua) + its ECHR digest.

The Supreme Court's «База правових позицій» is a public, registration-free
service; its web app talks to a JSON backend at lpd-api-prod.court.gov.ua.
That backend is not a documented open API, so the adapter is defensive
(tolerant parsing, clear errors if the shape changes) and polite (≥ 3 s
between requests, cached).

- search(query)        POST /search/text {query, categoryArray, aiEnabled}
                       (no upstream limit: the whole hit list is downloaded,
                       then trimmed; very broad queries may exceed the body cap)
- position(id)         GET  /legal-position/{id}
- echr_digest(query)   POST /document-echr/list {pager, filter}, pages of 100
    The Court's curated ECHR case list: Ukrainian summary + HUDOC link. HUDOC
    itself sits behind a Cloudflare JS challenge we do not bypass.
"""
from __future__ import annotations

import html as html_lib
import json
import re

from .fetcher import HostPolicy, LiveFetcher, SourceError

HOST = "lpd-api-prod.court.gov.ua"
API = f"https://{HOST}/api/v1"
PUBLIC = "https://lpd.court.gov.ua"

LPD_POLICY = HostPolicy(min_interval=3.0, max_wait=20.0, daily_bytes=100 * 1024 * 1024)
_HEADERS = {"Accept": "application/json", "Origin": PUBLIC, "Referer": PUBLIC + "/"}

TTL_SEARCH = 6 * 3600.0
TTL_POSITION = 24 * 3600.0
TTL_ECHR = 24 * 3600.0
ECHR_PAGE_SIZE = 100
ECHR_MAX_PAGES = 10
REYESTR = "https://reyestr.court.gov.ua/Review/"
FORMAT_ERROR = "The Supreme Court database answered in an unexpected format (its web API may have changed)."


def _s(v) -> str:
    return "" if v is None else str(v)


def _plain(fragment: str | None) -> str:
    s = re.sub(r"<(br|/p|/li|/div|/h\d|/tr|/td)\b[^>]*>", "\n", fragment or "", flags=re.I)
    s = html_lib.unescape(re.sub(r"<[^>]+>", " ", s)).replace("\xa0", " ")
    return "\n".join(" ".join(ln.split()) for ln in s.split("\n") if ln.strip())


def _json(f) -> object:
    try:
        return json.loads(f.text())
    except ValueError as e:
        raise SourceError(FORMAT_ERROR) from e


def _valid_json(f) -> None:
    _json(f)


def _documents(docs) -> list[dict]:
    out = []
    for d in docs or []:
        if not isinstance(d, dict):
            continue
        rid = _s(d.get("doc_id")).strip()
        rid = rid if rid.isascii() and rid.isdigit() else ""
        out.append({
            "title": d.get("title"),
            "case_number": _s(d.get("caseNumber")).strip() or None,
            "adjudication_date": _s(d.get("adjudication_date"))[:10] or None,
            "reyestr_id": rid or None,
            "reyestr_url": f"{REYESTR}{rid}" if rid else None,
        })
    return out


def _position(p: dict, full: bool) -> dict:
    text = _plain(_s(p.get("text")))
    pid = _s(p.get("id")).strip()
    cats = []
    for c in p.get("categories") or []:
        if isinstance(c, dict) and c.get("title"):
            cats.append(_s(c["title"]))
        elif isinstance(c, str):
            cats.append(c)
    return {
        "id": int(pid) if pid.isdigit() else (pid or None),
        "title": _s(p.get("title")).strip(),
        "text": text if full else (text[:600] + ("…" if len(text) > 600 else "")),
        "categories": cats,
        "decisions": _documents(p.get("documents")),
        "echr": [{"title": e.get("title"), "case_num": _s(e.get("case_num")).strip(), "url": e.get("doc_url")}
                 for e in p.get("documentEchrs") or [] if isinstance(e, dict)],
        "approved_at": p.get("approvedAt"),
        "url": _s(p.get("link")) or (f"{PUBLIC}/legal-position/{pid}" if pid else None),
    }


def search(fetcher: LiveFetcher, query: str, limit: int = 10) -> dict:
    q = " ".join(query.split())[:300]
    if len(q) < 3:
        raise SourceError("query must be at least 3 characters.")
    got = fetcher.fetch(f"{API}/search/text", ttl=TTL_SEARCH, headers=_HEADERS, validate=_valid_json,
                        json_body={"query": q, "categoryArray": [], "aiEnabled": False})
    data = _json(got)
    if isinstance(data, dict):
        data = data.get("data") or data.get("items") or []
    if not isinstance(data, list):
        raise SourceError(FORMAT_ERROR)
    n = max(1, min(30, int(limit)))
    return {"query": q, "positions": [_position(p, full=False) for p in data[:n] if isinstance(p, dict)],
            "total": len(data), "source_url": f"{PUBLIC}/search", "retrieved_at": got.retrieved_at,
            "cached": got.cached}


def position(fetcher: LiveFetcher, position_id: str) -> dict:
    pid = str(position_id).strip()
    if not (pid.isascii() and pid.isdigit()) or len(pid) > 10:
        raise SourceError("position_id must be the numeric id from lpd.court.gov.ua/legal-position/<id>.")
    got = fetcher.fetch(f"{API}/legal-position/{pid}", ttl=TTL_POSITION, headers=_HEADERS, validate=_valid_json)
    data = _json(got)
    if not isinstance(data, dict) or "id" not in data:
        raise SourceError(f"Legal position {pid} not found.")
    return {**_position(data, full=True), "retrieved_at": got.retrieved_at, "cached": got.cached}


def _echr_page(fetcher: LiveFetcher, page: int):
    got = fetcher.fetch(f"{API}/document-echr/list", ttl=TTL_ECHR, headers=_HEADERS, validate=_valid_json,
                        json_body={"pager": {"page": page, "documentsOnPage": ECHR_PAGE_SIZE}, "filter": {}})
    data = _json(got)
    rows = data.get("data") if isinstance(data, dict) else data
    if not isinstance(rows, list):
        raise SourceError(FORMAT_ERROR)
    return rows, got


def echr_digest(fetcher: LiveFetcher, query: str = "", limit: int = 20) -> dict:
    """Walk the digest page by page (each page cached for a day) so a filter
    sees the whole list, not just the newest 100 cases."""
    q = query.strip().casefold()
    n = max(1, min(50, int(limit)))
    items: list[dict] = []
    pages = 0
    complete = False
    got = None
    for page in range(1, ECHR_MAX_PAGES + 1):
        rows, got = _echr_page(fetcher, page)
        pages += 1
        for r in rows:
            if not isinstance(r, dict):
                continue
            rec = {
                "title": _s(r.get("title")).strip(),
                "application_no": _s(r.get("case_num")).strip(),
                "judgment_date": _s(r.get("adjudication_date"))[:10] or None,
                "summary_uk": _s(r.get("description")).strip(),
                "hudoc_url": r.get("doc_url"),
            }
            if q and q not in f"{rec['title']} {rec['summary_uk']} {rec['application_no']}".casefold():
                continue
            items.append(rec)
        if len(rows) < ECHR_PAGE_SIZE:
            complete = True
            break
        if len(items) >= n:
            break
    return {"cases": items[:n], "matches": len(items), "pages_scanned": pages, "complete": complete,
            "source": "Верховний Суд — дайджест практики ЄСПЛ", "source_url": PUBLIC,
            "retrieved_at": got.retrieved_at if got else None, "cached": bool(got and got.cached),
            "note": "Full judgments are on HUDOC (links above); HUDOC blocks automated access, open them in a browser."}
