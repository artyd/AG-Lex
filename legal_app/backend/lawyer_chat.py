"""Lawyer Chat — conversational legal assistant grounded in the codex.

A separate endpoint from `/api/analyze` because the contract there:

  * `/api/analyze` answers ONE question, optionally about a contract section.
    Each turn is independent — no memory of earlier turns.
  * `/api/lawyer-chat` is a multi-turn conversation with the same "30-year
    senior lawyer" persona. The frontend ships the last few user/assistant
    turns so the model can keep the thread coherent ("уточни про п.1.2"
    works because the previous answer is in scope).

Both share the same RAG mechanic: hybrid_search → cached articles block →
Claude. They share `_client()` from `claude_client`, so they live in the
same singleton + retry config.

Token economy is the explicit design constraint here. Two cache breakpoints
(LAWYER_CHAT_SYSTEM_PROMPT + the articles block) mean the bulk of every
request hits the prompt cache: ~90% cheaper on repeats inside the 5-minute
TTL. Conversation history goes in the user/assistant messages array (NOT
cached) so the cache stays valid even as the thread grows.

System-prompt persona deliberately differs from `LEGAL_SYSTEM_PROMPT`: the
analyse-screen prompt asks for "**П. X.Y**" bolding around contract clauses,
which is wrong for a free-form chat. Here the lawyer talks like a senior
practitioner taking a call from a junior — short, opinionated, ends with
"what to do next".
"""
from __future__ import annotations

import sqlite3
from typing import Literal, Optional

import anthropic
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .auth import current_user
from .chat_sessions import load_history as load_session_history, persist_turn
from .claude_client import ClaudeError, _client, format_articles
from .config import get_settings
from .database import get_db
from .rbac import require
from .search import hybrid_search


# Cap retrieval at 4 hits. Tightly grounded answers (one or two articles)
# beat a wide context for chat — the lawyer cites the load-bearing norm
# and moves on. Keeps the cached article block under ~3k tokens for Sonnet.
CHAT_SEARCH_LIMIT = 4
# Concise by design — a chat turn is 200–400 words, not a memo.
CHAT_MAX_TOKENS = 900
# How many prior turns the FE may ship. More than this and the request
# grows faster than the cache savings — Claude reads the full history each
# call. 6 covers "уточни ще раз" follow-ups without bloat.
MAX_HISTORY_TURNS = 6


# --- System prompt -----------------------------------------------------------
# Byte-stable. Any whitespace change here invalidates every existing prompt
# cache entry for the chat — including across servers, since Anthropic hashes
# the literal bytes of the system block.
LAWYER_CHAT_SYSTEM_PROMPT = """Ти — старший адвокат із 30-річним стажем. \
Спеціалізація — договірне, господарське, цивільне, корпоративне право України, \
плюс ЄС-комплаєнс (GDPR). До тебе звертається колега-юрист або менеджер, \
якому потрібна швидка, конкретна порада — без води.

ПЕРСОНА:
- Говориш як практик, що бачив сотні подібних ситуацій. Спокійно, впевнено, \
жваво, без юридичного жаргону там, де він не потрібен.
- Маєш сильну думку. Якщо ситуація проста — кажеш «це робиться так». \
Якщо неоднозначна — кажеш «є два варіанти, я б обрав цей, ось чому».
- НЕ читаєш лекцій. НЕ розтягуєш відповідь.

ПРАВИЛА ПО ЗАКОНАХ:
- Посилайся ТІЛЬКИ на статті з блоку <context_articles>. НІКОЛИ не вигадуй \
номерів. Якщо в контексті немає потрібної норми — скажи прямо: \
«за цим питанням у наданих джерелах прямої норми немає, але загальний підхід — …».
- Стиль посилання — коротко в дужках: (ст. 651 ЦКУ), (ст. 17 GDPR), (ст. 188 ГКУ). \
Жодних повних цитат норми блоками.

ФОРМАТ ВІДПОВІДІ — суворо у такій послідовності:
1. **Коротка відповідь по суті** (1–2 речення, виділені жирним на початку). \
Це головне — людина має зрозуміти суть навіть якщо більше нічого не прочитає.
2. **Пояснення** (1–2 короткі абзаци) — чому саме так, з посиланнями на статті.
3. **Що робити далі** — нумерований список із 2–4 конкретних кроків. \
Не «слід проаналізувати», а «зробіть А, потім Б». Дієслова в наказовому способі.

ОБСЯГ — 150–300 слів. Якщо питання просте — 100. \
Якщо складне — до 350, але не більше.

СТИЛЬ:
- Українською. Точно, але живо.
- Можна використовувати: «я б», «на практиці», «дивіться», «насправді». \
Чергуй фрази, щоб не звучало як шаблон.
- Без канцеляризму («у разі настання», «з огляду на викладене»).
- НЕ починай відповідь словами «Як старший адвокат» або «На основі наданих \
матеріалів». Одразу до суті.
- НЕ закінчуй відповідь дисклеймером — фронтенд додає його сам.

ПРИКЛАД ПРАВИЛЬНОЇ ВІДПОВІДІ:

**Можна, але тільки за згодою сторони — інакше це порушення.** Одностороннє розірвання \
без згоди допустиме лише у випадках, прямо передбачених договором або законом (ст. 651 ЦКУ).

На практиці суди вимагають довести або істотне порушення з боку контрагента, або наявність \
прямого договірного «opt-out». Просте бажання припинити співпрацю — не підстава. \
Якщо у вашому договорі немає пункту про одностороннє розірвання за повідомленням, ви ризикуєте \
позовом про відшкодування збитків (ст. 623 ЦКУ).

Що робити:
1. Перевірте п. про підстави розірвання у вашому договорі — шукайте формулювання \
«в односторонньому порядку», «без пояснення причин», «за повідомленням за N днів».
2. Якщо такого пункту немає — надішліть контрагенту пропозицію про розірвання за згодою сторін, \
закріпивши датою припинення.
3. Якщо згоди немає, а підстава істотна (порушення з боку контрагента) — готуйте позов до суду \
з обґрунтуванням ст. 651 ЦКУ.
"""


# --- Helpers -----------------------------------------------------------------

def _format_history(history: list[dict]) -> list[anthropic.types.MessageParam]:
    """Trim + sanitise history to the last N turns, alternating user/assistant.

    Anthropic requires the messages array to start with a user turn and
    alternate roles. The FE may ship more than we want (or in a weird order
    if it's been edited offline), so we filter and clip here.
    """
    if not history:
        return []
    cleaned: list[anthropic.types.MessageParam] = []
    last_role: str | None = None
    for m in history:
        role = m.get("role")
        text = (m.get("text") or m.get("content") or "").strip()
        if not text or role not in ("user", "assistant"):
            continue
        # Skip role repeats — Anthropic 400s on consecutive same-role turns.
        if role == last_role:
            continue
        cleaned.append({"role": role, "content": text})
        last_role = role
    # Keep only the last MAX_HISTORY_TURNS, and make sure we don't end on
    # a user turn (we're about to append the new user message).
    cleaned = cleaned[-MAX_HISTORY_TURNS:]
    while cleaned and cleaned[-1]["role"] == "user":
        cleaned.pop()
    # Must start with user
    while cleaned and cleaned[0]["role"] != "user":
        cleaned.pop(0)
    return cleaned


def _build_context_block(articles: list[dict]) -> str:
    if not articles:
        # An explicit "no relevant articles" marker is better than an empty
        # tag — the model otherwise tends to invent references.
        return (
            "<context_articles>\n"
            "За цим запитом релевантних статей у базі знань не знайдено. "
            "Дай відповідь загального характеру, без посилань на конкретні норми, "
            "і прямо скажи, що питання потребує перевірки за актуальним текстом закону.\n"
            "</context_articles>"
        )
    return (
        "<context_articles>\n"
        "Нижче — статті кодексів, на які можна посилатися у відповіді. "
        "Будь-яка інша норма права — поза контекстом.\n\n"
        f"{format_articles(articles)}\n"
        "</context_articles>"
    )


_USED_ARTICLE_FIELDS = ("article_number", "title", "source", "score")


def _trim_articles(articles: list[dict]) -> list[dict]:
    """Drop `content` from the response payload — the FE only needs metadata
    to render the citation cards. Keeps the wire payload small."""
    return [{k: a.get(k) for k in _USED_ARTICLE_FIELDS} for a in articles]


# --- Core --------------------------------------------------------------------

def chat(
    question: str,
    history: list[dict] | None = None,
    *,
    client: anthropic.Anthropic | None = None,
    conn=None,
    embedder=None,
) -> dict:
    """Run one chat turn end-to-end.

    Args:
        question: The latest user message (Ukrainian preferred).
        history: Earlier turns as `[{role: "user"|"assistant", text: "..."}]`.
            The FE should ship the last 4-6 turns; we clip to `MAX_HISTORY_TURNS`.
        client / conn / embedder: dependency injection for tests.

    Returns:
        `{answer, cited_articles, warnings, usage, model}`. `cited_articles`
        is the same metadata shape `/api/analyze` uses so the FE can reuse
        the citation-card renderer.
    """
    from .mock_ai import is_mock_ai, mock_analyze_answer
    if is_mock_ai():
        # Re-use the mock_analyze fixture but rename `used_articles` →
        # `cited_articles` so the chat FE sees the field it expects.
        m = mock_analyze_answer(question)
        return {
            "answer": m["answer"],
            "cited_articles": m.get("used_articles", []),
            "warnings": m.get("warnings", []),
            "usage": m.get("usage", {}),
            "model": m.get("model", "mock"),
        }

    settings = get_settings()
    cli = client or _client()

    # Search the codex with the question. Section text from a contract is
    # NOT supported here — chat is a general legal Q&A, not a per-clause
    # review. If the user pastes a clause we still retrieve on the question
    # alone, which is fine for an MVP.
    hits = hybrid_search(
        question, source=None, limit=CHAT_SEARCH_LIMIT,
        conn=conn, embedder=embedder,
    )
    context_block = _build_context_block(hits)

    # System: prompt + grounded article block. BOTH cached — the bulk of
    # request cost survives session-to-session inside the 5-minute window.
    system_blocks: list[anthropic.types.TextBlockParam] = [
        {
            "type": "text",
            "text": LAWYER_CHAT_SYSTEM_PROMPT,
            "cache_control": {"type": "ephemeral"},
        },
        {
            "type": "text",
            "text": context_block,
            "cache_control": {"type": "ephemeral"},
        },
    ]

    # User/assistant turns: the trimmed conversation history + the new
    # user question at the end. The TAIL of the prior conversation gets a
    # 3rd cache breakpoint so the next turn cache-reads everything up to
    # and including the last assistant reply — only the new user message
    # (small + always-new) stays uncached. Anthropic allows up to 4 markers
    # per request; we use 3 (system + context + conversation prefix).
    prior = _format_history(history or [])
    if prior:
        last = prior[-1]
        prior[-1] = {
            "role": last["role"],
            "content": [{
                "type": "text",
                "text": last["content"],
                "cache_control": {"type": "ephemeral"},
            }],
        }
    messages = prior + [{"role": "user", "content": question.strip()}]

    try:
        response = cli.messages.create(
            model=settings.MODEL_NAME,
            max_tokens=CHAT_MAX_TOKENS,
            system=system_blocks,
            messages=messages,
        )
    except anthropic.AuthenticationError as e:
        raise ClaudeError(f"Anthropic authentication failed — check API_KEY in .env: {e.message}") from e
    except anthropic.PermissionDeniedError as e:
        raise ClaudeError(f"API key lacks permission for model {settings.MODEL_NAME!r}: {e.message}") from e
    except anthropic.NotFoundError as e:
        raise ClaudeError(f"Model {settings.MODEL_NAME!r} not found: {e.message}") from e
    except anthropic.RateLimitError as e:
        raise ClaudeError(f"Anthropic rate limit exceeded after retries: {e.message}") from e
    except anthropic.APIConnectionError as e:
        raise ClaudeError(f"Network error contacting Anthropic: {e}") from e
    except anthropic.APIStatusError as e:
        raise ClaudeError(f"Anthropic API error ({e.status_code}): {e.message}") from e

    answer = "\n".join(
        getattr(b, "text", "") for b in response.content if getattr(b, "type", None) == "text"
    ).strip()
    usage = response.usage

    # Citation validation: the pipeline.validate_citations check runs by
    # number against the article numbers we retrieved. Re-use the same
    # helper so warnings are consistent across endpoints.
    from .pipeline import validate_citations
    warnings = validate_citations(answer, hits)

    return {
        "answer": answer,
        "cited_articles": _trim_articles(hits),
        "warnings": warnings,
        "model": response.model,
        "usage": {
            "input_tokens": usage.input_tokens,
            "output_tokens": usage.output_tokens,
            "cache_creation_input_tokens": getattr(usage, "cache_creation_input_tokens", 0) or 0,
            "cache_read_input_tokens": getattr(usage, "cache_read_input_tokens", 0) or 0,
        },
    }


# --- Router ------------------------------------------------------------------

router = APIRouter(prefix="/api", tags=["lawyer-chat"])


class _HistoryTurn(BaseModel):
    role: Literal["user", "assistant"]
    # max_length protects against a malicious FE shipping mega-blobs in
    # the history. 8k chars per turn ≈ 2k tokens — plenty for a chat.
    text: str = Field(..., min_length=1, max_length=8000)


class LawyerChatRequest(BaseModel):
    question: str = Field(
        ..., min_length=1, max_length=4000,
        description="Latest user message (Ukrainian preferred).",
    )
    history: Optional[list[_HistoryTurn]] = Field(
        default=None,
        max_length=20,
        description=(
            "Deprecated: pass `session_id` instead. When `session_id` is "
            "present the server loads history from the DB and ignores this "
            "field. Kept for back-compat with the legacy in-memory client."
        ),
    )
    session_id: Optional[str] = Field(
        default=None,
        description=(
            "Existing chat_sessions.id. When provided, the server loads "
            "history from DB, persists the new user + assistant turns, and "
            "auto-titles the session from the first user message."
        ),
    )


@router.post("/lawyer-chat", dependencies=[Depends(require("ai"))])
def lawyer_chat_endpoint(
    req: LawyerChatRequest,
    user: dict = Depends(current_user),
    conn: sqlite3.Connection = Depends(get_db),
):
    """Conversational legal assistant grounded in the codex.

    Gated by the `ai` capability — same gate as /api/analyze. Errors from
    the SDK surface as HTTP 502 with a single readable line.

    When `session_id` is set, the call becomes stateful: server-loaded
    history, persisted turn, auto-titled session. When absent, the legacy
    client-history contract still works (one release deprecation window).
    """
    history_for_chat: list[dict]
    if req.session_id:
        # Local import keeps the in-memory legacy path from booting the
        # chat_sessions module unnecessarily.
        from .chat_sessions import assert_owns_session

        assert_owns_session(conn, req.session_id, user["id"])
        history_for_chat = load_session_history(
            conn, req.session_id, limit=MAX_HISTORY_TURNS * 2,
        )
    else:
        history_for_chat = [t.model_dump() for t in (req.history or [])]

    try:
        result = chat(question=req.question, history=history_for_chat)
    except ClaudeError as e:
        raise HTTPException(status_code=502, detail=str(e))

    if req.session_id:
        new_title = persist_turn(
            conn, req.session_id,
            user_message=req.question,
            assistant_message=result["answer"],
        )
        result["session_id"] = req.session_id
        result["session_title"] = new_title

    return result
