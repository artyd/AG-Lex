---
description: Append a structured lesson entry to `.claude/docs/LESSONS.md` (transferable rule) and/or `docs/BUGS.md` (codebase bug log). Wraps the `lesson-keeper` agent.
---

Spawn `Agent: lesson-keeper`.

Use after landing a non-trivial fix. The agent reads the last commit + diff,
decides whether the change belongs in LESSONS.md, BUGS.md, or both, then
appends in the right format. It shows you the diff; you commit when ready.
