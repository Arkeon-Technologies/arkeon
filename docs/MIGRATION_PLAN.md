# Postgres Migration Plan

## Why Postgres

The current Cloudflare-native storage architecture (KV, Durable Objects, D1) costs ~$1,374/month and scales linearly with agent activity. The three biggest cost drivers are all read-heavy:

- **KV reads**: $256/mo (511M reads) — every entity fetch pulls a full JSON manifest
- **DO storage reads**: $202/mo (1B reads) — every entity resolve hits a DO for tip (ID → CID)
- **DO compute**: $187/mo — 14.6M GB·s of compute duration
- **D1 row reads**: $123/mo (123B rows) — events table polled constantly by agents

Beyond cost, the architecture has structural problems:

1. **Relationships embedded in manifests.** An entity with 10,000 relationships means every read fetches a massive JSON blob, even if you only need the entity name. Querying across relationships (e.g., "get all peer labels") requires N separate KV fetches.

2. **Permission fields buried in properties.** Checking "can user X edit work Y?" requires fetching the entire manifest, parsing JSON, and extracting `_owner`/`_collaborators`/`_public_edit`. With Postgres, it's an indexed column lookup.

3. **No efficient cross-entity queries.** "Show me all works in this commons that user X can edit" is essentially impossible without fetching every manifest. In Postgres, it's a single JOIN.

4. **Permission changes create unnecessary versions.** Adding a collaborator today bumps the entity version, computes a new CID, stores a new manifest — just to append a user ID to an array. The content didn't change but the version did.

5. **D1 is wrong for event streams.** Agents polling "give me the latest events" causes massive row scans. D1 is SQLite-at-the-edge, not designed for high-throughput read-heavy event streams.

A managed Postgres instance (Neon) replaces KV, DOs, and D1 with a single database at ~$55-70/month, with proper indexing, JOINs, row-level locking for CAS, and LISTEN/NOTIFY for real-time events.

## Infrastructure: Neon

[Neon](https://neon.com) is serverless Postgres (open source storage engine) with:

- **Autoscaling**: 0.25 CU → 16 CU (1 CU = 1 vCPU + 4GB RAM). Scales based on load.
- **Scale to zero**: Compute suspends after 5 min idle. Cold start ~300-500ms.
- **Connection pooling**: PgBouncer with up to 10,000 client connections in transaction mode.
- **Database branching**: Fork the database for testing without copying data.
- **Pricing**: $0.106/CU-hour (Launch), $0.35/GB-month storage, $5/mo minimum.

Estimated cost for Arke: ~$55-70/month (assuming ~8 active hours/day at ~2 CU average).

### Why Neon over alternatives

- **vs Supabase Postgres**: Supabase free tier has aggressive connection limits (~20-30 concurrent via PgBouncer). We've already hit 429 rate limits there. Neon's pooler is built for serverless workloads.
- **vs Hetzner self-hosted**: Fixed cost ($10-20/mo) but requires managing backups, updates, monitoring. Start with Neon, migrate to self-hosted later if costs warrant — it's just Postgres either way.
- **vs staying on Cloudflare**: Per-operation billing is a ticking time bomb for an agentic network where the whole point is increasing activity.

### Connection model from Workers

Workers connect to Neon via the pooled connection string (PgBouncer in transaction mode). This handles thousands of concurrent Workers opening short-lived connections. For LISTEN/NOTIFY (real-time events), a single long-lived direct connection on a separate process.

**Note:** PgBouncer transaction mode does NOT support LISTEN/NOTIFY. Real-time push requires a dedicated listener process using a direct (non-pooled) connection.

## What stays on Cloudflare

- **Workers** — edge routing, auth middleware, request handling (thin proxy to Postgres)
- **R2** — binary file storage ($2/mo, no reason to move)
- **Queues** — async work (notifications, attestation upload). Could eventually replace with pg-boss but no urgency.

## Schema Design

The schema normalizes what's currently embedded in KV manifest JSON into proper relational tables. Key principle: **permissions and structure become columns and join tables; content stays as JSONB.**

### Core entities table

Replaces KV manifests + DO tips in a single table. The `cid` column IS the tip — no separate tip resolution needed.

```sql
CREATE TABLE entities (
  id TEXT PRIMARY KEY,                    -- ULID (or II-prefixed for test)
  type TEXT NOT NULL,                     -- entity type (user, file, document, etc.)
  schema_version TEXT NOT NULL DEFAULT 'arke/eidos@v1',
  ver INTEGER NOT NULL DEFAULT 1,
  cid TEXT NOT NULL,                      -- current version CID (the "tip")
  prev_cid TEXT,                          -- previous version CID
  properties JSONB NOT NULL DEFAULT '{}', -- type-specific content
  edited_by JSONB NOT NULL,               -- audit trail
  note TEXT,                              -- version note
  visibility TEXT DEFAULT 'private',
  network TEXT NOT NULL DEFAULT 'main',   -- 'main' or 'test'
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_entities_type ON entities(type);
CREATE INDEX idx_entities_network ON entities(network);
CREATE INDEX idx_entities_updated ON entities(updated_at);
```

CAS updates use Postgres row-level locking:

```sql
UPDATE entities
SET cid = $new_cid, ver = ver + 1, properties = $props, updated_at = NOW()
WHERE id = $id AND cid = $expected_cid
RETURNING *;
-- 0 rows returned = CAS conflict → 409
```

### Relationships table

Replaces the `relationships[]` array embedded in manifests. This is the single biggest structural improvement — relationships become queryable without fetching manifests.

```sql
CREATE TABLE relationships (
  id BIGSERIAL PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  predicate TEXT NOT NULL,
  peer_id TEXT NOT NULL,                  -- target entity ID
  peer_type TEXT,                         -- type hint
  peer_label TEXT,                        -- display label
  properties JSONB DEFAULT '{}',          -- relationship metadata (role, expiry, etc.)
  UNIQUE(source_id, predicate, peer_id)
);

CREATE INDEX idx_rel_source ON relationships(source_id);
CREATE INDEX idx_rel_peer ON relationships(peer_id);
CREATE INDEX idx_rel_predicate ON relationships(predicate, source_id);
CREATE INDEX idx_rel_source_predicate ON relationships(source_id, predicate);
```

Key queries this enables:

```sql
-- Get all relationships of an entity (replaces manifest fetch + parse)
SELECT * FROM relationships WHERE source_id = $1;

-- Get all peer labels (replaces N KV fetches)
SELECT r.predicate, r.peer_id, e.properties->>'label' as label, e.type
FROM relationships r
JOIN entities e ON r.peer_id = e.id
WHERE r.source_id = $1;

-- Reverse lookup: "who relates to entity X?" (replaces Neo4j for simple cases)
SELECT r.*, e.type, e.properties->>'label' as source_label
FROM relationships r
JOIN entities e ON r.source_id = e.id
WHERE r.peer_id = $1;
```

### Version history

Immutable snapshots for version traversal and Arweave attestation.

```sql
CREATE TABLE entity_versions (
  cid TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  ver INTEGER NOT NULL,
  manifest JSONB NOT NULL,               -- full snapshot (immutable)
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE(entity_id, ver)
);

CREATE INDEX idx_versions_entity ON entity_versions(entity_id, ver DESC);
```

On every create/update, the full manifest is snapshotted here. The `entities` table always reflects the latest version. History is a simple query:

```sql
SELECT ver, cid, created_at, manifest->'edited_by' as edited_by, manifest->>'note' as note
FROM entity_versions
WHERE entity_id = $1
ORDER BY ver DESC;
```

### Commons

Specialized table for commons-specific fields. The commons is also an entity (row in `entities`), but the commons-specific fields (visibility, access) get their own columns for efficient querying and constraint enforcement.

```sql
CREATE TABLE commons (
  id TEXT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
  visibility TEXT NOT NULL CHECK (visibility IN ('public', 'private')),
  access TEXT NOT NULL CHECK (access IN ('open', 'invite')),
  CONSTRAINT valid_visibility_access
    CHECK (NOT (visibility = 'private' AND access = 'open'))
);

CREATE TABLE commons_members (
  commons_id TEXT NOT NULL REFERENCES commons(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  granted_by TEXT NOT NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (commons_id, user_id)
);

CREATE INDEX idx_commons_members_user ON commons_members(user_id);
CREATE INDEX idx_commons_visibility ON commons(visibility);
```

### Works

Specialized table for work-level permissions. Again, also an entity in `entities`, with permission columns extracted for efficient checks.

```sql
CREATE TABLE works (
  id TEXT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
  commons_id TEXT REFERENCES commons(id),   -- nullable (free-floating works)
  _creator TEXT NOT NULL,                    -- immutable
  _owner TEXT NOT NULL,                      -- transferable
  _public_edit BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE work_collaborators (
  work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (work_id, user_id)
);

CREATE INDEX idx_works_commons ON works(commons_id);
CREATE INDEX idx_works_owner ON works(_owner);
CREATE INDEX idx_work_collabs_user ON work_collaborators(user_id);
```

Permission checks become single queries:

```sql
-- "Can user X edit work Y?"
SELECT w._owner, w._public_edit,
       EXISTS(SELECT 1 FROM work_collaborators WHERE work_id = $1 AND user_id = $2) as is_collab
FROM works w WHERE w.id = $1;

-- "Can user X view work Y?"
SELECT w.id, c.visibility,
       EXISTS(SELECT 1 FROM commons_members WHERE commons_id = c.id AND user_id = $2) as is_member
FROM works w
LEFT JOIN commons c ON w.commons_id = c.id
WHERE w.id = $1;

-- "All works I can edit" (impossible efficiently today)
SELECT e.* FROM entities e
JOIN works w ON e.id = w.id
WHERE w._owner = $1
   OR w._public_edit = true
   OR EXISTS(SELECT 1 FROM work_collaborators WHERE work_id = w.id AND user_id = $1);
```

Permission changes (add/remove collaborator, transfer ownership) no longer create new entity versions. The content version stays the same because the content didn't change.

### Parts

Parts are works with a parent pointer and sort order. They have independent permissions.

```sql
CREATE TABLE parts (
  id TEXT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
  work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL,
  _creator TEXT NOT NULL,
  _owner TEXT NOT NULL,
  _public_edit BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE part_collaborators (
  part_id TEXT NOT NULL REFERENCES parts(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  PRIMARY KEY (part_id, user_id)
);

CREATE INDEX idx_parts_work ON parts(work_id, sort_order);
```

Adding a part no longer requires a CAS update on the parent work:

```sql
-- Add part (no parent version bump needed)
INSERT INTO parts (id, work_id, sort_order, _creator, _owner)
VALUES ($1, $2, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM parts WHERE work_id = $2), $3, $3);

-- Get work with parts (replaces parallel KV fetch of N manifests)
SELECT e.*, p.sort_order FROM entities e
JOIN parts p ON e.id = p.id
WHERE p.work_id = $1
ORDER BY p.sort_order;

-- Reorder (single UPDATE, no CAS)
UPDATE parts SET sort_order = CASE id
  WHEN 'part-a' THEN 1
  WHEN 'part-b' THEN 2
  WHEN 'part-c' THEN 3
END WHERE work_id = $1;
```

### Events

Replaces the D1 events table. Same cursor-based pagination, but with LISTEN/NOTIFY for real-time push.

```sql
CREATE TABLE events (
  id BIGSERIAL PRIMARY KEY,
  entity_id TEXT NOT NULL,
  cid TEXT NOT NULL,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_events_ts ON events(ts);

-- Trigger for real-time push (eliminates polling)
CREATE OR REPLACE FUNCTION notify_event() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('entity_changes', json_build_object(
    'id', NEW.id, 'entity_id', NEW.entity_id, 'cid', NEW.cid
  )::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER event_notify AFTER INSERT ON events
FOR EACH ROW EXECUTE FUNCTION notify_event();
```

### Auth tables

Direct migration from D1. Same schema, just in Postgres.

```sql
CREATE TABLE user_mappings (
  supabase_user_id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE klados_api_keys (
  id TEXT PRIMARY KEY,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  klados_pi TEXT NOT NULL,
  owner_pi TEXT NOT NULL,
  created_by_pi TEXT NOT NULL,
  label TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);

CREATE TABLE actor_api_keys (
  id TEXT PRIMARY KEY,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  actor_pi TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'agent')),
  created_by_pi TEXT NOT NULL,
  public_key TEXT,
  label TEXT,
  scopes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);

CREATE TABLE alpha_invites (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  invited_by TEXT NOT NULL DEFAULT 'admin',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  accepted_at TIMESTAMPTZ
);
```

### Attestation queue

Same semantics as D1, just in Postgres.

```sql
CREATE TABLE attestation_queue (
  id BIGSERIAL PRIMARY KEY,
  entity_id TEXT NOT NULL,
  cid TEXT NOT NULL,
  op TEXT NOT NULL,                       -- 'C' or 'U'
  vis TEXT NOT NULL,                      -- 'pub' or 'priv'
  prev_cid TEXT,
  ts TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  retry_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_attestation_status ON attestation_queue(status, created_at);
CREATE INDEX idx_attestation_entity ON attestation_queue(entity_id, cid);
```

### API events (optional: keep monthly D1 or migrate)

API analytics events could stay on D1 monthly databases if desired (they're write-heavy, rarely queried, and already sharded). Or migrate to a single Postgres table with a date partition:

```sql
CREATE TABLE api_events (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL,
  network TEXT NOT NULL,
  user_id TEXT,
  actor_type TEXT,
  route TEXT NOT NULL,
  method TEXT NOT NULL,
  status INTEGER NOT NULL,
  latency_ms INTEGER,
  entity_id TEXT,
  entity_type TEXT,
  action TEXT,
  credits INTEGER DEFAULT 0
) PARTITION BY RANGE (ts);

-- Create monthly partitions
CREATE TABLE api_events_2026_03 PARTITION OF api_events
  FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');
```

## What replaces what

| Current | Postgres replacement |
|---------|---------------------|
| KV manifest storage | `entities` table + `properties` JSONB column |
| DO tip resolve (ID → CID) | `cid` column on `entities` table |
| DO CAS update | `UPDATE ... WHERE cid = $expected RETURNING *` |
| KV version chain traversal | `entity_versions` table, `ORDER BY ver DESC` |
| Embedded relationship arrays | `relationships` table with indexes |
| `_part_sequence` array + parent CAS | `parts` table with `sort_order` column |
| `_collaborators` array in properties | `work_collaborators` / `part_collaborators` join tables |
| D1 events + polling | `events` table + LISTEN/NOTIFY |
| D1 auth tables | Same tables in Postgres |
| `COLLECTION_ENTITY_INDEX` DO | `SELECT FROM entities JOIN relationships ...` |
| `USER_COLLECTIONS_INDEX` DO | `SELECT FROM commons_members WHERE user_id = ?` |
| `COMMONS_CATALOG` DO | `SELECT FROM commons WHERE visibility = 'public'` |
| `WORK_COMMENTS` DO | Comments table in Postgres |
| `INBOX` DO | Inbox table in Postgres |

## Migration phases

### Phase 1: Stand up Neon + migrate events

- Create Neon project, configure pooled connection string in Worker
- Create `events` table in Postgres
- Dual-write events to both D1 and Postgres
- Switch `/events` endpoint to read from Postgres
- Validate, then stop D1 event writes

**Impact**: ~$123/mo D1 row read savings + reduced DO compute from event sync queue.

### Phase 2: Migrate auth tables

- Create auth tables in Postgres
- Migrate existing data from D1
- Switch auth middleware to query Postgres
- Remove D1 auth dependencies

**Impact**: Faster auth lookups, no more Supabase rate limiting risk.

### Phase 3: Migrate entities + relationships

This is the big one. Build a Postgres storage adapter alongside the existing KV/DO adapter.

- Create `entities`, `relationships`, `entity_versions` tables
- Build `PostgresStorageService` implementing the same interface as `KVManifestStorage` + `TipObjectService`
- Dual-write: every create/update writes to both KV/DO and Postgres
- Backfill existing entities from KV into Postgres
- Switch reads to Postgres, validate consistency
- Remove KV/DO dependencies

**Impact**: ~$256 KV + ~$389 DO savings. Selective reads, efficient relationship queries.

### Phase 4: Migrate commons/works/parts

- Create specialized tables (`commons`, `works`, `parts`, membership/collaborator join tables)
- Populate from entity properties during backfill
- Update route handlers to use Postgres directly
- Remove DOs (`COMMONS_CATALOG`, `COLLECTION_ENTITY_INDEX`, etc.)

**Impact**: Permission checks go from full manifest fetch to indexed column lookups.

### Phase 5: Cleanup

- Remove KV manifest storage code
- Remove DO tip service code
- Remove D1 sync queue
- Remove collection/entity index DOs
- Simplify wrangler.jsonc bindings
- Update tests to use Postgres

## Conditional reads (ETag pattern)

With Postgres, clients can avoid redundant data transfer:

```
GET /entities/01ABC...
If-None-Match: "bafkrei..."    # client sends last known CID

Server:
SELECT cid FROM entities WHERE id = $1;
-- If cid matches ETag → 304 Not Modified (zero data transferred)
-- If different → return full entity
```

For agents that want real-time updates, LISTEN/NOTIFY eliminates polling entirely. Agents subscribe to a channel and get pushed notifications when entities change.

## Test/prod network separation

Currently handled by II-prefixed IDs routing to separate D1/KV namespaces. In Postgres, the `network` column on `entities` handles this:

```sql
-- All queries filter by network
SELECT * FROM entities WHERE id = $1 AND network = 'main';
SELECT * FROM events WHERE id > $cursor AND network = 'main' LIMIT 100;
```

Neon database branching could also be used: branch the prod database for E2E tests, run tests against the branch, discard it. This is cleaner than II-prefix isolation and doesn't pollute production data.

## Open questions

1. **Neo4j dependency.** With a `relationships` table, simple traversals (1-2 hops) can be done with JOINs or recursive CTEs. Keep Neo4j only for complex Argo graph queries (multi-hop with semantic search)? Or can Postgres + pg_trgm handle enough?

2. **CID computation.** Still compute CIDs for Arweave attestation and version identification. But CIDs no longer serve as storage keys — they're just version identifiers stored as columns.

3. **R2 file storage.** Keep as-is. Binary files stay on R2 with entity metadata in Postgres.

4. **Queue architecture.** Keep Cloudflare Queues for async work (attestation uploads, notifications) or migrate to pg-boss / graphile-worker? No urgency — queues are cheap.

5. **API events.** Keep on monthly D1 databases (write-heavy, rarely queried, already sharded) or consolidate into Postgres with time-based partitioning?
