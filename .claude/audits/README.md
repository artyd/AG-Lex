# `.claude/audits/`

Append-only daily-audit log. One file per UTC day named `YYYY-MM-DD.md`.
The `/daily-audit` command writes here.

Each file contains one or more runs (sections starting with `## Run NN —
HH:MM`). Branches in flight, business-critical edits, smoke health, codex
status. A GREEN/YELLOW/RED verdict and one suggested next action.

Commit when you want history; or gitignore `.claude/audits/*.md` if you
prefer local-only — your call. The harness doesn't ignore them by default.
