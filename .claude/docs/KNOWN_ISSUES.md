# Known issues

Open gotchas that aren't bugs yet (or are out-of-scope for now). Append as
you find them; clear an entry once it's resolved (move the rationale to
LESSONS.md if it's worth keeping).

## Format

```
## YYYY-MM-DD — <one-line title>

- **Where**: file:line or area (e.g. "backend prompts caching")
- **Symptom**: what you observe / what fails
- **Workaround**: what to do until it's fixed (if any)
- **Root cause (suspected or confirmed)**: 1-3 sentences
- **Owner / tracker**: name or "unassigned"
- **Discovered**: PR / commit / issue link if any
```

---

## 2026-06-26 — Codex bootstrap silently inflates startup cost on fresh volumes

- **Where**: `legal_app/backend/main.py` (lifespan) +
  `legal_app/scripts/import_codex.py:bootstrap_codex`
- **Symptom**: On a fresh `aglex_db` volume the embedding model download
  (~200 MB) and the embedding of ~2 500 articles run during the first few
  minutes after boot. Healthcheck passes (background thread), but
  /api/codex/stats reports `vec_ready=false` until the embeddings finish.
  Until then, RAG search falls back to FTS-only.
- **Workaround**: pre-warm the volume before serving traffic — exec into
  the container and `python scripts/import_codex.py` synchronously, then
  start uvicorn.
- **Root cause**: deploy probe window (15s) doesn't accommodate the
  first-run embed cost. The background thread is the right answer; the
  UX gap is "search degrades for a few minutes after deploy".
- **Owner**: unassigned
- **Discovered**: PR #60 (hotfix moved bootstrap off lifespan main path)

## 2026-06-26 — `.gitignore` had a corrupted `.claude/` line

- **Where**: root `.gitignore`
- **Symptom**: A previous attempt to gitignore `.claude/` landed as `. c l
  a u d e /` (literal spaces between letters), which doesn't match
  anything. `.claude/settings.local.json` was effectively untracked only
  because the tree was clean, not because the pattern worked.
- **Workaround**: fixed in this PR — entry is now `.claude/settings.local.json`.
- **Root cause**: encoding / paste issue when the original entry was
  added.
- **Owner**: fixed
- **Discovered**: while wiring this harness
