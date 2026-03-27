-- =============================================================================
-- Entity Activity Log
-- =============================================================================
--
-- Chronological stream of everything that happens to an entity. This is the
-- single source of truth for change tracking, audit trails, and activity feeds.
--
-- REPLACES:
--   - D1 events table (global event stream)
--   - The need for separate updated_at vs touched_at timestamps
--   - Any per-entity changelog concept
--
-- Every mutation in the system writes an activity entry. The global event
-- stream is just a query on this table without an entity_id filter.
--
-- =============================================================================

CREATE TABLE entity_activity (
  id BIGSERIAL PRIMARY KEY,
  entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  commons_id TEXT REFERENCES entities(id),           -- denormalized for feed queries (populated at write time)
  actor_id TEXT NOT NULL,                           -- who did it
  action TEXT NOT NULL,                             -- what happened (verb)
  detail JSONB DEFAULT '{}',                        -- action-specific context
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Per-entity activity (newest first) — "what happened to this entity?"
CREATE INDEX idx_activity_entity ON entity_activity(entity_id, ts DESC);

-- Per-entity filtered by action — "all content updates for this entity"
CREATE INDEX idx_activity_entity_action ON entity_activity(entity_id, action, ts DESC);

-- Per-commons feed — "what happened in this commons?" (single index scan)
CREATE INDEX idx_activity_commons ON entity_activity(commons_id, ts DESC);

-- Per-actor activity — "what did this actor do?"
CREATE INDEX idx_activity_actor ON entity_activity(actor_id, ts DESC);

-- Global feed — "what happened anywhere?" (cursor-based pagination)
CREATE INDEX idx_activity_ts ON entity_activity(ts DESC);

-- Filtered by action — "all content updates", "all access changes"
CREATE INDEX idx_activity_action ON entity_activity(action, ts DESC);

-- =============================================================================
-- Actions
-- =============================================================================
--
-- Content:
--   content_updated    { ver: 3, note: "Fixed typo" }
--   entity_created     { kind: "entity", type: "book" }
--   entity_deleted     {}
--   entity_tombstoned  { ver: 4 }
--
-- Relationships:
--   relationship_created   { relationship_id: "01REL", predicate: "cites", target_id: "01TGT" }
--   relationship_removed   { relationship_id: "01REL", predicate: "cites", target_id: "01TGT" }
--   relationship_updated   { relationship_id: "01REL", ver: 2 }
--
-- Structure (do NOT bump ver):
--   commons_changed    { from: "01OLD", to: "01NEW" }
--
-- Access:
--   access_granted     { target_actor_id: "01ALICE", access_type: "edit" }
--   access_revoked     { target_actor_id: "01ALICE", access_type: "edit" }
--   policy_updated     { view_access: "public", contribute_access: "contributors" }
--   ownership_transferred  { from: "01OLD", to: "01NEW" }
--
-- Comments:
--   comment_created    { comment_id: "01CMT", parent_id?: "01PARENT" }
--   comment_deleted    { comment_id: "01CMT" }
--
-- =============================================================================

-- =============================================================================
-- Real-time Push (LISTEN/NOTIFY)
-- =============================================================================
--
-- Eliminates polling. Clients subscribe to a channel and get pushed
-- notifications when activity occurs.
--
-- IMPORTANT: LISTEN/NOTIFY does NOT work through PgBouncer in transaction
-- mode. The listener process must use a DIRECT (non-pooled) connection.
--
-- =============================================================================

CREATE OR REPLACE FUNCTION notify_activity() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('entity_activity', json_build_object(
    'id', NEW.id,
    'entity_id', NEW.entity_id,
    'actor_id', NEW.actor_id,
    'action', NEW.action
  )::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER activity_notify AFTER INSERT ON entity_activity
FOR EACH ROW EXECUTE FUNCTION notify_activity();

-- =============================================================================
-- updated_at Semantics
-- =============================================================================
--
-- updated_at on the entity is bumped by APPLICATION CODE only on content
-- changes (when ver increments). Activity logging does NOT bump updated_at.
--
-- This avoids write amplification — every activity INSERT was triggering an
-- UPDATE back to the entity row, causing hot-row contention on popular
-- entities and holding locks longer than necessary.
--
-- ETag uses ver (not updated_at). Clients use the activity stream for
-- "freshness" beyond content changes.
--
-- =============================================================================

-- =============================================================================
-- Query Patterns
-- =============================================================================
--
-- Entity changelog:
--   SELECT * FROM entity_activity
--   WHERE entity_id = $id
--   ORDER BY ts DESC LIMIT 50;
--
-- Entity changelog since timestamp:
--   SELECT * FROM entity_activity
--   WHERE entity_id = $id AND ts > $since
--   ORDER BY ts ASC;
--
-- Global event stream (replaces events table):
--   SELECT * FROM entity_activity
--   WHERE id > $cursor
--   ORDER BY id ASC LIMIT 100;
--
-- Activity feed for a commons (single index scan via denormalized commons_id):
--   SELECT * FROM entity_activity
--   WHERE commons_id = $commons_id
--   ORDER BY ts DESC LIMIT 50;
--
-- Note: commons_id is populated at write time from the entity's commons_id.
-- Activity on the commons entity itself is NOT included in the feed —
-- use GET /entities/:id/activity for that. The feed is "what's happening
-- in this commons," not "what's happening to this commons."
--
-- Actor's recent activity:
--   SELECT ea.*, e.type, e.properties->>'label' as entity_label
--   FROM entity_activity ea
--   JOIN entities e ON ea.entity_id = e.id
--   WHERE ea.actor_id = $actor_id
--   ORDER BY ea.ts DESC LIMIT 50;
--
-- Filter by action type:
--   SELECT * FROM entity_activity
--   WHERE entity_id = $id AND action IN ('content_updated', 'entity_created')
--   ORDER BY ts DESC;
--
-- Inbox: see schema/010-notifications.sql (fan-out at application layer via ctx.waitUntil)
--
-- =============================================================================

-- =============================================================================
-- Retention (pg_cron auto-pruning)
-- =============================================================================
--
-- Activity is pruned automatically after 15 days. Permanent actions are kept
-- indefinitely. Content versions are preserved separately in entity_versions.
--
-- Requires: CREATE EXTENSION IF NOT EXISTS pg_cron;
-- (Neon supports pg_cron out of the box)
--
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pg_cron;

SELECT cron.schedule(
  'prune-activity',
  '0 3 * * *',  -- daily at 3am UTC
  $$DELETE FROM entity_activity
    WHERE ts < NOW() - INTERVAL '15 days'
      AND action NOT IN ('entity_created', 'ownership_transferred')$$
);

-- =============================================================================
-- Endpoints
-- =============================================================================
--
-- Entity activity:
--   GET /entities/:id/activity
--   GET /entities/:id/activity?since=2026-03-21T10:00:00Z
--   GET /entities/:id/activity?action=content_updated
--   → [{ id, actor_id, action, detail, ts }, ...]
--
-- Global event stream:
--   GET /activity?since_cursor=123&limit=100
--   → { events: [...], has_more: true, cursor: 223 }
--
-- Commons activity feed (flat lookup via commons_id — no recursive CTE):
--   GET /commons/:id/feed
--   → Activity from everything in the commons
--
-- Actor activity:
--   GET /actors/:actor_id/activity
--   → Everything this actor has done
--
-- =============================================================================
