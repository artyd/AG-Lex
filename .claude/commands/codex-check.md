---
description: Quick health probe of the codex / RAG pipeline — runs `check_codex.py` and surfaces fts_ready / vec_ready / per-source counts.
---

Run:

```bash
python legal_app/scripts/check_codex.py
```

Then summarise in 5 lines or fewer:

```
Total articles: N
By source: ЦКУ=… ГКУ=… КК=… КУпАП=… КЗпП=… EU_GDPR=…
fts_ready: true/false
vec_ready: true/false
Sample (per source): first article number + 60-char preview
```

**If `vec_ready=false`** on a non-fresh DB: warn that the embedder
didn't run on import — RAG falls back to FTS-only, accuracy drops.
Suggest `python legal_app/scripts/import_codex.py` to backfill.

**If `fts_ready=false`**: the trigger missed something. Suggest
`python -c "from legal_app.backend.database import get_connection,
init_schema; conn = get_connection(); init_schema(conn); conn.close()"`
to rerun `_FTS_BACKFILL`.

**If the script isn't runnable** (no venv, no API_KEY): say so, don't
guess values.
