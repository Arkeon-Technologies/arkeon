# Filtering & Text Search

Structured filtering and text search on entity properties via query parameters. Property filters cover exact matches, numeric ranges, and existence checks. Text search (`q` param) covers substring, multi-keyword, and regex search via `pg_trgm`.

For semantic similarity (meaning-aware search), see `docs/future/SEMANTIC_SEARCH.md`.

## Query Parameter API

### Basic syntax

```
GET /commons/:id/entities?type=book&filter=language:English,year>2020&sort=updated_at
```

| Parameter | Description | Example |
|-----------|-------------|---------|
| `type` | Filter by semantic type | `type=book` |
| `kind` | Filter by structural kind (usually implicit from endpoint) | `kind=entity` |
| `filter` | Comma-separated property filters | `filter=language:English,year>2020` |
| `sort` | Sort field (default: `updated_at`) | `sort=created_at` |
| `order` | Sort direction (default: `desc`) | `order=asc` |
| `limit` | Max results (default: 50, max: 200) | `limit=20` |
| `cursor` | Cursor for pagination | `cursor=eyJ...` |

### Filter operators

Each filter expression is `property_path` + `operator` + `value`.

| Operator | Meaning | Example | SQL |
|----------|---------|---------|-----|
| `:` | Equals | `language:English` | `properties->>'language' = 'English'` |
| `!:` | Not equals | `status!:draft` | `properties->>'status' != 'draft'` |
| `>` | Greater than | `year>2020` | `(properties->>'year')::numeric > 2020` |
| `>=` | Greater or equal | `year>=2020` | `(properties->>'year')::numeric >= 2020` |
| `<` | Less than | `pages<100` | `(properties->>'pages')::numeric < 100` |
| `<=` | Less or equal | `score<=0.5` | `(properties->>'score')::numeric <= 0.5` |
| `?` | Key exists | `doi?` | `properties ? 'doi'` |
| `!?` | Key missing | `doi!?` | `NOT (properties ? 'doi')` |

Numeric operators (`>`, `>=`, `<`, `<=`) cast the value to numeric. If the property value isn't a valid number, the row is excluded (no error).

### Multiple filters

Comma-separated filters are ANDed:

```
GET /commons/:id/works?filter=language:English,year>2020,pages<500
```

→ `WHERE properties->>'language' = 'English' AND (properties->>'year')::numeric > 2020 AND (properties->>'pages')::numeric < 500`

### Nested properties

Use dot notation for nested JSONB paths at any depth:

```
GET /commons/:id/works?filter=metadata.source:arxiv
GET /commons/:id/works?filter=metadata.source.name:arxiv,metadata.source.year>2020
```

→ `WHERE properties->'metadata'->>'source' = 'arxiv'`
→ `WHERE properties->'metadata'->'source'->>'name' = 'arxiv' AND (properties->'metadata'->'source'->>'year')::numeric > 2020`

Postgres JSONB supports arbitrary nesting depth via chained `->` operators.

## Endpoint examples

Everything is scoped to commons. The entry point is always commons — you browse commons, then drill into entities. Organization between entities is done through relationships, not hierarchy. There is no global raw entity listing endpoint.

### List commons (the top-level entry point)

```
GET /commons
GET /commons?filter=visibility:public
GET /commons?sort=created_at&order=asc
```

All commons the caller has access to, paginated. Public commons are visible to everyone; private commons are visible only to members.

### List entities in a commons

```
GET /commons/:id/entities
GET /commons/:id/entities?type=book
GET /commons/:id/entities?type=book&filter=language:English&sort=created_at&order=asc
```

### List sub-commons

```
GET /commons/:id/commons
```

### Direct access by ID

Individual entities and commons are accessible by ID (with permission checks):

```
GET /entities/:id
GET /commons/:id
```

## SQL generation

The API layer parses the filter string into a parameterized query. Filters are always scoped — never a full table scan.

### Scoped query (within a commons)

```sql
SELECT e.* FROM entities e
WHERE e.commons_id = $1                               -- always scoped to a commons
  AND e.kind = 'entity'                               -- only entities (not sub-commons)
  AND e.type = $2                                     -- type filter (if provided)
  AND e.properties->>'language' = $3                  -- filter: language:English
  AND (e.properties->>'year')::numeric > $4           -- filter: year>2020
ORDER BY e.updated_at DESC
LIMIT $5;
```

The commons scope + type filter narrows the result set before property filters run. For a commons with a few thousand entities, this is sub-millisecond even without property indexes.

### Parameterization

Filter values are always passed as parameters, never interpolated into SQL. The API layer validates:

- Property paths match `^[a-zA-Z_][a-zA-Z0-9_.]*$` (no SQL injection via path)
- Operators are from the fixed set above
- Values are parameterized (`$N`)

```typescript
// Pseudocode for filter parsing
function parseFilter(filter: string): FilterClause[] {
  return filter.split(',').map(expr => {
    // Match: key, operator, value
    const match = expr.match(/^([a-zA-Z_][\w.]*)([:!:<>=?]+)(.*)$/);
    if (!match) throw new ValidationError(`Invalid filter: ${expr}`);

    const [, path, op, value] = match;
    return { path, op, value };
  });
}

// Each clause becomes a parameterized WHERE condition
function toSQL(clause: FilterClause, paramIndex: number): string {
  // Build JSONB path: properties->'a'->'b'->>'c' (last segment uses ->> for text)
  const segments = clause.path.split('.');
  const jsonPath = segments.length === 1
    ? `properties->>'${segments[0]}'`
    : `properties->${segments.slice(0, -1).map(s => `'${s}'`).join('->')}->>'${segments.at(-1)}'`;

  switch (clause.op) {
    case ':':  return `${jsonPath} = $${paramIndex}`;
    case '!:': return `${jsonPath} != $${paramIndex}`;
    case '>':  return `(${jsonPath})::numeric > $${paramIndex}`;
    // ... etc
  }
}
```

## Indexing strategy

Start with zero property indexes. Add them only when query profiling shows a need.

### When to add an index

- A specific property is filtered on frequently (e.g., `language` across all books)
- The scoped result set is large enough that scanning is slow (10,000+ rows)
- Query latency exceeds ~50ms

### Index types

```sql
-- Single property path (most common)
CREATE INDEX idx_entities_language ON entities((properties->>'language'));

-- GIN index on entire JSONB (for @> contains queries)
CREATE INDEX idx_entities_properties ON entities USING GIN (properties);

-- Partial index (only for a specific kind/type — smaller, faster)
CREATE INDEX idx_entity_language ON entities((properties->>'language'))
  WHERE kind = 'entity';
```

Partial indexes are the sweet spot — they're smaller because they only cover a subset of rows, and they match the scoped query patterns we're using.

## Pagination

Cursor-based, not offset-based. The cursor encodes the sort field value + entity ID for deterministic ordering:

```
GET /commons/:id/works?sort=updated_at&limit=20
→ { works: [...], cursor: "eyJ0IjoiMjAyNi0wMy0yMVQxMDowMDowMFoiLCJpIjoiMDFBQkMifQ" }

GET /commons/:id/works?sort=updated_at&limit=20&cursor=eyJ...
→ next page
```

Cursor is a base64-encoded JSON object: `{ t: "2026-03-21T10:00:00Z", i: "01ABC" }`. The query becomes:

```sql
WHERE (e.updated_at, e.id) < ($cursor_t, $cursor_i)
ORDER BY e.updated_at DESC, e.id DESC
LIMIT $limit;
```

Using `(updated_at, id)` as a composite sort key guarantees stable pagination even when multiple entities share the same timestamp.

## Text Search

Text search uses `pg_trgm` (trigram matching) for substring, multi-keyword, and regex search on entity properties. No external search service required.

### The `q` parameter

Available on all listing endpoints and the global `/search` endpoint:

```
GET /commons?q=neuroscience
GET /commons/:id/entities?q=neural+network&type=document
GET /search?q=neural+network&commons_id=01X,01Y
```

### Query modes

| Syntax | Mode | SQL generated |
|--------|------|---------------|
| `q=neural+network` | Multi-keyword (AND) | `properties::text ILIKE '%neural%' AND properties::text ILIKE '%network%'` |
| `q=neural network` | Multi-keyword (AND) | Same — split on whitespace |
| `q="exact phrase"` | Phrase | `properties::text ILIKE '%exact phrase%'` |
| `q=/neuro(sci\|log)/` | Regex | `properties::text ~ 'neuro(sci\|log)'` |

- **Multi-keyword:** Each term must appear somewhere in the properties JSON. Terms are AND'd.
- **Phrase:** Quoted string matches as an exact substring.
- **Regex:** Wrapped in `/slashes/`, uses Postgres `~` operator (case-sensitive). Invalid regex returns 400.

### Combining with filters

`q` combines with all existing parameters — `type`, `filter`, `sort`, `cursor`. All conditions are AND'd:

```
GET /commons/:id/entities?q=neural&type=paper&filter=year>2020&sort=created_at
```

→ Entities in this commons matching "neural" in properties, of type "paper", where year > 2020, sorted by creation date.

### How it works

`pg_trgm` breaks text into 3-character subsequences and indexes them with a GIN index. This makes `ILIKE` and `~` (regex) queries fast — Postgres uses the index to narrow candidates before doing exact matching.

The index is on `properties::text`, which is the full JSON text representation. This means searches match against both property keys and values. Scoping by `commons_id`, `kind`, or `type` narrows the result set before trigram matching fires.

### Performance

- Within a commons (hundreds to low thousands of entities): sub-millisecond with the GIN index
- Global search across all visible entities: depends on total corpus size, but RLS + kind/type filters narrow the scan significantly
- For very large datasets (100K+ entities), consider adding Postgres full-text search (`tsvector`) or semantic search (`pgvector`) as documented in `docs/future/SEMANTIC_SEARCH.md`

### Global search

The `/search` endpoint searches across all commons the actor can see:

```
GET /search?q=neural+network                           # all visible entities
GET /search?q=neural+network&commons_id=01X,01Y        # scoped to specific commons
GET /search?q=neural+network&type=document&kind=entity  # with type and kind filters
```

Response includes `commons_id` on each result so the caller knows where it lives.

## What this does NOT cover

These queries go beyond property filtering and text search:

- **"Similar entities to this one"** → Semantic search (future — see `docs/future/SEMANTIC_SEARCH.md`)
- **Faceted search with counts** → Consider Typesense/Meilisearch if needed
- **Ranked results by relevance** → Postgres full-text search (`tsvector`) or semantic search (future)

The boundary:
- Exact property name + value → `filter` param
- Substring/keyword/regex search → `q` param (pg_trgm)
- Meaning-aware similarity → semantic search (future)
