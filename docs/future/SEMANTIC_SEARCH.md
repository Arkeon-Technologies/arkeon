# Semantic Search (Future Enhancement)

Vector-based semantic search for entities, adding meaning-aware retrieval on top of keyword search.

## Current state: Meilisearch keyword search

The API uses Meilisearch as the primary search backend, indexing `label`, `description`, and `note` fields from entities. This provides:

- Typo tolerance (edit distance 1-2)
- Prefix search ("clim" matches "climate")
- Relevance ranking (exact > proximity > typo count > position)
- Language stemming ("running" matches "run")
- Faceted filtering on `type`, `kind`, `owner_id`
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

Admin reindex: `POST /admin/reindex` or `npx tsx packages/arkeon/src/server/lib/reindex.ts`.

## Future enhancement: Meilisearch vector search

### Tier 1: Native vector search in Meilisearch

Meilisearch supports built-in vector search. Rather than adding a separate vector database (Qdrant, Pinecone, etc.), extend the existing Meilisearch instance with vector embeddings. This keeps the stack simple — one search service handles both keyword and semantic queries.

Configuration changes needed:
- Enable vector store feature in Meilisearch settings
- Configure embedding dimensions and distance metric
- Add vector field to the Meilisearch index schema

### Tier 2: Cross-corpus discovery

Combine vector similarity with citation graph weights (PageRank-style) for cross-network discovery. Only worth it at scale where cross-space discovery and citation-weighted relevance matter.

## Embedding pipeline

When an entity is created or updated, compute embeddings from:
- `properties.label`
- `properties.description`
- Other text fields based on entity type

Use an embedding model (e.g., OpenAI text-embedding-3-small) to generate vectors. Push vectors to Meilisearch alongside the existing keyword index data.

```
Entity CUD -> backgroundTask()
  -> index text fields (existing, keyword search)
  -> compute embedding vector (new)
  -> push both to Meilisearch
```

## Search endpoint

The `/search` endpoint already uses Meilisearch. Vector search would add a `mode=semantic` parameter or a separate `/search/similar` endpoint that leverages Meilisearch's vector search API.

```
GET /search?q=climate+change+effects&mode=semantic
GET /search/similar?entity_id=01ABC...
```
