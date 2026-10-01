"""zakon.rada.gov.ua via the official open-data endpoints (data.rada.gov.ua).

Endpoints (User-Agent "OpenData" per the portal's API terms):
  text            {base}/laws/show/{nreg}.txt
  text as of date {base}/laws/show/{nreg}/ed{YYYYMMDD}.txt
  card            {base}/laws/card/{nreg}.json
  new documents   {base}{recent_path}

The human-facing links we return point to zakon.rada.gov.ua so lawyers can
open the same act in a browser.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import date
from urllib.parse import quote

from .fetcher import Fetched, HostPolicy, LiveFetcher, SourceError

DATA_HOST = "data.rada.gov.ua"
PUBLIC_BASE = "https://zakon.rada.gov.ua"

RADA_POLICY = HostPolicy(
    min_interval=6.0,              # portal asks for 5–7 s pauses, ≤ 60/min
    max_wait=25.0,
    daily_bytes=150 * 1024 * 1024,  # of the 200 MB/day allowance
    block_cooldown=30 * 60.0,
    user_agent="OpenData",
    block_markers=("Доступ заборонено", "тимчасово заблокувала", "DDoS"),
)

TTL_TEXT = 24 * 3600.0
TTL_CARD = 24 * 3600.0
TTL_RECENT = 3600.0

_NREG = re.compile(r"^[0-9A-Za-zА-Яа-яІіЇїЄєҐґ_./\-]{2,40}$")
# "Стаття 625. Назва" (codes) and "Стаття 55" with no period (Constitution);
# rada text often uses NBSP between the word and the number.
_ARTICLE_HEAD = re.compile(r"^[ \t\xa0]*Стаття[ \t\xa0]+(\d+(?:-\d+)?)[ \t\xa0]*(?:\.|$)", re.M)
# Structural headings that end an article (else the last article of a chapter
# swallows the next heading, and the final one the transitional provisions).
_SECTION_HEAD = re.compile(
    r"^[ \t\xa0]*(?:Розділ|РОЗДІЛ|Глава|ГЛАВА|Книга|КНИГА|Прикінцеві|ПРИКІНЦЕВІ|Перехідні|ПЕРЕХІДНІ)\b", re.M
)
MIN_DATE = date(1991, 8, 24)


def check_nreg(nreg: str) -> str:
    n = nreg.strip()
    if not _NREG.match(n) or ".." in n:
        raise SourceError("nreg must look like 435-15 or 254к/96-вр (the act id from zakon.rada.gov.ua).")
    return n


def check_date(as_of: str) -> str:
    try:
        d = date.fromisoformat(as_of)
    except ValueError as e:
        raise SourceError("as_of must be YYYY-MM-DD") from e
    if not (MIN_DATE <= d <= date.today()):
        raise SourceError("as_of must be between 1991-08-24 and today.")
    return d.strftime("%Y%m%d")


def public_url(nreg: str, as_of: str = "") -> str:
    ed = f"/ed{check_date(as_of)}" if as_of else ""
    return f"{PUBLIC_BASE}/laws/show/{quote(nreg, safe='/-')}{ed}"


@dataclass
class ActText:
    nreg: str
    text: str
    as_of: str
    source_url: str
    retrieved_at: str
    cached: bool


class RadaClient:
    def __init__(self, fetcher: LiveFetcher, *, base: str = f"https://{DATA_HOST}", recent_path: str = "/laws/main/r.json"):
        self.f = fetcher
        self.base = base.rstrip("/")
        self.recent_path = recent_path

    def _get(self, path: str, ttl: float, validate=None) -> Fetched:
        return self.f.fetch(self.base + path, ttl=ttl, validate=validate)

    def act_text(self, nreg: str, as_of: str = "") -> ActText:
        n = check_nreg(nreg)
        ed = f"/ed{check_date(as_of)}" if as_of else ""
        got = self._get(f"/laws/show/{quote(n, safe='/-')}{ed}.txt", TTL_TEXT, validate=_valid_text)
        text = got.text(fallback_encoding="cp1251").replace("\r\n", "\n")
        return ActText(nreg=n, text=text, as_of=as_of, source_url=public_url(n, as_of),
                       retrieved_at=got.retrieved_at, cached=got.cached)

    def card(self, nreg: str) -> dict:
        n = check_nreg(nreg)
        got = self._get(f"/laws/card/{quote(n, safe='/-')}.json", TTL_CARD, validate=_valid_json)
        data = json.loads(got.text())
        return {"nreg": n, "card": _trim(data), "source_url": f"{PUBLIC_BASE}/laws/card/{quote(n, safe='/-')}",
                "retrieved_at": got.retrieved_at, "cached": got.cached}

    def recent(self) -> dict:
        got = self._get(self.recent_path, TTL_RECENT, validate=_valid_recent)
        raw = got.text()
        try:
            items = _find_list(json.loads(raw))
        except json.JSONDecodeError:
            items = [{"line": ln.strip()} for ln in raw.splitlines() if ln.strip()]
        return {"items": items, "source_url": f"{PUBLIC_BASE}/laws/main/n",
                "retrieved_at": got.retrieved_at, "cached": got.cached}


def split_articles(text: str) -> dict[str, str]:
    """{"625": "Стаття 625. …"} — article headings at line start; an article
    ends at the next article or structural heading (Розділ/Глава/…)."""
    heads = list(_ARTICLE_HEAD.finditer(text))
    out: dict[str, str] = {}
    for i, m in enumerate(heads):
        end = heads[i + 1].start() if i + 1 < len(heads) else len(text)
        sec = _SECTION_HEAD.search(text, m.end(), end)
        if sec:
            end = sec.start()
        out.setdefault(m.group(1), text[m.start():end].strip())
    return out


def _looks_html(f: Fetched) -> bool:
    head = f.body[:512].lstrip().lower()
    return head.startswith(b"<!doctype") or head.startswith(b"<html")


def _valid_text(f: Fetched) -> None:
    if _looks_html(f) or len(f.text(fallback_encoding="cp1251").strip()) < 20:
        raise SourceError("The official source returned no act text (format may have changed).")


def _valid_json(f: Fetched) -> None:
    try:
        json.loads(f.text())
    except json.JSONDecodeError as e:
        raise SourceError("The official card is not valid JSON (format may have changed).") from e


def _valid_recent(f: Fetched) -> None:
    raw = f.text()
    if _looks_html(f):
        raise SourceError("The new-documents feed returned a web page, not data (format may have changed).")
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return  # plain-text list is accepted
    if not _find_list(data):
        raise SourceError("The new-documents feed has an unexpected format (RADA_RECENT_PATH may be wrong).")


def _find_list(data) -> list:
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        for v in data.values():
            if isinstance(v, list) and v and isinstance(v[0], dict):
                return v
    return []


def _trim(v, depth: int = 0):
    """Bound the card size handed to an LLM: shallow, short lists, short strings."""
    if depth > 3:
        return "…"
    if isinstance(v, dict):
        return {k: _trim(x, depth + 1) for k, x in list(v.items())[:60]}
    if isinstance(v, list):
        return [_trim(x, depth + 1) for x in v[:40]]
    if isinstance(v, str) and len(v) > 2000:
        return v[:2000] + "…"
    return v
