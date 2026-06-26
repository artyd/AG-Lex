# Changelog (annotated)

Recent merges with the *why* layered on top of the *what* — git log shows
the diffs, this file explains the motivation. Newest first. Append a line
when you merge something non-trivial.

## 2026-06-25 — `feat(auth)`: viktoria@aglex.ua sees a clean workspace

- Per-account toggle in `crud._account_hides_demo` filters seed rows
  (those with no dash in the PK) from list/get for Вікторія's account.
  Handover credential for the partner; she lands on an empty workspace
  instead of inheriting the prototype's demo matters/tasks/clients.
- Files: `auth.py` (`VIKTORIA_USER_EMAIL`), `crud.py` (`_is_seed_pk` +
  filter), `main.py` (lifespan seeds her account).

## 2026-06-25 — `feat(auth)`: seed Вікторія Верещагіна partner account on startup

- `seed_viktoria_user` runs alongside `seed_test_user` in lifespan.
  Idempotent — INSERT OR IGNORE.

## 2026-06-25 — PR #60 `fix(legislation)`: codex bootstrap → background thread

- Lifespan was synchronously embedding ~2 500 articles on the first boot
  of a fresh `aglex_db` volume; the deploy probe's 15s window 502'd nginx.
  Moved `bootstrap_codex` to a daemon thread that opens its own DB
  connection. See `.claude/docs/LESSONS.md` 2026-06-25 entry.

## 2026-06-24 — PR #59 `feat(analysis+legislation)`: markdown reader replaces PDF viewer, auto-seed codex

- Replaced the in-browser PDF viewer for codex articles with a markdown
  reader (`src/screens/analysis/MarkdownDoc.jsx`). Reading is faster +
  copy-paste survives.
- Auto-seeds codex sources on first boot so the «Законодавство» tab and
  RAG retrieval both come up populated.

## 2026-06-24 — PR #58 `fix(legislation)`: library fills full window

- Removed the padding gutter around the LegislationLibrary shell. The
  3-column layout (sources / list / reader) now fills the viewport.

## 2026-06-24 — PR #57 `feat(legislation)`: RAG indicator, source counter, type filter

- Sidebar now shows the share of each source that has embeddings, a total
  count, and a UA/EU type filter.

## 2026-06-23 — PR #56 `feat(legislation+access)`: library over codex DB, split Manage nav

- The legislation library reads directly from `articles` (one DB, one
  source of truth) instead of duplicating into an in-memory store.
- Split the Manage section into Team and Access nav items.

## 2026-06-22 — PR #55 `fix(nginx)`: serve `.mjs` as static asset for pdf.js worker

- The pdf.js web worker is loaded via ESM (`.mjs`). nginx defaulted to
  the wrong MIME type, browsers refused to execute, the worker silently
  failed. Added the explicit MIME mapping in
  `docker/frontend.nginx.conf`.

## 2026-06-22 — PR #54 `chore(deploy)`: force nginx restart + tighten health wait to 15s

- Workflow now `docker compose restart nginx` after build to pick up the
  latest config without orchestrating a full edge swap.
- Health wait dropped from 30s → 15s. (Sets the constraint we hit later
  with the codex bootstrap, fixed in PR #60.)

## 2026-06-21 — PR #53 `fix(chat)`: chat fills full window

- Same kind of fix as PR #58 — kill the padding gutter around the chat
  shell so the page reflects the AI-lawyer chat as a full-width view.

## 2026-06-21 — PR #52 `fix(chat)`: render sidebar beside the window, not above it

- ChatPage layout fix: the session-history sidebar now lives in a left
  column instead of stacking above the chat window.

## 2026-06-20 — PR #51, #50, #49 — deploy SSH debugging trio

- #51 added diagnostic logging of the loaded SSH key fingerprint so we
  could match against `authorized_keys` on the server.
- #50 emitted the public half of the SSH key during the workflow run.
- #49 added `git config --global --add safe.directory /opt/aglex` to the
  remote step — `/opt/aglex` was cloned by root, deploy SSH user differs.

## 2026-06-19 — PR #48 `feat(chat)`: persistent AI-lawyer sessions + sidebar history

- Introduced `chat_sessions` + `chat_messages` tables with CASCADE delete.
- `useChatSessions` hook + sidebar history view; `POST /api/lawyer-chat`
  now accepts a `session_id` so server-side history can stay authoritative.

## Older

History earlier than PR #48 is summarised in commit messages — see
`git log --oneline`. Notable past landmarks:

- Phases 1.x — codex import, FTS5, hybrid search, Claude wrapper.
- Phases 2.x — auth, workspace entities, RBAC, matters ACL, realtime.
- Phases 3.x — contract analysis, lawyer assist, doc builder.
- Phases 4.x — display-PDF pipeline (soffice DOCX/XLSX → PDF).
