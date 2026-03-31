# Semantic Search (Future Enhancement)

Vector-based semantic search for entities, adding meaning-aware retrieval on top of keyword search.

## Current state: Meilisearch keyword search

The API uses Meilisearch as the primary search backend, indexing `label`, `description`, and `note` fields from entities. This provides:

- Typo tolerance (edit distance 1-2)
- Prefix search ("clim" matches "climate")
- Relevance ranking (exact > proximity > typo count > position)
- Language stemming ("running" matches "run")
- Faceted filtering on `type`, `kind`, `network_id`, `owner_id`
- ~50ms query latency, often <10ms

When `MEILI_URL` is not set, the API falls back to ILIKE patterns on `properties::text`.

Regex search (`/pattern/` syntax) always uses Postgres `~` directly.

### Architecture

```
Client -> GET /search?q=...
  -> Meilisearch (keyword search, returns ordered IDs)
  -> Postgres (fetch full rows by ID, RLS applied)
  -> Response (relevance-ordered results)
```

Sync is fire-and-forget: entity CUD operations push updates to Meilisearch via `backgroundTask()`. The search index is eventually consistent.

Admin reindex: `POST /admin/reindex` or `npx tsx packages/api/src/lib/reindex.ts`.

## Future enhancement: vector search

### Tier 1: Qdrant sidecar (semantic similarity)

Add Qdrant as a second sidecar for meaning-aware search. Meilisearch handles keyword/typo-tolerant search, Qdrant handles "find similar" and exploratory queries.

```yaml
# docker-compose.yml
qdrant:
  image: qdrant/qdrant
  profiles: ["vectors"]
  ports:
    - "6333:6333"
  volumes:
    - qdrantdata:/qdrant/storage
```

### Tier 2: Cross-corpus discovery

Combine vector similarity with citation graph weights (PageRank-style) for cross-network discovery. Only worth it at scale where cross-commons discovery and citation-weighted relevance matter.

## Embedding pipeline (Tier 1+)

When an entity is created or updated, compute embeddings from:
- `properties.label`
- `properties.description`
- Other text fields based on entity type

Use an embedding model (e.g., OpenAI text-embedding-3-small) to generate vectors.

## Search endpoint

The `/search` endpoint and `q` parameter on listing endpoints already use Meilisearch. Vector search would add a `mode=semantic` parameter or a separate `/search/similar` endpoint.
