---
description: Draft a PR title + body for the current branch in this repo's commit style. Wraps the `pr-description-drafter` agent.
---

Spawn `Agent: pr-description-drafter` for the current branch.

The agent reads `git log origin/main..HEAD` + the diff, then returns a
suggested title + body. It does not open the PR. The user copies the
output into `gh pr create`.

If the current branch has no commits ahead of `origin/main`, say so and
stop.
