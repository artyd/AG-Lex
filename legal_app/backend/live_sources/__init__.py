"""Live official legal sources for MCP stage 3 (docs/mcp/DESIGN.md §4, §7).

Nothing here builds a corpus: every call fetches from the official source
on demand and keeps the raw response only in a short-TTL cache
(`fetcher.LiveFetcher`). Adapters:

- `rada`  — data.rada.gov.ua open-data endpoints (act text / edition as of a
  date / card / new documents). Official terms: User-Agent "OpenData",
  ≤ 60 req/min with 5–7 s pauses, ≤ 100k req and 200 MB per day. The site's
  DDoS guard blocks the server IP when exceeded, so the fetcher enforces
  stricter limits and backs off on the block page.
- `court` — reyestr.court.gov.ua decision by id. No search (captcha
  protected) and no captcha bypass.
- `citation` — parse "ч. 2 ст. 625 ЦК України" style references and verify
  them against the official text.
"""
