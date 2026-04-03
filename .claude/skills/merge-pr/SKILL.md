---
name: merge-pr
description: Merge a GitHub PR, watch CI/CD pipeline, and check if publishable packages need a release.
disable-model-invocation: true
argument-hint: [pr-number]
allowed-tools: Bash(gh *, git *, curl *, sleep *), Read, Agent
---

# Merge Pull Request

Merge PR #$ARGUMENTS, monitor the CI/CD pipeline, and flag if a package release is needed.

## Workflow

### 1. Review the PR

```bash
gh pr view $ARGUMENTS --json title,body,state,mergeable,reviewDecision,statusCheckRollup,headRefName,baseRefName
```

- Verify the PR is open and mergeable
- Check if CI status checks have passed (if any are pending, wait)
- If checks are failing, investigate and report — do NOT merge a failing PR

### 2. Merge the PR

```bash
gh pr merge $ARGUMENTS --merge --delete-branch
```

Use `--merge` (merge commit) by default. If the PR is a single commit, `--squash` is also fine.

### 3. Watch the CI/CD pipeline

After merge, `build-push.yml` triggers on push to main. Watch it:

```bash
# Find the run triggered by this merge
sleep 5
gh run list --branch main --limit 1 --json databaseId,status,conclusion,name,headSha -q '.[0]'
```

Then watch it to completion:

```bash
gh run watch <run-id>
```

**If the run succeeds:** Report success. The Docker image has been pushed to ECR and will auto-deploy to running instances within the hour.

**If the run fails:**
1. Get the failure logs:
   ```bash
   gh run view <run-id> --log-failed
   ```
2. Analyze the failure — is it a test failure, build failure, or infra issue?
3. Report the failure to the user with a summary of what went wrong
4. If it's a test failure caused by the merged code, offer to open a fix issue

### 4. Check if publishable packages changed

Compare what changed since the last `v*` tag:

```bash
LAST_TAG=$(git tag -l 'v*' --sort=-v:refname | head -1)
echo "Last release tag: $LAST_TAG"

# Check if CLI or SDK source changed
CLI_CHANGES=$(git diff --name-only "$LAST_TAG"..HEAD -- packages/cli/src/ packages/cli/package.json | head -5)
SDK_CHANGES=$(git diff --name-only "$LAST_TAG"..HEAD -- packages/sdk-ts/src/ packages/sdk-ts/package.json | head -5)
PYTHON_CHANGES=$(git diff --name-only "$LAST_TAG"..HEAD -- packages/sdk-python/ | head -5)
```

If any of these have changes, tell the user:
- Which packages changed since `$LAST_TAG`
- Suggest: "When you're ready to release, push a new tag: `git tag v0.X.X && git push origin v0.X.X`"
- Note: the `publish-packages.yml` workflow handles the rest automatically

If nothing changed, skip this step silently.

### 5. Clean up issue labels

If the merged PR body contains `Fixes #N`, clean up the issue label:

```bash
# Extract issue number from PR body
ISSUE_NUM=$(gh pr view $ARGUMENTS --json body -q '.body' | grep -oP 'Fixes #\K\d+' | head -1)
if [ -n "$ISSUE_NUM" ]; then
  gh issue edit "$ISSUE_NUM" --remove-label "in-review" 2>/dev/null || true
fi
```

This is best-effort — the issue gets closed automatically by GitHub via the `Fixes` keyword, but the label should be cleaned up too.

### 6. Clean up the worktree (if applicable)

Check if a worktree exists for this PR's branch:

```bash
BRANCH=$(gh pr view $ARGUMENTS --json headRefName -q '.headRefName')
# Check common worktree patterns
ls -d .claude/worktrees/*/ 2>/dev/null | while read wt; do
  WT_BRANCH=$(git -C "$wt" branch --show-current 2>/dev/null)
  if [ "$WT_BRANCH" = "$BRANCH" ]; then
    echo "Found worktree for this PR: $wt"
  fi
done
```

If a worktree is found, ask the user if they want to clean it up:
```bash
git worktree remove <path>
```

Do NOT auto-remove — the user or another agent may still be using it.

## Rules

- NEVER merge a PR with failing status checks unless the user explicitly says to
- ALWAYS watch the CI pipeline to completion — don't merge and walk away
- If CI fails, report it immediately with actionable details
- The release check is informational only — don't auto-tag releases
- CRITICAL: Only clean up worktrees that belong to the merged PR's branch. Never touch other worktrees.
