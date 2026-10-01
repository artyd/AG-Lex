"""EU law via the Publications Office CELLAR (the store behind EUR-Lex).

eur-lex.europa.eu itself answers bots with an empty 202 JS challenge, so we
use the official open endpoints instead:

- act(celex)   GET publications.europa.eu/resource/celex/{CELEX}
               (Accept XHTML, Accept-Language eng) → 303 to the manifestation
- search(q)    SPARQL on publications.europa.eu/webapi/rdf/sparql — English
               titles of legislation (CELEX sector 3) containing all words

EUR-Lex has no Ukrainian language version; texts are returned in English.
"""
from __future__ import annotations

import json
import re
from urllib.parse import quote

from .fetcher import HostPolicy, LiveFetcher, SourceError

HOST = "publications.europa.eu"
CELLAR_POLICY = HostPolicy(min_interval=2.0, max_wait=20.0, daily_bytes=200 * 1024 * 1024)
SPARQL = f"https://{HOST}/webapi/rdf/sparql"

TTL_ACT = 7 * 24 * 3600.0
TTL_SEARCH = 24 * 3600.0

_CELEX = re.compile(r"^[0-9CE][0-9]{4}[A-Z]{1,2}[0-9]{4}(?:\([0-9]{1,2}\))?(?:R\([0-9]{1,2}\))?$")
_WORD = re.compile(r"[0-9A-Za-zÀ-ÿ][0-9A-Za-zÀ-ÿ\-]{1,39}")
# Virtuoso's full-text index rejects/ignores noise words; drop them up front.
_STOP = {"the", "of", "and", "or", "on", "in", "for", "to", "a", "an", "by", "with", "at", "as", "is", "be", "eu"}
_ART_HEAD = re.compile(r"^\s*Article\s+(\d+[a-zA-Z]?)\s*$", re.M)


def public_url(celex: str) -> str:
    return f"https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:{celex}"


def check_celex(celex: str) -> str:
    c = celex.strip().upper().replace("CELEX:", "")
    if not _CELEX.match(c):
        raise SourceError("celex must look like 32016R0679 (GDPR) or 32019L1937.")
    return c


def _plain(xhtml: str) -> str:
    s = re.sub(r"<script.*?</script>|<style.*?</style>|<head.*?</head>", " ", xhtml, flags=re.S | re.I)
    s = re.sub(r"<(br|/p|/div|/tr|/li|/h\d|/td)\b[^>]*>", "\n", s, flags=re.I)
    import html as html_lib
    s = html_lib.unescape(re.sub(r"<[^>]+>", " ", s)).replace("\xa0", " ")
    return "\n".join(" ".join(ln.split()) for ln in s.split("\n") if ln.strip())


def split_articles(text: str) -> dict[str, str]:
    """{"6": "Article 6 …"}. A number seen twice (TOC, quoted amendments,
    annexes) keeps the longest body — the enacting text, not a stub."""
    heads = list(_ART_HEAD.finditer(text))
    out: dict[str, str] = {}
    for i, m in enumerate(heads):
        end = heads[i + 1].start() if i + 1 < len(heads) else len(text)
        body = text[m.start():end].strip()
        key = m.group(1).lower()
        if len(body) > len(out.get(key, "")):
            out[key] = body
    return out


def _valid_xhtml(f) -> None:
    head = f.body[:4000].lower()
    if b"<html" not in head and b"<?xml" not in head:
        raise SourceError("CELLAR did not return an XHTML text for this act (try another CELEX).")


def act(fetcher: LiveFetcher, celex: str) -> dict:
    c = check_celex(celex)
    got = fetcher.fetch(
        f"https://{HOST}/resource/celex/{quote(c, safe='()')}", ttl=TTL_ACT, validate=_valid_xhtml,
        headers={"Accept": "application/xhtml+xml, text/html;q=0.9", "Accept-Language": "eng"},
    )
    text = _plain(got.text())
    return {"celex": c, "text": text, "source_url": public_url(c), "retrieved_at": got.retrieved_at,
            "cached": got.cached, "language": "EN"}


def search(fetcher: LiveFetcher, query: str, limit: int = 10) -> dict:
    words = [w.lower() for w in _WORD.findall(query) if w.lower() not in _STOP][:6]
    if not words:
        raise SourceError("query must contain English words, e.g. 'data protection'.")
    n = max(1, min(25, int(limit)))
    # Virtuoso full-text index (bif:contains) answers in < 1 s; CONTAINS()
    # filters scan every title and hit the endpoint's 60 s timeout. Words are
    # restricted to letters/digits/hyphen by _WORD, so they can't break out
    # of the quoted expression.
    expr = " AND ".join(f'"{w}"' for w in words)
    q = f"""PREFIX cdm: <http://publications.europa.eu/ontology/cdm#>
SELECT DISTINCT ?celex ?title ?date WHERE {{
  ?expr cdm:expression_title ?title ;
        cdm:expression_uses_language <http://publications.europa.eu/resource/authority/language/ENG> ;
        cdm:expression_belongs_to_work ?work .
  ?title bif:contains '{expr}' .
  ?work cdm:resource_legal_id_celex ?celex ;
        cdm:work_date_document ?date .
  FILTER(STRSTARTS(STR(?celex), "3"))
}} ORDER BY DESC(?date) LIMIT {n}"""
    url = f"{SPARQL}?query={quote(q)}&format={quote('application/sparql-results+json')}"

    def valid(f) -> None:
        try:
            json.loads(f.text())["results"]["bindings"]
        except (ValueError, KeyError, TypeError) as e:
            raise SourceError("The EU SPARQL endpoint answered in an unexpected format.") from e

    try:
        got = fetcher.fetch(url, ttl=TTL_SEARCH, validate=valid, headers={"Accept": "application/sparql-results+json"})
    except SourceError as e:
        if "answered HTTP" in str(e):
            raise SourceError("The EU search did not accept this query; try fewer, simpler English keywords.") from e
        raise
    rows = json.loads(got.text())["results"]["bindings"]
    acts, seen = [], set()
    for r in rows:
        celex = (r.get("celex") or {}).get("value")
        if not celex or celex in seen:  # DISTINCT on title can repeat an act
            continue
        seen.add(celex)
        acts.append({"celex": celex, "title": (r.get("title") or {}).get("value"),
                     "date": (r.get("date") or {}).get("value"), "url": public_url(celex)})
    return {"query": " ".join(words), "acts": acts, "source": "EU Publications Office (CELLAR)",
            "retrieved_at": got.retrieved_at, "cached": got.cached}
