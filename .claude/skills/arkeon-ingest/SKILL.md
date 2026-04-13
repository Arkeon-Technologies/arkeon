---
name: arkeon-ingest
description: Initialize a repo as an Arkeon knowledge base and build a knowledge graph from its documents.
disable-model-invocation: true
argument-hint: [space-name]
allowed-tools: Bash(npx arkeon *, arkeon *, ls *), Read, Glob, Grep, Write
---

# Arkeon Ingest

Initialize this repository as an Arkeon knowledge base and build a knowledge graph from its documents. Combines setup (space creation, file registration) with extraction (entity and relationship creation from document content).

## Phase 1: Setup

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

Then skip to step 4 (reconcile).

**If the user passed `--force` as part of $ARGUMENTS:** Re-initialize anyway (proceed to step 3).

### 3. Initialize

Inspect the repo first. Use Glob to survey file types (`**/*.md`, `**/*.txt`, `**/*.tex`, etc.) and read the README if present.

Determine the space name:

- If `$ARGUMENTS` provides a name (not `--force`), use it
- Otherwise, infer from the directory name and repo contents. Pick something short and descriptive.

Run:

```bash
npx arkeon init <space-name>
```

Parse the JSON output. Report: space name, space ID, API URL.

If the command fails (e.g., stack not running), report the error and suggest `arkeon up` first.

### 3b. Set up ingestor identity

Check if an "ingestor" profile exists:

```bash
npx arkeon auth profiles
```

If no "ingestor" profile is listed, create one:

```bash
npx arkeon auth add ingestor --kind agent
```

Then ensure it's the active profile:

```bash
npx arkeon auth use ingestor
```

All subsequent commands automatically use the ingestor identity — no manual API key setup needed. The CLI resolves the active profile from `.arkeon/state.json` and the instance actor registry.

### 4. Reconcile files

Run the diff to see what needs syncing:

```bash
npx arkeon diff --json
```

Parse the JSON output. Based on the results:

**New files (added):**

```bash
npx arkeon add <file1> <file2> ...
```

Add files in batches if there are many (shell argument length limits). For directories, pass the directory path and arkeon will recurse.

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

**Up to date:** If the diff shows no changes, report "all documents are current."

### 5. Setup summary

Report what happened:

> **Setup complete.**
> - Space: **{name}** (`{id}`)
> - Documents: {N} added, {M} updated, {D} removed, {U} unchanged

## Phase 2: Ingest

After setup completes, ask the user:

> **{N} documents are ready. Start building the knowledge graph?**

If the user declines, stop. If they agree (or didn't explicitly decline), proceed.

### 6. Survey the graph

Before extracting, understand what already exists:

```bash
npx arkeon search query --q "*" --space-id {space_id} --limit 50
```

Note existing entity types, labels, and relationship predicates. This context informs extraction so you create consistent, connected graphs rather than isolated clusters.

If this is a fresh space with only document entities, note that and proceed — you're building from scratch.

### 7. Plan the extraction

Read a sample of the documents (2-3 files) to understand the corpus. Think about:

- **What entity types make sense for this content?** Start with common types: `person`, `concept`, `work`, `event`, `place`, `organization`. Add domain-specific types as needed (e.g., `theorem`, `species`, `statute`). Don't force types that don't fit — let the content guide you.
- **What relationship predicates capture the connections?** Common ones: `mentions`, `authored`, `influenced_by`, `part_of`, `references`, `argues_for`, `argues_against`, `quotes`. Add domain-specific predicates as needed.
- **What's the density?** A dense philosophical text yields more entities per page than a changelog.

Report your extraction plan to the user before proceeding:

> **Extraction plan:**
> - Entity types I'll use: {list}
> - Relationship predicates: {list}
> - Estimated entities per document: {range}
> - Documents to process: {N}

### 8. Get document list

Retrieve all document entities in the space:

```bash
npx arkeon spaces list-entities {space_id} --limit 200
```

Parse the output. Each document has: `id`, `properties.source_file`, `properties.content`.

### 9. Process each document

For each document entity, in order:

#### a. Check if already ingested

```bash
npx arkeon relationships list {doc_id} --direction in --predicate extracted_from --limit 1
```

If results exist, this document has already been ingested. Skip it and report:

> Skipping **{source_file}** — already ingested ({N} extracted entities).

#### b. Gather context

Before extracting, search for entities that might connect to this document's content. Read the document content, identify key terms, and search:

```bash
npx arkeon search query --q "{key_term}" --space-id {space_id} --limit 20
```

Do 2-3 searches for the most prominent terms. Note any existing entities that this document references — you'll link to them instead of creating duplicates.

#### c. Read and extract

Read the document content (from the entity's `content` property or from the file on disk). Identify:

- **Entities**: People, concepts, works, events, places, arguments — anything that has identity and could be referenced from other documents.
- **Relationships**: How entities connect to each other and to entities already in the graph.

For every entity, provide at minimum:
- `type` — the entity type
- `label` — a short, canonical name
- `description` — a 1-2 sentence description providing context

For every relationship, provide at minimum:
- `source` and `target` — either `@local_ref` for new entities or a bare ULID for existing ones
- `predicate` — the relationship type
- `detail` — a sentence explaining the specific connection

#### d. Write ops

Use the Write tool to create a JSON file with the ops envelope, then submit it:

Write to `/tmp/arkeon-ops.json`:
```json
{
  "format": "arke.ops/v1",
  "defaults": {},
  "source": {"entity_id": "{doc_entity_id}"},
  "ops": [
    {"op": "entity", "ref": "@augustine", "type": "person", "label": "Augustine of Hippo", "description": "Early Church Father and philosopher, bishop of Hippo Regius"},
    {"op": "entity", "ref": "@city_of_god", "type": "work", "label": "De Civitate Dei", "description": "Augustine's treatise contrasting the City of God with the earthly city"},
    {"op": "relate", "source": "@augustine", "target": "@city_of_god", "predicate": "authored", "detail": "Augustine wrote De Civitate Dei between 413-426 AD"},
    {"op": "relate", "source": "@augustine", "target": "01EXISTING_ULID", "predicate": "influenced_by", "detail": "Augustine draws heavily on Platonic philosophy"}
  ]
}
```

Then submit:
```bash
npx arkeon ingest post-ops --data @/tmp/arkeon-ops.json
```

Key rules:
- `source.entity_id` on the envelope creates `extracted_from` edges automatically — never create these manually.
- `defaults.space_id` is auto-injected by the CLI if configured — you don't need to set it.
- Use `@local_ref` for new entities defined in this batch.
- Use bare ULIDs for entities that already exist in the graph (found in step b).
- Stay under 2000 ops per request. One document at a time is fine.
- Do NOT set `read_level` or `write_level` — defaults are applied automatically.

#### e. Report progress

After each document, report:

> **{source_file}**: {N} entities, {M} relationships created.

### 10. Cross-document linking

As you process documents, actively link new entities to entities created from previous documents. When you encounter a concept, person, or work that was already extracted from an earlier document:

1. Search for it: `npx arkeon search query --q "{entity_label}" --space-id {space_id}`
2. If found, use the existing entity's ULID as a bare ref in relate ops instead of creating a duplicate.
3. If the existing entity's description can be enriched with new information from the current document, first get the entity's current `ver` value, then update: `npx arkeon entities update {id} --properties '{"description":"enriched text"}' --ver {ver}`.

This is what makes the graph valuable — connections across documents emerge naturally.

### 11. Final report

After all documents are processed, summarize:

> **Ingest complete.**
> - Documents processed: {N} of {total}
> - Documents skipped (already ingested): {S}
> - Entities created: {E}
> - Relationships created: {R}
> - Cross-document links: {L}
>
> Run `npx arkeon search query --q "{topic}" --space-id {space_id}` to explore the graph.
