# Filtering & Text Search

The Worker exposes one unified query system for listing and search endpoints:

- `filter=` for exact/range/existence filters
- `q=` for substring, phrase, and regex search
- `sort`, `order`, `limit`, and `cursor` for deterministic pagination

The current filter implementation can target both top-level entity columns and
nested `properties` paths. It is not limited to JSON properties anymore.

For semantic similarity search, see [SEMANTIC_SEARCH.md](/Users/chim/Working/arke_institute/arke-api/docs/future/SEMANTIC_SEARCH.md).

## Where it applies

These query conventions are used by:

- `GET /commons`
- `GET /commons/:id/entities`
- `GET /commons/:id/commons`
- `GET /search`

Other endpoints use the same cursor pattern but may expose endpoint-specific
query params instead of the full filter/search set.

## Query parameters

| Parameter | Description |
|-----------|-------------|
| `filter` | Comma-separated filter expressions, ANDed together |
| `q` | Text search over `properties::text` |
| `sort` | Sort field allowed by the endpoint |
| `order` | `asc` or `desc` |
| `limit` | Page size, default `50`, max `200` |
| `cursor` | Opaque pagination cursor |
| `view` | `summary` or `full` projection |
| `fields` | Explicit property projection override |

## Filter syntax

Each filter expression is:

```text
path<operator>value
```

Examples:

```text
filter=kind:entity
filter=type:book,year>2020
filter=commons_id:01ABC,label:Neuroscience
filter=metadata.source:arxiv,updated_at>2026-01-01T00:00:00Z
filter=description!?
```

Multiple expressions are comma-separated and ANDed together.

## Operators

| Operator | Meaning | Example |
|----------|---------|---------|
| `:` | equals | `type:book` |
| `!:` | not equals | `kind!:relationship` |
| `>` | greater than | `ver>3` |
| `>=` | greater than or equal | `created_at>=2026-01-01T00:00:00Z` |
| `<` | less than | `updated_at<2026-06-01T00:00:00Z` |
| `<=` | less than or equal | `year<=2024` |
| `?` | exists / not null | `label?` |
| `!?` | missing / null | `description!?` |

## Top-level columns

If the path matches one of these entity columns, the filter targets the column
directly instead of drilling into `properties`:

| Column | Type |
|--------|------|
| `kind` | text |
| `type` | text |
| `ver` | numeric |
| `owner_id` | text |
| `commons_id` | text |
| `view_access` | text |
| `edit_access` | text |
| `contribute_access` | text |
| `edited_by` | text |
| `created_at` | timestamp |
| `updated_at` | timestamp |

Examples:

```text
filter=kind:commons
filter=owner_id:01ABC,view_access:public
filter=created_at>2026-01-01T00:00:00Z
filter=ver>=2
```

Text columns support `:` and `!:`. Numeric and timestamp columns also support
range operators. `?` and `!?` map to `IS NOT NULL` and `IS NULL`.

## Property paths

Any non-whitelisted path is treated as a `properties` lookup. Nested paths use
dot notation:

```text
filter=label:Neuroscience
filter=metadata.source:arxiv
filter=metadata.source.year>2020
filter=author.name:Grace Hopper
```

Property existence checks also use the same syntax:

```text
filter=doi?
filter=metadata.abstract!?
```

Numeric comparisons on property paths cast the extracted value to `numeric`.

## Implicit route filters

Some listing routes prepend fixed filters before user filters:

- `GET /commons` always includes `kind:commons`
- `GET /commons/:id/entities` always includes `kind:entity,commons_id:<id>`
- `GET /commons/:id/commons` always includes `kind:commons,commons_id:<id>`
- `GET /search` defaults to `kind!:relationship` unless the caller explicitly
  includes a `kind` filter

This means callers can rely on route semantics without manually repeating the
obvious scope constraints.

## Sorting and pagination

Pagination is cursor-based, never offset-based. Cursors encode the current sort
value plus the row ID.

Example:

```http
GET /commons/:id/entities?sort=updated_at&order=desc&limit=20
```

Response shape:

```json
{
  "entities": [...],
  "cursor": "eyJ0IjoiMjAyNi0wMy0yMVQxMDowMDowMFoiLCJpIjoiMDFBQkMifQ=="
}
```

The next page reuses that cursor:

```http
GET /commons/:id/entities?sort=updated_at&order=desc&limit=20&cursor=...
```

The Worker normalizes cursor timestamps to ISO 8601, so page boundaries remain
stable across routes.

Allowed sort fields are endpoint-specific:

- `GET /commons`: `updated_at`, `created_at`, `entity_count`, `last_activity_at`
- `GET /commons/:id/entities`: `updated_at`, `created_at`
- `GET /commons/:id/commons`: `updated_at`, `created_at`
- `GET /search`: `updated_at`, `created_at`

## Text search

`q` searches `properties::text` using simple SQL patterns:

- unquoted text: split on whitespace, ANDed with `ILIKE`
- quoted phrase: single `ILIKE '%phrase%'`
- `/regex/`: Postgres `~` against `properties::text`

Examples:

```http
GET /commons?q=neuroscience
GET /commons/:id/entities?q=\"neural network\"
GET /search?q=/neuro(science|logy)/
GET /search?q=paper&filter=type:document,created_at>2026-01-01T00:00:00Z
```

Search is combined with filters using `AND`.

Notes:

- regex mode uses Postgres `~` and is case-sensitive
- search currently scans `properties::text`, so both keys and values can match
- invalid filter expressions return `400 invalid_filter`
- invalid sort/order/cursor inputs return `400 invalid_query` or
  `400 invalid_cursor`

## Performance notes

The query system is intentionally simple:

- filters are parameterized
- route-level scope filters narrow the candidate set early
- search uses `pg_trgm` over `properties::text`

If query latency starts to climb, add targeted indexes based on observed access
patterns rather than pre-indexing every property path.
