# Lessons

Append-only log of post-fix lessons. **One entry per non-trivial fix.**

The point: avoid making the same mistake twice. `docs/BUGS.md` is the
codebase-level append-only log of fixed bugs (with file refs); this file
is the *transferable rule* version — the rule a future contributor needs
to remember without the full bug context.

Use `/lesson` (or `Agent: lesson-keeper`) to draft an entry in the right
shape.

## Format

```
## YYYY-MM-DD — <imperative rule>

- **Rule**: One sentence in imperative form. ("Schedule realtime broadcasts
  AFTER conn.commit()", not "we should remember…")
- **Why**: 2–4 sentences. Reference the incident or the design constraint.
- **How to apply**: When does this fire? File / area / commit pattern.
- **Related**: PR, commit, BUGS.md entry, or doc reference.
```

---

## 2026-06-25 — Don't run multi-minute work inside the lifespan main path

- **Rule**: Anything in `lifespan` that can take more than ~5 seconds must
  run in a background thread (or be moved to a one-off script).
- **Why**: The Hetzner deploy workflow sleeps 15s after
  `docker compose restart nginx` and then probes `/api/health`. A
  synchronous codex bootstrap on a fresh `aglex_db` volume downloads a
  ~200 MB embedding model + embeds ~2 500 articles, blowing past the
  probe window and 502-ing nginx. The fix was a daemon thread that opens
  its own DB connection.
- **How to apply**: When adding lifespan steps, ask "what does this look
  like on a cold cache / empty volume?" If the answer is "minutes",
  background it. Pattern lives in `main.py:lifespan` (the
  `_bootstrap_codex_in_background` block).
- **Related**: PR #60 (`fix(legislation): run codex bootstrap in a
  background thread, not in lifespan`).

## 2026-06-XX — Custom routers MUST register before the generic CRUD loop

- **Rule**: In `main.py`, any custom router that handles a path the
  generic `build_router` loop would also handle must be `include_router`'d
  **before** the `for _entity in ALL_ENTITIES` loop.
- **Why**: FastAPI matches the first registered route. The generic
  `build_router(MATTERS)` has no row-level ACL — letting it shadow
  `matters_routes.router` would skip `require_member` and leak case data
  across users. Same for the custom POST `/api/contracts` (display PDF
  BLOB writer) — the generic CRUD POST would write a row with no BLOB.
- **How to apply**: When introducing a new custom router, register it
  above the loop. When adding a generic entity that needs row-level
  rules, fork to a custom router instead of trying to teach the factory
  about ACL.
- **Related**: matters_routes.py, the custom `POST /api/contracts` block
  in main.py, drafts.py.

## 2026-06-XX — Prompts are byte-stable; treat string edits like schema changes

- **Rule**: Don't whitespace-tweak or word-tweak prompts in `prompts.py`
  unless you mean to invalidate the prompt cache.
- **Why**: Anthropic hashes the cached prefix verbatim. Any change (a
  swapped word, an added newline, a "fixed" typo) blows away every active
  cache entry across all servers, multiplies input cost on the 5 minutes
  of warm traffic that follows, and drifts the lawyer voice / legal
  persona that the prompts encode.
- **How to apply**: Read the file's docstring before editing. If you must
  change a prompt, do it deliberately, with a paragraph in the PR body
  explaining the cache-cost spike and the reason the persona change is
  worth it. Run `Agent: ai-prompt-guardian` before merging.
- **Related**: `claude_client.py` cache_control comments, `prompts.py`
  docstring.
