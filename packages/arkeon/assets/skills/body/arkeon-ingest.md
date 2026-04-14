# Arkeon Ingest

Initialize this repository as an Arkeon knowledge base and build a knowledge graph from its documents. Combines setup (space creation, file registration) with parallel extraction (sub-agents process document batches) and post-extraction consolidation.

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

**Important:** The ingestor owns the space (it created the space during init), so it has full write access. Other actors need an explicit role grant via `npx arkeon spaces grant --id {space_id} --actor-id {id} --role editor` before they can write to the space. Always use the ingestor profile for ingestion.

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

Read a sample of the documents (3-5 files) to understand the corpus. Think about:

- **What entity types make sense for this content?** Start with common types: `person`, `concept`, `work`, `event`, `place`, `organization`. Add domain-specific types as needed (e.g., `theorem`, `species`, `statute`). Don't force types that don't fit — let the content guide you.
- **What relationship predicates capture the connections?** Common ones: `mentions`, `authored`, `influenced_by`, `part_of`, `references`, `argues_for`, `argues_against`, `quotes`. Add domain-specific predicates as needed.
- **What's the density?** A dense philosophical text yields more entities per page than a changelog.

Report your extraction plan to the user before proceeding:

> **Extraction plan:**
> - Entity types I'll use: {list}
> - Relationship predicates: {list}
> - Estimated entities per document: {range}
> - Documents to process: {N}

**Persist the extraction schema to the space** so the server-side pipeline and future runs use the same config:

```bash
npx arkeon spaces update {space_id} --properties '{"extraction":{"entity_types":[...your types...],"predicates":[...your predicates...],"label_instructions":"Use full formal names without titles or honorifics. Use official organization names.","context":"Brief description of this document collection."}}'
```

This is stored in `space.properties.extraction` and used by both the CLI skill and server-side knowledge pipeline for consistent extraction.

### 8. Get document list

Retrieve all document entities in the space:

```bash
npx arkeon spaces list-entities {space_id} --limit 200
```

Parse the output. Each document has: `id`, `properties.source_file`, `properties.content`.

### 9. Cluster documents into batches

Using the document list from step 8, group documents into related batches for parallel processing. Batches should cluster documents that share:

- Common actors, people, or organizations
- Related topics or themes
- Time periods or geographic regions
- Source type or provenance

Target 3-8 documents per batch. For small corpora (<6 documents), use a single batch.

Report the clustering plan:

> **Batch plan:**
> - Batch 1 ({theme}): {file1}, {file2}, ...
> - Batch 2 ({theme}): {file3}, {file4}, ...
> - ...

### 10. Dispatch sub-agents

For each batch, spawn a sub-agent using the Agent tool. **Run all batch agents in parallel** (send all Agent tool calls in a single message).

Each sub-agent receives a prompt containing:

1. **The batch**: List of document entity IDs and source file paths
2. **The extraction plan**: Entity types, relationship predicates
3. **The space ID**: For graph queries and scoping
4. **Graph context summary**: Existing entities from step 6 (labels, types, IDs)
5. **Quality rules**: The extraction quality standards below
6. **CLI commands**: How to search, create ops, update entities

The sub-agent prompt must include the full extraction protocol (steps 10a-10f below) and all quality examples. The sub-agent has no memory of this skill's instructions — give it everything it needs to work independently.

**Sub-agent failure handling:** If a sub-agent fails or returns an error, report which batch failed and which documents were not processed. Do not retry automatically — report to the user and let them decide whether to re-run the failed batch.

#### Sub-agent extraction protocol:

##### 10a. Check if already ingested

For each document in the batch:

```bash
npx arkeon relationships list {doc_id} --direction in --predicate extracted_from --limit 1
```

If results exist, skip. Report: `Skipping {source_file} — already ingested.`

##### 10b. Gather graph context

Before extracting from each document, search the graph aggressively. Read the document content first, identify 4-5 key terms (names, concepts, places), and search for each:

```bash
npx arkeon search query --q "{key_term}" --space-id {space_id} --limit 20
```

For each hit, note the entity ID, label, type, and description. These are your connection targets — you will link to them by ULID instead of creating duplicates.

**Read existing entity descriptions carefully.** Understanding what's already in the graph is how you build connections rather than isolated clusters.

##### 10c. Read and extract

Read the document content (from the entity's `content` property or from the file on disk). Identify:

- **Entities**: People, concepts, works, events, places, arguments — anything that has identity and could be referenced from other documents.
- **Relationships**: How entities connect to each other and to entities already in the graph.

**Extraction quality standards:**

Every entity description MUST:
- Explain who or what this entity is in the world — not just how it appears in the document
- Use your world knowledge to provide context (historical, scientific, cultural, etc.)
- Be substantive enough to be useful without reading the source document
- Never use phrases like "mentioned in the document" or "referenced in the text"

BAD entity descriptions (do NOT produce these):
- `"Smith — person mentioned in the report"` (says nothing about who Smith is)
- `"Acme Corp — organization discussed in the filing"` (just restates that it appeared)
- `"Project Aurora — referenced in multiple sections"` (no information at all)

GOOD entity descriptions (aim for these):
- `"John Smith — lead architect at Acme Corp who designed the distributed caching layer that reduced p99 latency by 40%"`
- `"Acme Corp — Series B enterprise SaaS company (founded 2019) specializing in real-time data infrastructure for financial services"`
- `"Project Aurora — internal initiative to migrate Acme's monolith to a service mesh architecture, launched Q2 2024 after the March outage"`

Every relationship detail MUST:
- Add information beyond what the predicate already says
- Include timing, significance, consequences, or context
- Never just restate the predicate in sentence form

BAD relationship details (do NOT produce these):
- `"Smith works at Acme Corp"` (for a `works_at` predicate — this is tautological)
- `"Aurora is part of Acme"` (for `part_of` — adds nothing)
- `"Smith is located in New York"` (for `located_in` — just restates it)

GOOD relationship details (aim for these):
- `"Smith joined Acme Corp in 2021 as a senior engineer, promoted to lead architect after the Aurora migration succeeded"` (for `works_at`)
- `"Aurora was Acme's highest-priority internal initiative, consuming 60% of the platform team's bandwidth for two quarters"` (for `part_of`)
- `"Smith relocated to Acme's New York headquarters in 2022 to lead the East Coast engineering hub"` (for `located_in`)

For every entity, provide at minimum:
- `type` — the entity type
- `label` — a short, canonical name
- `description` — a 1-3 sentence description providing analytical context

For every relationship, provide at minimum:
- `source` and `target` — either `@local_ref` for new entities or a bare ULID for existing ones
- `predicate` — the relationship type
- `detail` — a sentence explaining the specific connection with context that goes beyond the predicate

##### 10d. Write ops

Use the Write tool to create a JSON file with the ops envelope, then submit it:

Write to `/tmp/arkeon-ops-{batch}-{doc}.json`:
```json
{
  "format": "arke.ops/v1",
  "defaults": {"upsert_on": ["label", "type"]},
  "source": {"entity_id": "{doc_entity_id}"},
  "ops": [
    {"op": "entity", "ref": "@smith", "type": "person", "label": "John Smith", "description": "Lead architect at Acme Corp who designed the distributed caching layer that reduced p99 latency by 40%"},
    {"op": "entity", "ref": "@aurora", "type": "project", "label": "Project Aurora", "description": "Internal initiative to migrate Acme's monolith to a service mesh architecture, launched Q2 2024"},
    {"op": "relate", "source": "@smith", "target": "@aurora", "predicate": "leads", "detail": "Smith was appointed technical lead of Aurora after demonstrating the caching optimization proof-of-concept"},
    {"op": "relate", "source": "@smith", "target": "01EXISTING_ULID", "predicate": "collaborated_with", "detail": "Smith and Chen co-authored the Aurora architecture RFC, with Smith focusing on the data layer and Chen on service discovery"}
  ]
}
```

Then submit:
```bash
npx arkeon ingest post-ops --data @/tmp/arkeon-ops-{batch}-{doc}.json
```

Key rules:
- **`upsert_on: ["label", "type"]` prevents duplicates automatically.** If an entity with the same label and type already exists in the space, its properties are shallow-merged (new values win) instead of creating a duplicate. This means you do NOT need to search for an entity before creating it — just create it and upsert handles the rest. You still use bare ULIDs when you specifically want to create a relationship to a known existing entity.
- `source.entity_id` on the envelope creates `extracted_from` edges automatically — never create these manually.
- `defaults.space_id` is auto-injected by the CLI if configured — you don't need to set it.
- Use `@local_ref` for new entities defined in this batch.
- Use bare ULIDs for entities that already exist in the graph (found in step 10b) as relationship targets.
- Stay under 2000 ops per request. One document at a time is fine.
- Do NOT set `read_level` or `write_level` — defaults are applied automatically.
- The response includes `action: "created"` or `action: "updated"` for each entity so you can track what happened.

##### 10e. Enrich existing entities

After extracting from each document, check if any existing entities (found in step 10b) should have their descriptions enriched with new information from this document.

If the current document reveals new information about an existing entity that isn't in its current description:

1. Fetch the entity fresh to get its current description and `ver`: `npx arkeon entities get {id}`
2. Write a synthesized description that combines the existing description with the new information
3. Update: `npx arkeon entities update {id} --properties '{"description":"enriched text"}' --ver {ver}`

**Version conflict handling:** Multiple sub-agents may try to enrich the same entity concurrently. If the update fails with a version conflict (409), re-fetch the entity to get the latest `ver` and description, re-synthesize incorporating what the other sub-agent added, and retry the update. One retry is sufficient — if it fails again, skip and let consolidation (step 11b) handle it.

This is critical — entity descriptions should grow richer as more documents are processed, not stay frozen at first-extraction.

##### 10f. Report progress

After each document, report:

> **{source_file}**: {N} entities, {M} relationships created, {E} existing entities enriched.

After the entire batch is done, report a batch summary.

### 11. Consolidation sweep

After ALL sub-agents have completed, run a consolidation pass over the full graph. This catches cross-type duplicates and connections that individual sub-agents couldn't see.

Note: same-label+type duplicates within the space are already prevented by `upsert_on` during extraction. This step only catches **cross-type** duplicates (e.g., "Atlas" created as both "deity" and "titan") or **near-duplicates** with slightly different labels.

#### 11a. Deduplicate entities

Search for entities with similar or identical labels across different types:

```bash
npx arkeon search query --q "{entity_label}" --space-id {space_id} --limit 20
```

Look for cross-type duplicates (same entity created under different types by different sub-agents). When found:

```bash
npx arkeon entities merge {keep_id} {duplicate_id}
```

Prefer keeping the entity with the richer description.

#### 11b. Enrich key entities

For entities that appear across multiple documents (high relationship count), synthesize a comprehensive description drawing on all connected documents:

1. List relationships: `npx arkeon relationships list {id} --limit 50`
2. Read connected document entities to gather context
3. Write a synthesized description that reflects everything known about this entity across the corpus
4. Update: `npx arkeon entities update {id} --properties '{"description":"synthesized text"}' --ver {ver}`

#### 11c. Cross-batch connections

Search for relationships that span batch boundaries. Look for:

- People who appear in documents from different batches
- Events referenced across time periods
- Organizations that connect different topic clusters
- Concepts that bridge different domains

For each discovered connection, create relationship ops:

Write to `/tmp/arkeon-ops-consolidation.json`:
```json
{
  "format": "arke.ops/v1",
  "defaults": {},
  "ops": [
    {"op": "relate", "source": "01ENTITY_A", "target": "01ENTITY_B", "predicate": "collaborated_with", "detail": "Both served on the same committee during 2024, though documented in separate report series"}
  ]
}
```

```bash
npx arkeon ingest post-ops --data @/tmp/arkeon-ops-consolidation.json
```

### 12. Final report

After consolidation, summarize:

> **Ingest complete.**
> - Documents processed: {N} of {total}
> - Documents skipped (already ingested): {S}
> - Batches: {B} (processed in parallel)
> - Entities created: {E}
> - Relationships created: {R}
> - Entities merged (deduplication): {D}
> - Entities enriched (cross-document): {X}
> - Cross-batch connections: {C}
>
> Run `npx arkeon search query --q "{topic}" --space-id {space_id}` to explore the graph.
>
> Open the explorer to visualize what was built: `npx arkeon status` and open the `explorer_url` in your browser.
