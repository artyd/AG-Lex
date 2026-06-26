# RAG pipeline

Codex articles → embeddings + FTS5 → hybrid search → Claude with two
cache breakpoints.

## Source files

```
legal_app/data/codex_sources/
  tsku.txt        → ЦКУ   (Civil Code of Ukraine)
  kk.txt          → КК    (Criminal Code)
  kupap.txt       → КУпАП (Code of Administrative Offences)
  kzpp.txt        → КЗпП  (Labour Code)
  gdpr.txt        → EU_GDPR
```

Filename → source code mapping is in `scripts/import_codex.py`
`SOURCE_BY_STEM`. Anything not in that dict falls back to the uppercased
filename stem.

## Import (`legal_app/scripts/import_codex.py`)

```
bootstrap_codex(conn)
  → walks data/codex_sources/*
  → parses each file with ARTICLE_RE (matches "Стаття 651" / "Article 5")
  → embeds article bodies in batches of 64
  → INSERT OR IGNORE (UNIQUE on article_number, source)
```

Idempotent — safe to run on every boot. The lifespan starts it in a
background thread so the deploy probe's 15s health-check window isn't
blocked by the ~200 MB sentence-transformers model download on a fresh
volume.

CLI form:

```bash
# All sources
python legal_app/scripts/import_codex.py

# One file
python legal_app/scripts/import_codex.py legal_app/data/codex_sources/gdpr.txt
```

## Embedder

```python
from sentence_transformers import SentenceTransformer
SentenceTransformer(settings.EMBED_MODEL)
# default: paraphrase-multilingual-MiniLM-L12-v2
```

`@functools.lru_cache(maxsize=1)` keeps it warm. Vectors are 384-dim
float32 stored as raw BLOB in `articles.embedding`.

**Invariant:** the model that produced an embedding must match the model
that encodes the query at search time. Changing `EMBED_MODEL` without
re-importing every article means search returns junk silently — there's
no dimension mismatch error.

## Search (`legal_app/backend/search.py`)

Three entry points; same return shape `{id, article_number, title,
content, source, score}`:

| Function           | Signal                       | Index used          |
|--------------------|------------------------------|---------------------|
| `search_by_vector` | cosine similarity            | sqlite-vec on `embedding` |
| `search_by_text`   | BM25 (sign-flipped to positive) | `articles_fts` (FTS5) |
| `hybrid_search`    | Reciprocal Rank Fusion (k=60) | both, oversampled 2× |

FTS5 query sanitisation: `_sanitize_fts` tokenises with `\w+` and quotes
each token so users can't inject FTS operators.

`source=` accepts `None`, a single string (`"ЦКУ"`), or a list
(`["ЦКУ", "ГКУ"]`). Used by `/api/codex/articles?source=…` and by the
sources filter in `/api/analyze`.

## Claude call (`legal_app/backend/claude_client.py`)

```python
ask_claude(question, context_articles, contract_section=None)
  → build articles_text via format_articles (deterministic ordering)
  → system = [
        {text: LEGAL_SYSTEM_PROMPT, cache_control: ephemeral},   # breakpoint 1
        {text: context_block,       cache_control: ephemeral},   # breakpoint 2
    ]
  → messages = [{role: user, content: <contract_section> + question}]
  → cli.messages.create(model=settings.MODEL_NAME, ...)
```

Two cache breakpoints because:
- System prompt is stable across every chat turn.
- Articles block is stable across questions about the same retrieval set.

Anthropic's prompt-cache minimums:
- Sonnet 4.6: ≥ 2048 tokens cacheable
- Opus 4.6 / 4.7: ≥ 4096 tokens cacheable

Below those thresholds caching silently skips — that's expected in tests
with small synthetic article sets.

### Determinism = cache hits

- `format_articles` iterates `context_articles` in caller order — pass a
  stable order across turns that should share a cache entry.
- `prompts.py` strings are byte-stable. Any change invalidates every
  active entry (5-min TTL × all servers).
- No `datetime.now()`, no `set` traversal, no `dict` ordering changes in
  the cached prefix.

## Structured-output calls

`contract_analysis.py` and `reconciliation.py` use `output_config.format =
"json_schema"` with strict `additionalProperties: false`. The schemas
constrain icon names, severity enums, status enums — anything new must be
added on both sides (schema + frontend renderer).

`contract_analysis._KEYDATA_ICON_ENUM` must stay in sync with
`src/ui/Icon.jsx`'s icon dict — icons outside the enum render as nothing.

## Health probe

`GET /api/codex/stats` →

```json
{
  "total_articles": 2547,
  "by_source": [{"source": "ЦКУ", "count": 1310}, ...],
  "fts_ready": true,    // articles_fts row count == articles row count
  "vec_ready": true     // sqlite-vec loaded + ≥1 article has embedding
}
```

`fts_ready=false` means the trigger missed something — re-run `init_schema`
(which includes `_FTS_BACKFILL`). `vec_ready=false` means the import-time
embedder didn't run.

CLI shortcut: `python legal_app/scripts/check_codex.py` prints stats + a
3-article sample per source.
