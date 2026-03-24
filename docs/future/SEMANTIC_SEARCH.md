# Semantic Search (Future Enhancement)

Vector-based semantic search for entities, replacing simple text matching with meaning-aware retrieval.

## Current state: pg_trgm text search

The MVP uses `pg_trgm` for substring/keyword/regex search on entity properties. This covers the "grep" use case — finding documents by known terms. See `docs/FILTERING.md` § Text Search.

What pg_trgm does NOT do:
- **Relevance ranking** — results are match/no-match, not scored
- **Stemming** — "running" won't match "run"
- **Meaning-aware search** — "AI" won't match "artificial intelligence"

## Future enhancement tiers

### Tier 1: Postgres full-text search (tsvector)

Adds word-level search with stemming, ranking, and boolean operators. No external dependencies. Layer this on when relevance-ranked results become important.

```sql
ALTER TABLE entities ADD COLUMN search_tsv tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english',
      coalesce(properties->>'label', '') || ' ' ||
      coalesce(properties->>'description', '')
    )
  ) STORED;

CREATE INDEX idx_entities_search ON entities USING gin(search_tsv);
```

Query:
```sql
SELECT id, type, properties->>'label',
       ts_rank(search_tsv, query) as rank
FROM entities, plainto_tsquery('english', $q) query
WHERE search_tsv @@ query
ORDER BY rank DESC
LIMIT 20;
```

### Tier 2: pgvector (semantic similarity)

Use the `pgvector` extension for meaning-aware search. Requires an embedding pipeline.

```sql
CREATE EXTENSION vector;

ALTER TABLE entities ADD COLUMN embedding vector(1536);

CREATE INDEX idx_entities_embedding ON entities
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
```

Query:
```sql
SELECT id, type, properties->>'label' as label,
       1 - (embedding <=> $query_embedding) as similarity
FROM entities
WHERE kind = 'entity'
ORDER BY embedding <=> $query_embedding
LIMIT 20;
```

Pros: No external service, transactional consistency, simpler architecture.
Cons: May not scale as well as dedicated vector DB for very large datasets. Requires embedding pipeline.

### Tier 3: External vector service (Pinecone, etc.)

Keep vectors in a dedicated service. Better for large-scale cross-corpus search, especially combined with a PageRank-style algorithm using citation graph weights. Only worth it at scale where cross-commons discovery and citation-weighted relevance matter.

## Embedding pipeline (Tier 2+)

When an entity is created or updated, compute embeddings from:
- `properties.label`
- `properties.description`
- Other text fields based on entity type

Use an embedding model (e.g., OpenAI text-embedding-3-small) to generate vectors.

## Search endpoint

The `/search` endpoint and `q` parameter on listing endpoints already exist (pg_trgm). Future tiers would extend the same API surface — add a `mode` parameter or automatically use the best available backend.
