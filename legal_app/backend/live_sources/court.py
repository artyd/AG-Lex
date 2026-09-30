"""reyestr.court.gov.ua — a court decision by its registry id.

Only direct `/Review/{id}` pages: registry search sits behind a captcha and
we do not bypass it. Party names are already anonymised by the registry
(ОСОБА_1, АДРЕСА_1 …).
"""
from __future__ import annotations

import html as html_lib
import re

from .fetcher import HostPolicy, LiveFetcher, SourceError

HOST = "reyestr.court.gov.ua"
BASE = f"https://{HOST}"

COURT_POLICY = HostPolicy(
    min_interval=3.0,
    max_wait=25.0,
    daily_bytes=100 * 1024 * 1024,
    block_cooldown=30 * 60.0,
    block_markers=("Доступ заборонено",),
)

TTL_DECISION = 7 * 24 * 3600.0
MAX_PAGE = 2 * 1024 * 1024

_ID = re.compile(r"^\d{4,12}$")
_TXT = re.compile(r'<textarea[^>]*id="txtdepository"[^>]*>(.*?)</textarea>', re.S | re.I)
_CASE_NO = re.compile(r'name="CaseNumber"\s+value="([^"]{1,60})"', re.I)
_CATEGORY = re.compile(r"</form>\s*:\s*(.*?)</b>", re.S | re.I)
_PROC_NO = re.compile(r"Номер судового провадження:\s*<b>([^<]{1,60})</b>", re.I)


def _plain(fragment: str) -> str:
    fragment = re.sub(r"<script.*?</script>|<style.*?</style>|<head.*?</head>", " ", fragment, flags=re.S | re.I)
    fragment = re.sub(r"<(br|/p|/div|/tr)\b[^>]*>", "\n", fragment, flags=re.I)
    text = html_lib.unescape(re.sub(r"<[^>]+>", " ", fragment)).replace("\xa0", " ")
    lines = [re.sub(r"[ \t]+", " ", ln).strip() for ln in text.split("\n")]
    return "\n".join(ln for ln in lines if ln)


def _field(text: str, label: str) -> str | None:
    m = re.search(re.escape(label) + r"\s*:?\s*([0-9]{2}\.[0-9]{2}\.[0-9]{4})", text)
    return m.group(1) if m else None


def _valid_page(f) -> None:
    """Cache only real decision pages — never a captcha / maintenance page."""
    if not _TXT.search(f.text()[:MAX_PAGE]):
        raise SourceError(
            f"The registry did not return the decision text (access limited or captcha). Open {f.url} in a browser."
        )


def decision(fetcher: LiveFetcher, decision_id: str) -> dict:
    did = decision_id.strip()
    if not _ID.match(did):
        raise SourceError("decision_id must be the numeric id from reyestr.court.gov.ua/Review/<id>.")
    url = f"{BASE}/Review/{did}"
    got = fetcher.fetch(url, ttl=TTL_DECISION, validate=_valid_page)
    page = got.text()[:MAX_PAGE]

    body_m = _TXT.search(page)
    if not body_m:
        # The registry falls back to a captcha when it suspects automation;
        # we never try to solve it — the lawyer opens the link instead.
        raise SourceError(
            f"The registry did not return the decision text (access limited or captcha). Open {url} in a browser."
        )
    # The textarea holds the decision's HTML verbatim; _plain unescapes once.
    text = _plain(body_m.group(1))

    case_no = _CASE_NO.search(page)
    category = _CATEGORY.search(page)
    proc_no = _PROC_NO.search(page)
    page_plain = _plain(page[: body_m.start()])
    return {
        "decision_id": did,
        "case_number": html_lib.unescape(case_no.group(1)) if case_no else None,
        "proceeding_number": html_lib.unescape(proc_no.group(1)).strip() if proc_no else None,
        "category": _plain(category.group(1))[:600] if category else None,
        "sent_by_court": _field(page_plain, "Надіслано судом"),
        "registered": _field(page_plain, "Зареєстровано"),
        "in_force_since": _field(page_plain, "Дата набрання законної сили"),
        "text": text,
        "source_url": url,
        "retrieved_at": got.retrieved_at,
        "cached": got.cached,
    }
