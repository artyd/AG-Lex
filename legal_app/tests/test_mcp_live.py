"""MCP stage 3: live official sources (fetcher, rada, court registry, citations)."""
from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest

from backend import mcp_live_tools
from backend.live_sources import citation as cit
from backend.live_sources.court import COURT_POLICY, decision
from backend.live_sources.fetcher import HostPolicy, LiveFetcher, SourceBlocked, SourceBusy, SourceNotFound
from backend.live_sources.rada import RADA_POLICY, RadaClient, split_articles
from tests.test_mcp import (  # noqa: F401 — fixtures
    CHATGPT_REDIRECT,
    _call,
    _connect,
    _init,
    client,
    db_conn,
    seeded,
)

FIXTURES = Path(__file__).parent / "fixtures"

CK_TEXT = (
    "ЦИВІЛЬНИЙ КОДЕКС УКРАЇНИ\n"
    "Стаття 16. Захист цивільних прав та інтересів судом\n"
    "1. Кожна особа має право звернутися до суду за захистом свого особистого немайнового або майнового права.\n"
    "Стаття 625. Відповідальність за порушення грошового зобов'язання\n"
    "1. Боржник не звільняється від відповідальності за неможливість виконання ним грошового зобов'язання.\n"
    "2. Боржник, який прострочив виконання грошового зобов'язання, на вимогу кредитора зобов'язаний сплатити "
    "суму боргу з урахуванням встановленого індексу інфляції за весь час прострочення, а також три проценти річних.\n"
)
CK_TEXT_2015 = CK_TEXT.replace("три проценти річних", "три відсотки річних")


class Clock:
    def __init__(self):
        self.t = 1000.0
        self.slept: list[float] = []

    def now(self):
        return self.t

    def sleep(self, s):
        self.slept.append(s)
        self.t += s


def _fetcher(handler, clock: Clock | None = None, policies=None) -> LiveFetcher:
    clock = clock or Clock()
    return LiveFetcher(
        cache_path=":memory:",
        policies=policies or {"data.rada.gov.ua": RADA_POLICY, "reyestr.court.gov.ua": COURT_POLICY, "*": HostPolicy()},
        transport=httpx.MockTransport(handler),
        clock=clock.now,
        sleep=clock.sleep,
    )


def rada_handler(seen: list | None = None):
    def h(req: httpx.Request) -> httpx.Response:
        if seen is not None:
            seen.append(req)
        path = req.url.path
        if path.endswith("/435-15.txt"):
            return httpx.Response(200, content=CK_TEXT.encode("cp1251"), headers={"content-type": "text/plain; charset=windows-1251"})
        if path.endswith("/435-15/ed20150101.txt"):
            return httpx.Response(200, content=CK_TEXT_2015.encode("utf-8"), headers={"content-type": "text/plain"})
        if path.endswith("/laws/card/435-15.json"):
            return httpx.Response(200, json={"nreg": "435-15", "status": "чинний", "nazva": "Цивільний кодекс України",
                                             "eds": [{"date": "2026-08-05"}]})
        if path.endswith("/laws/main/r.json"):
            return httpx.Response(200, json={"list": [{"nreg": "963/2026", "nazva": "Про призначення судді"},
                                                      {"nreg": "n0390500-26", "nazva": "Про облікову ціну банківських металів"}]})
        if path.startswith("/Review/"):
            return httpx.Response(200, content=(FIXTURES / "reyestr_review.html").read_bytes(),
                                  headers={"content-type": "text/html; charset=utf-8"})
        return httpx.Response(404)
    return h


# ---------------------------------------------------------------------------
# fetcher
# ---------------------------------------------------------------------------

def test_fetcher_throttles_per_host_and_caches():
    clock = Clock()
    seen: list = []
    f = _fetcher(rada_handler(seen), clock)
    f.fetch("https://data.rada.gov.ua/laws/show/435-15.txt", ttl=60)
    f.fetch("https://data.rada.gov.ua/laws/card/435-15.json", ttl=60)
    assert clock.slept and clock.slept[0] == pytest.approx(6.0)  # rada min interval
    f.fetch("https://data.rada.gov.ua/laws/show/435-15.txt", ttl=60)  # cache hit
    assert len(seen) == 2
    assert seen[0].headers["user-agent"] == "OpenData"


def test_fetcher_block_breaker_fails_fast():
    calls = []

    def h(req):
        calls.append(req)
        return httpx.Response(403, content="Доступ заборонено".encode("cp1251"))
    f = _fetcher(h)
    with pytest.raises(SourceBlocked):
        f.fetch("https://data.rada.gov.ua/laws/show/1-1.txt", ttl=60)
    with pytest.raises(SourceBlocked):
        f.fetch("https://data.rada.gov.ua/laws/show/2-2.txt", ttl=60)
    assert len(calls) == 1  # second call never hit the network


def test_fetcher_block_marker_on_200():
    f = _fetcher(lambda r: httpx.Response(200, content="Система захисту від DDoS-атак тимчасово заблокувала ваш IP".encode("cp1251")))
    with pytest.raises(SourceBlocked):
        f.fetch("https://data.rada.gov.ua/laws/show/1-1.txt", ttl=60)


def test_fetcher_busy_and_budget_and_404():
    clock = Clock()
    pol = HostPolicy(min_interval=100.0, max_wait=5.0, daily_bytes=60)
    f = _fetcher(lambda r: httpx.Response(200, content=b"x" * 50), clock, policies={"*": pol})
    f.fetch("https://example.gov.ua/a", ttl=0)
    with pytest.raises(SourceBusy):  # would need to wait 100 s > max_wait
        f.fetch("https://example.gov.ua/b", ttl=0)
    clock.t += 200
    with pytest.raises(SourceBusy):  # 50 declared bytes > 10 left of the 60-byte budget
        f.fetch("https://example.gov.ua/c", ttl=0)
    nf = _fetcher(lambda r: httpx.Response(404))
    with pytest.raises(SourceNotFound):
        nf.fetch("https://data.rada.gov.ua/laws/show/0-0.txt", ttl=0)


# ---------------------------------------------------------------------------
# adapters
# ---------------------------------------------------------------------------

def test_rada_text_edition_card_recent():
    seen: list = []
    r = RadaClient(_fetcher(rada_handler(seen)))
    act = r.act_text("435-15")
    assert "Стаття 625" in act.text  # cp1251 decoded
    assert act.source_url == "https://zakon.rada.gov.ua/laws/show/435-15"
    old = r.act_text("435-15", "2015-01-01")
    assert "три відсотки річних" in old.text
    assert old.source_url.endswith("/435-15/ed20150101")
    assert r.card("435-15")["card"]["status"] == "чинний"
    assert [i["nreg"] for i in r.recent()["items"]] == ["963/2026", "n0390500-26"]
    with pytest.raises(Exception):
        r.act_text("../etc/passwd")


def test_split_articles():
    arts = split_articles(CK_TEXT)
    assert set(arts) == {"16", "625"}
    assert arts["625"].startswith("Стаття 625.") and "Стаття 16" not in arts["625"]


def test_verify_citation_live():
    r = RadaClient(_fetcher(rada_handler()))
    ok = cit.verify(r, "ч. 2 ст. 625 ЦК України", "три проценти річних")
    assert ok["verdict"] == "ok" and ok["part"] == "2"
    old = cit.verify(r, "ст. 625 ЦК України", "три проценти річних", as_of="2015-01-01")
    assert old["verdict"] == "wording_differs" or old["verdict"] == "quote_not_in_article"
    missing = cit.verify(r, "ст. 9999 ЦК України")
    assert missing["verdict"] == "article_not_found"


def test_court_decision_fixture():
    d = decision(_fetcher(rada_handler()), "123456789")
    assert d["case_number"] == "910/1234/26"
    assert d["proceeding_number"] == "1234/26"
    assert d["in_force_since"] == "13.04.2026"
    assert "статті 625 ЦК України" in d["text"]
    assert "Єдиний державний реєстр" not in d["text"]  # <head>/<title> dropped
    with pytest.raises(Exception):
        decision(_fetcher(rada_handler()), "../../x")


def test_court_captcha_page_is_a_clear_error():
    f = _fetcher(lambda r: httpx.Response(200, content=b'<div id="modalcaptcha">captcha</div>',
                                          headers={"content-type": "text/html"}))
    with pytest.raises(Exception, match="captcha"):
        decision(f, "123456")


# ---------------------------------------------------------------------------
# MCP tools
# ---------------------------------------------------------------------------

@pytest.fixture
def live(monkeypatch):
    mcp_live_tools.set_fetcher(_fetcher(rada_handler()))
    yield
    mcp_live_tools.set_fetcher(None)


def _ok(client, at, name, args=None):
    result, text = _call(client, at, name, args)
    assert not result.get("isError"), text
    return json.loads(text)


def test_live_tools_available_to_chatgpt(client, seeded, live):
    _, tok, _, _ = _connect(client, redirect=CHATGPT_REDIRECT)
    at = tok["access_token"]
    _init(client, at)
    art = _ok(client, at, "ua_get_act", {"nreg": "435-15", "article": "625"})
    assert art["text"].startswith("Стаття 625.") and art["source_url"].startswith("https://zakon.rada.gov.ua/")
    v = _ok(client, at, "ua_verify_citation", {"citation": "ст. 625 ЦК України", "quote": "три проценти річних"})
    assert v["verdict"] == "ok"
    assert _ok(client, at, "ua_act_card", {"nreg": "435-15"})["card"]["status"] == "чинний"
    rc = _ok(client, at, "ua_recent_changes", {"query": "суд"})
    assert [i["nreg"] for i in rc["items"]] == ["963/2026"]
    d = _ok(client, at, "ua_court_decision", {"decision_id": "123456789"})
    assert d["case_number"] == "910/1234/26"


def test_verify_falls_back_to_local_codex(client, seeded, monkeypatch):
    mcp_live_tools.set_fetcher(_fetcher(lambda r: httpx.Response(403, content=b"blocked")))
    try:
        _, tok, _, _ = _connect(client)
        at = tok["access_token"]
        _init(client, at)
        v = _ok(client, at, "ua_verify_citation", {"citation": "ст. 625 ЦК України", "quote": "Боржник не звільняється"})
        assert v["source"] == "local codex" and v["quote_verdict"] == "exact" and "outdated" in v["warning"]
        assert v["verdict"] == "ok" and v["source_url"].startswith("https://zakon.rada.gov.ua/")
        result, text = _call(client, at, "ua_get_act", {"nreg": "435-15"})
        assert result.get("isError") and "refuses requests" in text  # breaker already open: no new request
    finally:
        mcp_live_tools.set_fetcher(None)


def test_live_sources_kill_switch(client, seeded, live, monkeypatch):
    from backend.config import get_settings
    monkeypatch.setattr(get_settings(), "LIVE_SOURCES_ENABLED", False)
    _, tok, _, _ = _connect(client)
    at = tok["access_token"]
    _init(client, at)
    result, text = _call(client, at, "ua_get_act", {"nreg": "435-15"})
    assert result.get("isError") and "disabled" in text


# ---------------------------------------------------------------------------
# review round (security-reviewer + code-reviewer)
# ---------------------------------------------------------------------------

def test_redirect_only_to_known_https_hosts():
    def h(req):
        if req.url.host == "data.rada.gov.ua":
            return httpx.Response(302, headers={"location": "http://169.254.169.254/latest/meta-data"})
        return httpx.Response(200, content=b"secret")
    with pytest.raises(Exception, match="redirected outside"):
        _fetcher(h).fetch("https://data.rada.gov.ua/laws/show/1-1.txt", ttl=60)


def test_body_cap_and_negative_cache(monkeypatch):
    import backend.live_sources.fetcher as fm
    monkeypatch.setattr(fm, "MAX_BODY", 100)
    with pytest.raises(SourceBusy, match="too large"):
        _fetcher(lambda r: httpx.Response(200, content=b"x" * 500)).fetch("https://data.rada.gov.ua/a", ttl=60)
    calls = []

    def nf(req):
        calls.append(req)
        return httpx.Response(404)
    f = _fetcher(nf)
    for _ in range(3):
        with pytest.raises(SourceNotFound):
            f.fetch("https://data.rada.gov.ua/laws/show/0-0.txt", ttl=60)
    assert len(calls) == 1  # 404 negative-cached


def test_captcha_page_not_cached_and_big_page_does_not_trip_breaker():
    pages = [b'<div id="modalcaptcha">captcha</div>', (FIXTURES / "reyestr_review.html").read_bytes()]
    f = _fetcher(lambda r: httpx.Response(200, content=pages.pop(0), headers={"content-type": "text/html; charset=utf-8"}))
    with pytest.raises(Exception, match="captcha"):
        decision(f, "123456")
    assert decision(f, "123456")["case_number"] == "910/1234/26"  # captcha was not cached
    # a large decision quoting "Доступ заборонено" must not pause the registry
    big = b"<textarea id=\"txtdepository\"><p>" + ("Доступ заборонено " * 3000).encode() + b"</p></textarea>"
    g = _fetcher(lambda r: httpx.Response(200, content=big, headers={"content-type": "text/html; charset=utf-8"}))
    decision(g, "222222")
    decision(g, "333333")


def test_latin1_header_does_not_mangle_cp1251():
    body = CK_TEXT.encode("cp1251")
    f = _fetcher(lambda r: httpx.Response(200, content=body, headers={"content-type": "text/plain; charset=ISO-8859-1"}))
    assert "Стаття 625" in RadaClient(f).act_text("435-15").text


def test_constitution_and_section_boundaries():
    text = (
        "Розділ II\nПРАВА, СВОБОДИ ТА ОБОВ'ЯЗКИ ЛЮДИНИ\n"
        "Стаття 55\nПрава і свободи людини і громадянина захищаються судом.\n"
        "Стаття\xa056\nКожен має право на відшкодування шкоди.\n"
        "Розділ III\nВИБОРИ. РЕФЕРЕНДУМ\n"
    )
    arts = split_articles(text)
    assert set(arts) == {"55", "56"}
    assert "Розділ III" not in arts["56"]
    assert cit.parse("ст. 55 Конституції України").nreg == "254к/96-вр"


def test_citation_parse_no_false_attribution():
    assert cit.parse("ст. 22 КЗпП (аналог ст. 625 ЦК)").nreg == "322-08"
    with pytest.raises(ValueError):
        cit.parse("ст. 12 Закону України «Про захист прав споживачів» та ЦК")
    assert cit.parse("Цивільний кодекс України, ст. 625").nreg == "435-15"
    c = cit.parse("у частині 2 статті 625 ЦК України")
    assert (c.article, c.part) == ("625", "2")
    with pytest.raises(ValueError):
        cit.parse("зміст 3 документа")  # "ст" inside a word is not an article


def test_as_of_range():
    r = RadaClient(_fetcher(rada_handler()))
    for bad in ("2099-01-01", "1980-01-01", "01.01.2020"):
        with pytest.raises(Exception):
            r.act_text("435-15", bad)


def test_live_budget_and_article_normalisation(client, seeded, live, monkeypatch):
    import backend.mcp_server as ms
    monkeypatch.setattr(ms, "LIVE_LIMIT_PER_MIN", 2)
    _, tok, _, _ = _connect(client)
    at = tok["access_token"]
    _init(client, at)
    art = _ok(client, at, "ua_get_act", {"nreg": "435-15", "article": "ст. 625"})
    assert art["article"] == "625" and "notice" in art
    _ok(client, at, "ua_act_card", {"nreg": "435-15"})
    result, text = _call(client, at, "ua_get_act", {"nreg": "435-15"})
    assert result.get("isError") and "limit" in text
