---
name: arkeon-setup
description: Initialize a repo as an Arkeon knowledge base — creates a space, registers all files as documents.
disable-model-invocation: true
argument-hint: [space-name]
allowed-tools: Bash(npx arkeon *, arkeon *, ls *), Read, Glob, Grep
---

# Arkeon Setup

Initialize this repository as an Arkeon knowledge base. Creates a space, registers files as document entities.

## Workflow

### 1. Check arkeon is available

```bash
npx arkeon --version
```

If this fails, tell the user:

> Arkeon CLI is not installed. Run `npm install -g arkeon` first.

Then stop.

### 2. Check if already initialized

Look for `.arkeon/state.json` in the repo root.

**If it exists:** Read it and report the current binding:

> This repo is already bound to space **{space_name}** (`{space_id}`) at `{api_url}`.

Then skip to step 5 (reconcile).

**If the user passed `--force` as part of $ARGUMENTS:** Re-initialize anyway (proceed to step 3).

### 3. Inspect the repo

Before initializing, understand what's here. Use Glob to survey:

- `**/*.md` — markdown files
- `**/*.txt` — plain text
- `**/*.tex` — LaTeX
- Top-level directory structure (`ls`)
- README.md or similar (read it if present for context)

Count the files. Note the dominant file types and directory structure.

### 4. Initialize

Determine the space name:

- If `$ARGUMENTS` provides a name (not `--force`), use it
- Otherwise, infer from the directory name and repo contents. Pick something short and descriptive.

Run:

```bash
npx arkeon init <space-name>
```

Parse the JSON output. Report: space name, space ID, API URL.

If the command fails (e.g., stack not running), report the error and suggest `arkeon up` first.

### 5. Reconcile files

Run the diff to see what needs syncing:

```bash
npx arkeon diff --json
```

Parse the JSON output. Based on the results:

**New files (added):**

```bash
npx arkeon add <file1> <file2> ...
```

Add files in batches if there are many (the shell has argument length limits). For directories, you can pass the directory path and arkeon will recurse.

**Modified files:**

```bash
npx arkeon add <modified-file1> <modified-file2> ...
```

These update the document entity in place (stable entity IDs).

**Deleted files:**

```bash
npx arkeon rm <deleted-file1> <deleted-file2> ...
```

These remove the document entity and cascade-delete any extracted entities.

**Up to date:** If the diff shows 0 added, 0 modified, 0 deleted — report "all documents are current."

### 6. Report

Summarize what happened:

> **Setup complete.**
> - Space: **{name}** (`{id}`)
> - Documents: {N} added, {M} updated, {D} removed, {U} unchanged
>
> The next step is to build the knowledge graph from these documents using an ingest workflow.
