---
name: add-known-issue
description: Append a structured entry to `.claude/docs/KNOWN_ISSUES.md` for an open gotcha that isn't a bug yet (or is out-of-scope for now). Use when the user says "log a known issue", "we should remember X", or similar.
---

Append-only. Don't rewrite existing entries.

## Format (from `KNOWN_ISSUES.md` header)

```
## YYYY-MM-DD — <one-line title>

- **Where**: file:line or area (e.g. "backend prompts caching")
- **Symptom**: what you observe / what fails
- **Workaround**: what to do until it's fixed (if any)
- **Root cause (suspected or confirmed)**: 1-3 sentences
- **Owner / tracker**: name or "unassigned"
- **Discovered**: PR / commit / issue link if any
```

## Steps

1. Ask the user for any missing field — but only if it's not derivable
   from context. If they gave you a clear "log this: <X breaks when Y>"
   you can fill in **Where** by grepping, default **Owner** to
   "unassigned", and infer **Discovered** from the current branch /
   commit.
2. Read the last 10 lines of `.claude/docs/KNOWN_ISSUES.md` to anchor
   the insertion point.
3. Append the new block before the file's final newline (or at the very
   end). Don't break the format.
4. Show the user the diff of the appended lines. Don't commit.

## Things to avoid

- Don't paste the format header again — the file already has it at the top.
- Don't duplicate an existing entry. Skim the file first; if the issue is
  already logged, update the existing entry instead of appending a new
  one (clarify with the user before editing).
- Don't add a `Status` field — that's the BUGS.md shape, not the
  KNOWN_ISSUES.md shape.
- Use absolute dates (`2026-06-26`), not "today".
