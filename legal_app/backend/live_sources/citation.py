"""Parse and verify Ukrainian statute citations against the official text.

"ч. 2 ст. 625 ЦК України", "стаття 16 Цивільного кодексу України",
"ст. 22 КЗпП" → (code nreg, article, part). `verify()` fetches the act
(optionally the edition in force on a date) from rada and checks that the
article exists and, if given, that the quoted wording is really there.
"""
from __future__ import annotations

import difflib
import re
from dataclasses import dataclass

from .rada import RadaClient, split_articles

# code aliases (casefolded regex) → (nreg on zakon.rada.gov.ua, short name, local codex source)
CODES: list[tuple[str, str, str, str | None]] = [
    (r"конституці\w*", "254к/96-вр", "Конституція України", None),
    (r"цку|цк(?:\s+україни)?|цивільн\w*\s+кодекс\w*", "435-15", "ЦК України", "ЦКУ"),
    (r"гку|гк(?:\s+україни)?|господарськ\w*\s+кодекс\w*", "436-15", "ГК України", None),
    (r"кпк(?:\s+україни)?|кримінальн\w*\s+процесуальн\w*\s+кодекс\w*", "4651-17", "КПК України", None),
    (r"кк(?:\s+україни)?|кримінальн\w*\s+кодекс\w*", "2341-14", "КК України", "КК"),
    (r"куп[аa]п|кодекс\w*\s+україни\s+про\s+адміністративні\s+правопорушення", "80731-10", "КУпАП", "КУпАП"),
    (r"кзпп(?:\s+україни)?|кодекс\w*\s+законів\s+про\s+працю", "322-08", "КЗпП України", "КЗпП"),
    (r"цпк(?:\s+україни)?|цивільн\w*\s+процесуальн\w*\s+кодекс\w*", "1618-15", "ЦПК України", None),
    (r"гпк(?:\s+україни)?|господарськ\w*\s+процесуальн\w*\s+кодекс\w*", "1798-12", "ГПК України", None),
    (r"кас(?:\s+україни)?|кодекс\w*\s+адміністративного\s+судочинства", "2747-15", "КАС України", None),
    (r"пку|пк(?:\s+україни)?|податков\w*\s+кодекс\w*", "2755-17", "ПК України", None),
    (r"зку|зк(?:\s+україни)?|земельн\w*\s+кодекс\w*", "2768-14", "ЗК України", None),
    (r"ску|ск(?:\s+україни)?|сімейн\w*\s+кодекс\w*", "2947-14", "СК України", None),
    (r"мку|митн\w*\s+кодекс\w*", "4495-17", "МК України", None),
]

_ART = r"\b(?:ст(?:атт\w*)?\.?)\s*(\d+(?:-\d+)?)"
_PART = r"\b(?:ч(?:астин\w*)?\.?)\s*(\d+)"
_POINT = r"\b(?:п(?:ункт\w*)?\.?)\s*(\d+)"
MAX_CITATION = 500
MAX_QUOTE = 5000


@dataclass
class Citation:
    nreg: str
    code: str
    article: str
    part: str | None
    point: str | None
    local_source: str | None


def parse(citation: str) -> Citation:
    """The code must sit right after the article ("ст. 625 ЦК") or right
    before it ("Цивільний кодекс України, ст. 625") — never "anywhere in the
    string", which would attribute "ст. 12 Закону … ЦК" to the ЦК."""
    s = " ".join(citation[:MAX_CITATION].replace("\xa0", " ").casefold().split())
    art = re.search(_ART, s)
    if not art:
        raise ValueError("No article number found (expected e.g. «ст. 625 ЦК України»).")
    before, tail = s[: art.start()], s[art.end():]
    hit = None
    for pattern, nreg, name, local in CODES:  # pass 1: code right after
        if re.match(r"\s*(?:,\s*)?(?:" + pattern + r")\b", tail):
            hit = (nreg, name, local)
            break
    if hit is None:
        for pattern, nreg, name, local in CODES:  # pass 2: code right before
            if re.search(r"(?:" + pattern + r")(?:\s+україни)?\s*,?\s*(?:ч(?:астин\w*)?\.?\s*\d+\s*,?\s*)?$", before):
                hit = (nreg, name, local)
                break
    if hit is None:
        raise ValueError("Unknown code/act. Use ua_get_act with the act's nreg for other laws.")
    part = re.search(_PART, before + " " + tail)
    point = re.search(_POINT, before)
    return Citation(nreg=hit[0], code=hit[1], article=art.group(1),
                    part=part.group(1) if part else None,
                    point=point.group(1) if point else None, local_source=hit[2])


def _norm(t: str) -> str:
    t = t.replace("\xad", "").replace("’", "'").replace("`", "'")
    t = re.sub(r"[«»“”„\"]", '"', t)
    return " ".join(t.casefold().split())


def quote_match(article_text: str, quote: str) -> tuple[str, float]:
    """('exact' | 'close' | 'not_found', similarity 0..1)."""
    a, q = _norm(article_text), _norm(quote[:MAX_QUOTE])
    if not q:
        return "not_found", 0.0
    if q in a:
        return "exact", 1.0
    words = a.split()
    n = max(1, len(q.split()))
    sm = difflib.SequenceMatcher(None, autojunk=False)
    sm.set_seq2(q)
    best = 0.0
    starts = list(range(0, max(1, len(words) - n + 1)))
    if len(starts) > 4000:  # very long article: sample windows, bounded work
        stride = len(starts) // 4000 + 1
        starts = starts[::stride] + [starts[-1]]
    for i in starts:
        sm.set_seq1(" ".join(words[i:i + n]))
        if sm.real_quick_ratio() <= best or sm.quick_ratio() <= best:
            continue
        best = max(best, sm.ratio())
        if best > 0.97:
            break
    # Note: a flipped negation ("має" vs "не має") still scores ~0.95 →
    # "close"; callers show the article text so a lawyer can see it.
    return ("close" if best >= 0.85 else "not_found"), round(best, 3)


def verify(rada: RadaClient, citation: str, quote: str = "", as_of: str = "") -> dict:
    c = parse(citation)
    act = rada.act_text(c.nreg, as_of)
    articles = split_articles(act.text)
    art_text = articles.get(c.article)
    out = {
        "citation": citation,
        "act": c.code,
        "nreg": c.nreg,
        "article": c.article,
        "part": c.part,
        "as_of": as_of or "current",
        "article_exists": art_text is not None,
        "source_url": act.source_url,
        "retrieved_at": act.retrieved_at,
        "source": "zakon.rada.gov.ua (official, live)",
    }
    if art_text is None:
        out["verdict"] = "article_not_found"
        return out
    out["article_text"] = art_text[:6000]
    if quote:
        verdict, sim = quote_match(art_text, quote)
        out.update({"quote_verdict": verdict, "similarity": sim})
        out["verdict"] = "ok" if verdict == "exact" else ("wording_differs" if verdict == "close" else "quote_not_in_article")
    else:
        out["verdict"] = "ok"
    return out
