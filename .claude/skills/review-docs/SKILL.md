---
name: review-docs
description: Review docs for staleness after feature work. Compare each doc against the codebase, flag stale content, and update or delete.
disable-model-invocation: true
argument-hint: [all|<filename>]
allowed-tools: Read, Grep, Glob, Bash(git *, ls *, wc *), Edit, Write, Agent
---

# Review Documentation

Review and update `docs/` after feature work that may have made documentation stale.

## When to Run

After any change that:
- Renames concepts, tables, columns, or endpoints
- Removes or replaces features
- Moves code between packages
- Changes the deployment model or infrastructure
- Adds features that were previously listed as "future" or "TODO"

## Process

### 1. Identify scope

If `$ARGUMENTS` is `all`, review every file in `docs/` and `docs/future/`.
If `$ARGUMENTS` is a filename, review only that file.

### 2. Compare each doc against the codebase

For each doc, launch an Explore subagent that:
- Reads the doc
- Searches the codebase for every claim (file paths, function names, endpoints, column names, env vars, table names)
- Reports what's accurate, what's stale, and what's redundant with the code itself

### 3. Apply the docs principles

Each doc should contain ONLY information that is:
- **Architectural context**: Why things are designed this way (not derivable from code)
- **Cross-cutting overviews**: How multiple systems interact (hard to see from one file)
- **Conventions**: Patterns clients/agents should follow that aren't enforced in code
- **Design rationale**: Decisions, trade-offs, and constraints behind the implementation
- **Operational guidance**: Gotchas, failure modes, recommended usage patterns

Each doc should NOT contain:
- Endpoint lists (use `/openapi.json` or `/help`)
- Schema definitions (read the migration SQL)
- Config values and defaults (read `.env.example` or the code)
- Command references already in CLAUDE.md or package.json
- SQL blocks copied from migration files

### 4. For each stale doc, decide:

- **Delete**: Doc is entirely about removed features, or is a stale tracker
- **Trim**: Remove redundant sections, keep unique architectural content
- **Update**: Fix terminology, file paths, column names to match current code
- **Move**: If a "future" doc describes implemented features, move to `docs/`

### 5. Verify

- `git diff --stat` to confirm scope
- Grep for references to deleted docs across `**/*.md`
- Grep for stale terminology (e.g., old table/column names) across remaining docs

## Rules

- Never duplicate information that lives in code — link to it instead
- Docs should explain WHY, not WHAT
- If a doc is <20 lines of unique content, consider merging into another doc or CLAUDE.md
- Keep total docs/ footprint small — fewer accurate docs beat many stale ones
