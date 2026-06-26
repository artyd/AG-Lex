---
name: safe-branch-recreate
description: Destructive branch-history rewrite (force push, reset --hard, branch -D) gated by checklist. Use when the user explicitly asks to "redo the branch", "rewrite history", "squash and push --force", or similar. Never invoke proactively.
---

This skill exists to prevent quiet catastrophes. The user has asked for
something destructive — do the work, but only after these gates are met.
**Stop and ask** at each gate that isn't satisfied.

## Pre-conditions (all must be true)

1. The user said it explicitly. Don't rewrite history because it "looks
   cleaner". The word *force*, *rewrite*, *recreate*, *squash*, *reset*
   must appear in the request.
2. The target branch is **not** `main` or `master`. If the user wants to
   force-push `main`, stop and confirm in clear words ("Force-pushing
   main rewrites everyone's local history and breaks open PRs. Do you
   want me to continue?").
3. Working tree is clean (`git status` returns nothing). Stash or commit
   first; never `git checkout --` someone's WIP.
4. The branch you're about to nuke is fully pushed to origin if any of
   its commits are author-attributed to anyone else — losing a
   collaborator's commits is the worst outcome here.

## Gates per operation

### `git reset --hard <ref>`

- Show `git log --oneline HEAD..<ref>` and `git log --oneline <ref>..HEAD`
  so the user sees what's about to disappear.
- Confirm: "This will discard <N> commits on <branch>. Continue?"
- After reset, run `git status` to verify the result.

### `git push --force` / `--force-with-lease`

- **Prefer `--force-with-lease`.** It refuses the push if the remote
  has commits you haven't seen — catches the "teammate pushed while
  you were rebasing" case.
- Show `git log --oneline origin/<branch>..HEAD` and
  `git log --oneline HEAD..origin/<branch>` (both directions).
- If the second list is non-empty, **stop**. Someone added commits to
  the remote you don't have locally; force-pushing would erase them.

### `git branch -D <name>`

- Confirm the branch is merged or its commits exist elsewhere (`git
  branch --merged main`, `git log -10 <name>`).
- Confirm with the user before deleting.

### `git checkout -B <name>` (overwriting an existing branch)

- Same logic as branch-D. Show what's about to be overwritten.

## Workflow

1. Capture current state:
   ```bash
   git rev-parse HEAD
   git log --oneline -10
   git status --short
   git branch --show-current
   git for-each-ref --sort=-committerdate --format='%(refname:short) %(committerdate:relative)' refs/heads/ | head -10
   ```
2. Make a safety ref before any destructive op:
   ```bash
   git tag -f "safety/$(date +%Y%m%d-%H%M%S)" HEAD
   ```
   This is a local-only tag; the user can `git reset --hard safety/...`
   to undo within `git gc`'s window (default 30+ days for reachable tags).
3. Perform the requested op with the gates above.
4. Verify the resulting state and report:
   ```bash
   git log --oneline -10
   git status --short
   ```
5. Tell the user: the safety tag name, the new HEAD, what was discarded.

## Output

```
## safe-branch-recreate

**Operation**: <reset / force-push / branch -D / checkout -B>
**Target**: <branch / ref>
**Safety tag**: safety/<timestamp> (local, recover with `git reset --hard safety/...`)

### Pre-state
HEAD <sha> "<subject>"
<git log -5 lines>

### Discarded
<git log lines that won't survive the op, with sha>

### Post-state
HEAD <new sha> "<subject>"
<git log -5 lines>

### Recovery
git reset --hard safety/<timestamp>
git push --force-with-lease origin <branch>   # if you need to roll origin back too
```

## Never

- Never bypass gates because the user is in a hurry. The gates are the
  product.
- Never `git push --force` (without `--force-with-lease`) unless the
  user typed those exact words.
- Never `git push --force` to `main` without an explicit second
  confirmation from the user in the same conversation turn.
