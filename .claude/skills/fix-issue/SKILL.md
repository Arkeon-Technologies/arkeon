---
name: fix-issue
description: Fix a GitHub issue in an isolated worktree, test, commit, and open a PR.
disable-model-invocation: true
argument-hint: [issue-number]
allowed-tools: Read, Grep, Glob, Bash(git *, gh *, npm *, psql *, curl *, docker *, pkill *, sleep *, ls *), Edit, Write, Agent, EnterPlanMode, ExitPlanMode
---

# Fix GitHub Issue in Worktree

Fix issue #$ARGUMENTS in an isolated git worktree so `main` stays clean.

## Workflow

### 1. Fetch the issue

!`gh issue view $ARGUMENTS --json title,body,labels,state`

### 2. Plan

Enter plan mode. Read the issue, explore the relevant code, and design your approach.
Get user sign-off before implementing.

### 3. Create a feature branch and worktree

```
git fetch origin
git worktree add .claude/worktrees/issue-$ARGUMENTS -b fix/issue-$ARGUMENTS origin/main
```

Work exclusively inside `.claude/worktrees/issue-$ARGUMENTS/` for all file edits.

### 4. Implement the fix

- Make changes inside the worktree directory
- Follow conventions in CLAUDE.md
- Keep changes minimal and focused

### 5. Migrate and test

From the worktree directory, use the `/local-dev start` skill to bring up an isolated stack.
It will auto-detect the worktree, pick free ports, and save them to `.devports`.

Then run tests and tear down:

```bash
# Source the ports assigned by local-dev
source .claude/worktrees/issue-$ARGUMENTS/.devports

# Run e2e tests against the isolated server
ADMIN_BOOTSTRAP_KEY=ak_test_admin_key_e2e \
E2E_BASE_URL=http://localhost:$API_PORT \
npm run test:e2e -w packages/api

# Stop the isolated stack when done
# (use /local-dev stop from the worktree, or manually:)
lsof -ti:$API_PORT | xargs kill 2>/dev/null || true
PG_PORT=$PG_PORT docker compose -p $PROJECT --profile local-db down
```

### 6. Commit and push

```
cd .claude/worktrees/issue-$ARGUMENTS
git add <changed files>
git commit -m "Fix: <summary>

Fixes #$ARGUMENTS

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
git push -u origin fix/issue-$ARGUMENTS
```

### 7. Open a PR

```
gh pr create \
  --base main \
  --head fix/issue-$ARGUMENTS \
  --title "<short title>" \
  --body "## Summary
<bullet points>

Fixes #$ARGUMENTS

## Test plan
- [ ] e2e tests pass
- [ ] Manual verification

Generated with [Claude Code](https://claude.com/claude-code)"
```

### 8. Cleanup reminder

Tell the user they can clean up after merge:
```
git worktree remove .claude/worktrees/issue-$ARGUMENTS
git branch -d fix/issue-$ARGUMENTS
```

## Rules

- NEVER commit directly to main
- All work happens inside the worktree
- Run migrations if any SQL files changed
- Run e2e tests before opening the PR
- If tests fail, fix and re-test — don't open a broken PR
- CRITICAL: Only ever clean up YOUR OWN worktree (`.claude/worktrees/issue-$ARGUMENTS`). NEVER run `rm -rf .claude/worktrees/`, `git worktree prune`, or remove any other worktree. Other worktrees may contain active work from other sessions. If cleanup is needed, only target the exact worktree path for this issue.
