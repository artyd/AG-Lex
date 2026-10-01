"""MCP stage 3b: Supreme Court legal positions, ECHR digest, Constitutional Court, EU law.

Upstream shapes mirror real responses captured on 2026-09-30 (trimmed,
content shortened); all traffic here is mocked.
"""
from __future__ import annotations

import json
from urllib.parse import parse_qs, unquote, urlparse

import httpx
import pymupdf
import pytest

from backend import mcp_live_tools
from backend.live_sources import ccu, eurlex, supreme
from backend.live_sources.fetcher import HostPolicy, LiveFetcher
from tests.test_mcp import (  # noqa: F401 — fixtures
    CHATGPT_REDIRECT,
    _call,
    _connect,
    _init,
    client,
    db_conn,
    seeded,
)

POSITION = {
    "id": 12464,
    "title": "Визначення меж зменшення розміру процентів річних, передбачених ст. 625 ЦК України",
    "text": "<p>Розмір процентів річних, який становить три проценти річних, не підлягає зменшенню судом.&nbsp;</p>"
            "<p><strong>ВП ВС конкретизувала власний правовий висновок.</strong></p>",
    "approvedAt": "2025-07-21T11:32:26.457Z",
    "categories": [{"id": 1887, "title": "Спори щодо зменшення відповідальності за ст. 625 ЦК"}],
    "documents": [{"id": 48374, "title": "Постанова", "doc_id": 128845028, "caseNumber": "903/602/24",
                   "adjudication_date": "2025-07-02"}],
    "documentEchrs": [],
    "link": "https://lpd.court.gov.ua/legal-position/12464",
}
ECHR = {"data": [
    {"id": 75, "case_num": " 21180/15", "title": "SPIVAK v. Ukraine",
     "description": "Неможливість оскарження законності примусового психіатричного лікування – порушення",
     "doc_url": "https://hudoc.echr.coe.int/?i=001-243367", "adjudication_date": "2025-06-04T21:00:00.000Z"},
    {"id": 72, "case_num": "30814/22", "title": "MARTINEZ FERNANDEZ v. Hungary",
     "description": "Примусова госпіталізація літньої жінки з деменцією – порушення",
     "doc_url": "https://hudoc.echr.coe.int/?i=001-243100", "adjudication_date": "2025-05-26T21:00:00.000Z"},
]}
CCU_SEARCH = """<html><body><h2>Результати пошуку</h2><ol class="search-results node-results">
<li class="search-result"><h3 class="title"><a href="https://ccu.gov.ua/novyna/sud-vyznav-nekonstytuciynymy">
Конституційний Суд визнав неконституційними приписи Сімейного кодексу (Рішення № 7-р(II)/2024)</a></h3>
<div class="search-snippet-info"><p class="search-snippet">... заробітна плата, <strong>пенсія</strong>, доходи ...</p>
<p class="search-info"><span class="username">press</span> - 06.11.2024 - 14:33</p></div></li>
</ol></body></html>"""
CCU_PAGE = """<html><head><title>x</title></head><body><h1 class="page-header">Конституційний Суд визнав неконституційними приписи</h1>
<div class="field field-name-body field-type-text-with-summary field-label-hidden"><div class="field-items"><div class="field-item even">
<p>Велика палата Конституційного Суду України 29 жовтня 2024 року ухвалила Рішення № 7-р(II)/2024 у справі щодо статті 75 Сімейного кодексу.</p>
<p><a href="/sites/default/files/7_r_2024.pdf">Текст рішення</a></p>
</div></div></div></body></html>"""
XHTML = """<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>GDPR</title></head><body>
<p>REGULATION (EU) 2016/679 OF THE EUROPEAN PARLIAMENT AND OF THE COUNCIL</p>
<p class="ti-art">Article 5</p><p>Principles relating to processing of personal data</p><p>1. Personal data shall be processed lawfully.</p>
<p class="ti-art">Article 6</p><p>Lawfulness of processing</p><p>1. Processing shall be lawful only if the data subject has given consent.</p>
</body></html>"""


def _pdf_bytes(text: str) -> bytes:
    doc = pymupdf.open()
    page = doc.new_page()
    page.insert_text((72, 72), text)
    data = doc.tobytes()
    doc.close()
    return data


def handler(seen: list | None = None):
    pdf = _pdf_bytes("Constitutional Court decision 7-r(II)/2024 text")

    def h(req: httpx.Request) -> httpx.Response:
        if seen is not None:
            seen.append(req)
        host, path = req.url.host, req.url.path
        if host == supreme.HOST:
            if path.endswith("/search/text"):
                body = json.loads(req.content)
                assert body["aiEnabled"] is False and body["query"]
                return httpx.Response(200, json=[POSITION])
            if path.endswith("/legal-position/12464"):
                return httpx.Response(200, json=POSITION)
            if path.endswith("/document-echr/list"):
                assert json.loads(req.content)["pager"]["page"] == 1
                return httpx.Response(200, json=ECHR)
        if host == ccu.HOST:
            if path.startswith("/search/node/"):
                return httpx.Response(200, text=CCU_SEARCH, headers={"content-type": "text/html; charset=utf-8"})
            if path == "/novyna/sud-vyznav-nekonstytuciynymy":
                return httpx.Response(200, text=CCU_PAGE, headers={"content-type": "text/html; charset=utf-8"})
            if path == "/sites/default/files/7_r_2024.pdf":
                return httpx.Response(200, content=pdf, headers={"content-type": "application/pdf"})
        if host == eurlex.HOST:
            if path == "/resource/celex/32016R0679":
                # CELLAR answers with a 303 to a plain-http manifestation URL
                return httpx.Response(303, headers={"location": "http://publications.europa.eu/resource/cellar/abc.0006.03/DOC_1"})
            if path == "/resource/cellar/abc.0006.03/DOC_1":
                assert req.url.scheme == "https"  # upgraded
                return httpx.Response(200, text=XHTML, headers={"content-type": "application/xhtml+xml;charset=UTF-8"})
            if path == "/webapi/rdf/sparql":
                q = unquote(parse_qs(urlparse(str(req.url)).query)["query"][0])
                assert "bif:contains '\"data\" AND \"protection\"" in q
                # user text only ever appears as lower-cased, quoted plain words
                expr_line = q.split("bif:contains", 1)[1].splitlines()[0]
                assert "DROP" not in q and "}" not in expr_line and ";" not in expr_line
                return httpx.Response(200, json={"results": {"bindings": [
                    {"celex": {"value": "32016R0679"}, "title": {"value": "Regulation (EU) 2016/679 (GDPR)"},
                     "date": {"value": "2016-04-27"}}]}})
        return httpx.Response(404)
    return h


def _fetcher(seen=None) -> LiveFetcher:
    return LiveFetcher(
        cache_path=":memory:",
        policies={supreme.HOST: supreme.LPD_POLICY, ccu.HOST: ccu.CCU_POLICY, eurlex.HOST: eurlex.CELLAR_POLICY,
                  "*": HostPolicy()},
        transport=httpx.MockTransport(handler(seen)),
        sleep=lambda s: None,
    )


# ---------------------------------------------------------------------------
# adapters
# ---------------------------------------------------------------------------

def test_supreme_positions():
    f = _fetcher()
    s = supreme.search(f, "три проценти річних")
    p = s["positions"][0]
    assert p["id"] == 12464 and "не підлягає зменшенню" in p["text"]
    assert p["decisions"][0] == {"title": "Постанова", "case_number": "903/602/24", "adjudication_date": "2025-07-02",
                                 "reyestr_id": "128845028", "reyestr_url": "https://reyestr.court.gov.ua/Review/128845028"}
    full = supreme.position(f, "12464")
    assert "ВП ВС конкретизувала" in full["text"] and "<p>" not in full["text"]
    with pytest.raises(Exception):
        supreme.position(f, "../x")


def test_echr_digest_filter():
    r = supreme.echr_digest(_fetcher(), "ukraine")
    assert [c["title"] for c in r["cases"]] == ["SPIVAK v. Ukraine"]
    assert r["cases"][0]["application_no"] == "21180/15" and r["cases"][0]["hudoc_url"].startswith("https://hudoc")


def test_ccu_search_and_document_with_pdf():
    f = _fetcher()
    s = ccu.search(f, "пенсія")
    r = s["results"][0]
    assert r["decision_number"] == "7-р(II)/2024" and r["date"] == "06.11.2024"
    d = ccu.document(f, r["url"])
    assert "Сімейного кодексу" in d["text"] and d["decision_number"] == "7-р(II)/2024"
    assert d["pdf_url"].endswith("/7_r_2024.pdf") and "7-r(II)/2024" in d["pdf_text"]
    for bad in ("https://evil.example/novyna/x", "http://ccu.gov.ua/novyna/x", "https://ccu.gov.ua/user/login"):
        with pytest.raises(Exception):
            ccu.document(f, bad)


def test_eurlex_act_search_and_redirect_upgrade():
    f = _fetcher()
    a = eurlex.act(f, "CELEX:32016r0679")
    arts = eurlex.split_articles(a["text"])
    assert set(arts) == {"5", "6"} and "consent" in arts["6"]
    assert a["source_url"].endswith("CELEX:32016R0679")
    s = eurlex.search(f, "Data protection; DROP'} evil")
    assert s["acts"][0]["celex"] == "32016R0679"
    with pytest.raises(Exception):
        eurlex.act(f, "not-a-celex")


# ---------------------------------------------------------------------------
# MCP tools
# ---------------------------------------------------------------------------

@pytest.fixture
def sources():
    mcp_live_tools.set_fetcher(_fetcher())
    yield
    mcp_live_tools.set_fetcher(None)


def _ok(client, at, name, args=None):
    result, text = _call(client, at, name, args)
    assert not result.get("isError"), text
    return json.loads(text)


def test_source_tools_via_mcp(client, seeded, sources):
    _, tok, _, _ = _connect(client, redirect=CHATGPT_REDIRECT)  # public law → allowed for ChatGPT too
    at = tok["access_token"]
    _init(client, at)
    assert _ok(client, at, "ua_sc_legal_positions", {"query": "три проценти річних"})["positions"][0]["id"] == 12464
    assert "notice" in _ok(client, at, "ua_sc_legal_position", {"position_id": "12464"})
    assert _ok(client, at, "echr_cases", {"query": "Ukraine"})["cases"][0]["title"] == "SPIVAK v. Ukraine"
    url = _ok(client, at, "ua_ccu_search", {"query": "пенсія"})["results"][0]["url"]
    assert "7-r(II)/2024" in _ok(client, at, "ua_ccu_document", {"url": url})["pdf_text"]
    assert _ok(client, at, "eu_search_legislation", {"query": "data protection"})["acts"][0]["celex"] == "32016R0679"
    art = _ok(client, at, "eu_get_act", {"celex": "32016R0679", "article": "Art. 6"})
    assert art["article"] == "6" and "consent" in art["text"]



def test_ccu_ignores_foreign_pdf_links_and_caps_pages(monkeypatch):
    evil_page = CCU_PAGE.replace("/sites/default/files/7_r_2024.pdf", "https://evilccu.gov.ua/sites/default/files/x.pdf")
    seen: list = []

    def h(req):
        seen.append(req)
        if req.url.path == "/novyna/sud-vyznav-nekonstytuciynymy":
            return httpx.Response(200, text=evil_page, headers={"content-type": "text/html; charset=utf-8"})
        return httpx.Response(404)
    f = LiveFetcher(cache_path=":memory:", policies={ccu.HOST: ccu.CCU_POLICY},
                    transport=httpx.MockTransport(h), sleep=lambda s: None)
    d = ccu.document(f, "https://ccu.gov.ua/novyna/sud-vyznav-nekonstytuciynymy")
    assert d["pdfs"] == [] and all(r.url.host == ccu.HOST for r in seen)

    monkeypatch.setattr(ccu, "MAX_PDF_PAGES", 0)
    with pytest.raises(Exception, match="pages"):
        ccu.document(_fetcher(), "https://ccu.gov.ua/sites/default/files/7_r_2024.pdf")



def _html_fetcher(pages: dict, policy_host=ccu.HOST, policy=ccu.CCU_POLICY):
    def h(req):
        body = pages.get(req.url.path)
        if body is None:
            return httpx.Response(404)
        if isinstance(body, (dict, list)):
            return httpx.Response(200, json=body)
        return httpx.Response(200, text=body, headers={"content-type": "text/html; charset=utf-8"})
    return LiveFetcher(cache_path=":memory:", policies={policy_host: policy},
                       transport=httpx.MockTransport(h), sleep=lambda s: None)


def test_ccu_search_results_do_not_borrow_neighbours():
    page = """<html><body><ol class="search-results">
<li class="search-result"><h3 class="title"><a href="https://ccu.gov.ua/novyna/a">Перший (без сніпета і дати)</a></h3></li>
<li class="search-result"><h3 class="title"><a href="https://ccu.gov.ua/novyna/b">Другий — Рішення № 3–РП/2016</a></h3>
<div class="search-snippet-info"><p class="search-snippet">текст другого</p>
<p class="search-info">press - 01.02.2016 - 10:00</p></div></li>
<li class="search-result"><h3 class="title"><a href="https://evil.example/x">Чужий</a></h3></li>
</ol></body></html>"""
    f = _html_fetcher({"/search/node/тест": page})
    res = ccu.search(f, "тест")["results"]
    assert [r["url"] for r in res] == ["https://ccu.gov.ua/novyna/a", "https://ccu.gov.ua/novyna/b"]
    assert res[0]["snippet"] == "" and res[0]["date"] is None
    assert res[1]["date"] == "01.02.2016" and res[1]["decision_number"] == "3-РП/2016"


def test_ccu_body_with_nested_divs_is_complete():
    page = """<html><body><h1>Рішення № 2-р(I)/2025</h1>
<div class="field field-name-body"><div class="field-items"><div class="field-item even">
<p>Перший абзац.</p><div class="rteleft"><div><div><p>Вкладений блок.</p></div></div></div>
<p>Останній абзац.</p><p><a href="/sites/default/files/2_r_2025.PDF?v=2">PDF</a></p>
</div></div></div>
<footer><a href="/sites/default/files/footer.pdf">footer</a></footer></body></html>"""
    d = ccu.document(_html_fetcher({"/novyna/x": page}), "https://ccu.gov.ua/novyna/x", with_pdf=False)
    assert "Останній абзац." in d["text"] and "Вкладений блок." in d["text"]
    assert d["pdfs"] == ["https://ccu.gov.ua/sites/default/files/2_r_2025.PDF"]  # body only, not the footer
    assert d["decision_number"] == "2-р(I)/2025"


def test_echr_digest_walks_pages(monkeypatch):
    monkeypatch.setattr(supreme, "ECHR_PAGE_SIZE", 2)
    pages = {1: [{"title": "A v. France"}, {"title": "B v. Italy"}],
             2: [{"title": "C v. Ukraine", "case_num": "1/20"}, {"title": "D v. Spain"}],
             3: [{"title": "E v. Ukraine"}]}

    def h(req):
        page = json.loads(req.content)["pager"]["page"]
        return httpx.Response(200, json={"data": pages.get(page, [])})
    f = LiveFetcher(cache_path=":memory:", policies={supreme.HOST: supreme.LPD_POLICY},
                    transport=httpx.MockTransport(h), sleep=lambda s: None)
    r = supreme.echr_digest(f, "ukraine", limit=10)
    assert [c["title"] for c in r["cases"]] == ["C v. Ukraine", "E v. Ukraine"]
    assert r["complete"] is True and r["pages_scanned"] == 3
