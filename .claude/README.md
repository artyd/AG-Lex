# `.claude/` — AG Lex harness

Auto-loaded context, sub-agents, skills, and slash commands that make this
repo Claude-aware. Edit freely — everything here is committed.

## Index

- [PROJECT.md](PROJECT.md) — long-form architecture reference (read after `CLAUDE.md`)
- [settings.json](settings.json) — allow / ask / deny permissions for this repo
- [docs/](docs/) — per-topic deep references
  - [GLOSSARY.md](docs/GLOSSARY.md) — UA codex codes, role names, phase numbers
  - [API.md](docs/API.md) — endpoint catalogue by router
  - [DATABASE.md](docs/DATABASE.md) — schema (articles + FTS + 15 entities + ACL tables)
  - [BACKEND_FLOW.md](docs/BACKEND_FLOW.md) — lifespan, routing order, request path
  - [FRONTEND.md](docs/FRONTEND.md) — App.jsx state, route map, hooks
  - [RAG.md](docs/RAG.md) — codex import, embedder, hybrid search, prompt-cache
  - [RBAC.md](docs/RBAC.md) — roles × capabilities matrix, ACL, audit log
  - [DEPLOY.md](docs/DEPLOY.md) — Hetzner SSH deploy + docker compose
  - [SETUP.md](docs/SETUP.md) — local dev, env vars, common commands
  - [KNOWN_ISSUES.md](docs/KNOWN_ISSUES.md) — open gotchas (append as found)
  - [LESSONS.md](docs/LESSONS.md) — append-only post-fix lessons
  - [CHANGELOG.md](docs/CHANGELOG.md) — annotated PR history
- [agents/](agents/) — sub-agents
  - `code-style-enforcer` — project conventions linter
  - `pr-description-drafter` — PR body in this repo's commit style
  - `lesson-keeper` — append entries to LESSONS.md / BUGS.md
  - `auth-rbac-reviewer` — guards `auth.py`, `rbac.py`, `cases_acl.py`
  - `ai-prompt-guardian` — guards `prompts.py`, `claude_client.py`, JSON schemas
  - `migration-safety-reviewer` — guards `database.py`, `models.py`, schema changes
- [skills/](skills/) — multi-step procedures
  - `pre-merge-checklist` — full preflight
  - `safe-branch-recreate` — destructive branch rewrite with gates
  - `add-known-issue` — append to KNOWN_ISSUES.md
  - `add-route` — scaffold a new FastAPI endpoint
- [commands/](commands/) — slash entries
  - `/daily-audit` · `/pre-merge` · `/draft-pr` · `/lesson` · `/codex-check`
- [audits/](audits/) — daily-audit log (`YYYY-MM-DD.md` per run)

## Suggested rhythm

- Each morning: `/daily-audit` → review the file written to `.claude/audits/`
- Before opening a PR: `/pre-merge` → `/draft-pr`
- After landing a non-trivial fix: `/lesson` (so the next person doesn't redo it)
- When adding a backend endpoint: `Skill: add-route`
- When touching anything in the **Business-critical files** table of `CLAUDE.md`:
  spawn the matching guardian agent first
