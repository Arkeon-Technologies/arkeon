# Knowledge Extraction Pipeline

The server-side knowledge pipeline automatically extracts entities and relationships from uploaded documents. This doc covers the architecture, how to test it, and how space-level configuration works.

For the `POST /ops` format and upsert behavior, see [INGEST_OPS.md](./INGEST_OPS.md).

## Pipeline Flow

```
content upload → poller → ingest → [route by MIME] → extract (LLM) → materialize → ops upsert → dedupe (LLM)
```

1. **Poller** watches `entity_activity` for `content_uploaded` events, enqueues ingest jobs
2. **Ingest** fetches the entity, reads space config, routes by MIME type (PDF/PPTX/DOCX/text)
3. **Extract** calls the LLM with a prompt built from global + space extraction config
4. **Materialize** expands inline shell entities from relationships into explicit entities
5. **Ops upsert** submits all entities + relationships via `POST /ops` with `upsert_on: ["label", "type"]`
6. **Dedupe** runs post-write LLM fuzzy matching to flag near-duplicates

Large documents get an additional survey → chunk → fan-out step before extraction.

## Write Path: POST /ops with Upsert

The pipeline writes entities via a single atomic `POST /ops` call instead of individual API calls. The ops envelope uses:

- `defaults.upsert_on: ["label", "type"]` — deterministic dedup by `(type, lower(label), space_id)`
- `defaults.space_id` — scopes entities to the source document's space
- `source.entity_id` — auto-creates `extracted_from` edges for provenance

On re-extraction, entities with matching type + label in the same space are **updated** (shallow property merge) rather than duplicated.

### Retry Loop

If the ops call fails, the pipeline retries up to 2 times:

| Error | Strategy |
|-------|----------|
| `cas_conflict` (409) | Simple retry — upsert picks up latest version |
| Server error (500) | Retry with backoff |
| `ops_validation_failed` (422) | Feed errors to LLM, get fixed ops, retry |
| `target_not_found` (404) | Feed to LLM (removes dangling relate op), retry |
| `forbidden` (403) | Throw immediately (non-retryable) |

## Space Extraction Config

Per-space extraction schema is stored in `space.properties.extraction`:

```json
{
  "extraction": {
    "entity_types": ["person", "organization", "location"],
    "predicates": ["works_at", "located_in", "leads"],
    "label_instructions": "Use full formal names without titles.",
    "context": "Research papers from MIT, 2024-2026."
  }
}
```

When a document is in a space with this config:
- `entity_types` overrides global config, treated as strict
- `predicates` overrides global config, treated as strict
- `label_instructions` appended to the extraction prompt
- `context` prepended to the extraction prompt
- Global `custom_instructions` still applies alongside space config

If no `properties.extraction` exists on the space, global `extraction_config` is used unchanged.

Requires `scope_to_space: true` in the global extraction config (`PUT /knowledge/config`).

## Testing

### Running the manual test suite

The manual tests require a running arkeon stack with `--knowledge` and a real OpenAI API key.

```bash
# Start the stack with knowledge pipeline
npx tsx packages/arkeon/src/index.ts up --knowledge

# Run from the repo root (works in worktrees too)
ADMIN_BOOTSTRAP_KEY="$(cat ~/.arkeon/secrets.json | python3 -c 'import json,sys; print(json.load(sys.stdin)["adminBootstrapKey"])')" \
OPENAI_API_KEY="sk-..." \
  node_modules/.bin/vitest run --config packages/arkeon/vitest.manual.config.ts
```

The `test/manual/knowledge-llm.test.ts` suite tests permission inheritance on extracted entities: `read_level`, `write_level`, `owner_id`, and permission grants are all copied from the source document.

**From a worktree:** Use the absolute path to the vitest binary in the main repo's `node_modules`:

```bash
ADMIN_BOOTSTRAP_KEY="..." OPENAI_API_KEY="sk-..." \
  /path/to/main/repo/node_modules/.bin/vitest run --config vitest.manual.config.ts
```

This avoids the path-doubling issue where vitest's workspace detection prepends `packages/arkeon/` to relative config paths.

### Ad-hoc verification

For quick end-to-end checks without the test suite:

```bash
API_KEY="$(cat ~/.arkeon/secrets.json | python3 -c 'import json,sys; print(json.load(sys.stdin)["adminBootstrapKey"])')"

# 1. Create a space with extraction config
curl -X POST http://localhost:8000/spaces \
  -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" \
  -d '{"name":"Test Space","properties":{"extraction":{"entity_types":["person","organization"],"predicates":["works_at"]}}}'

# 2. Create a document entity in the space
curl -X POST http://localhost:8000/entities \
  -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" \
  -d '{"type":"document","properties":{},"space_id":"<SPACE_ID>"}'

# 3. Upload content (triggers extraction via poller within ~10s)
curl -X POST "http://localhost:8000/entities/<ENTITY_ID>/content?key=test.txt&ver=1" \
  -H "X-API-Key: $API_KEY" -H "Content-Type: text/plain" \
  -d 'Jane Smith works at Acme Corp in Seattle.'

# 4. Check job status
curl http://localhost:8000/knowledge/jobs -H "X-API-Key: $API_KEY"

# 5. Check job logs for "Writing to graph via ops upsert"
curl http://localhost:8000/knowledge/jobs/<JOB_ID> -H "X-API-Key: $API_KEY"
```

### What to verify

- Job logs show `"Writing to graph via ops upsert"` (not individual API calls)
- First extraction: all entities `created`
- Re-extraction of same content or overlapping content: some entities `updated` (not duplicated)
- Space config: entity types constrained to space list, labels follow `label_instructions`
- `extracted_from` edges auto-created (check entity relationships)
- Post-write dedupe runs and flags fuzzy matches

## Key Files

| File | Purpose |
|------|---------|
| `pipeline/ingest.ts` | Entry point: routes content, reads space config |
| `pipeline/extract.ts` | LLM extraction with space config merge |
| `pipeline/run-pipeline.ts` | Orchestration: materialize → ops → dedupe |
| `pipeline/write.ts` | Ops envelope builder, retry loop, LLM fix |
| `pipeline/dedupe.ts` | Post-write LLM fuzzy matching |
| `pipeline/materialize.ts` | Shell entity expansion |
| `lib/arke-client.ts` | SDK wrappers including `submitOpsEnvelope` |
| `lib/config.ts` | Global extraction config |
| `lib/types.ts` | `SpaceExtractionConfig` and pipeline types |
