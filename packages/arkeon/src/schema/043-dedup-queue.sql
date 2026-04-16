-- Dedup sweeper queue. Replaces the time-windowed consolidate job.
--
-- Every time an entity is created, its id is enqueued here. A background
-- worker (packages/arkeon/src/server/knowledge/dedup.ts) pops one row at a
-- time per space, searches for candidate duplicates, and — if the LLM judges
-- them the same real-world thing — merges the new entity INTO the existing
-- one. The "new → existing" direction is an invariant: ULIDs never change
-- under dedup, and relationships attached to the canonical entity stay put.
--
-- Primary key is entity_id so re-enqueue attempts (from retries, backfill,
-- etc.) are silent no-ops via ON CONFLICT DO NOTHING.

CREATE TABLE IF NOT EXISTS knowledge_dedup_queue (
  entity_id    text PRIMARY KEY,
  space_id     text NOT NULL,
  enqueued_at  timestamptz NOT NULL DEFAULT NOW(),
  status       text NOT NULL DEFAULT 'pending',
  attempts     int NOT NULL DEFAULT 0,
  last_error   text,
  started_at   timestamptz,
  completed_at timestamptz,
  result       jsonb
);

-- FIFO claim index: covers both 'pending' and 'processing' so FOR UPDATE
-- SKIP LOCKED can efficiently find the next row to work.
CREATE INDEX IF NOT EXISTS idx_dedup_queue_status
  ON knowledge_dedup_queue (status, enqueued_at)
  WHERE status IN ('pending', 'processing');

-- Per-space claim index: the worker picks work one space at a time.
CREATE INDEX IF NOT EXISTS idx_dedup_queue_space
  ON knowledge_dedup_queue (space_id, enqueued_at)
  WHERE status IN ('pending', 'processing');

-- Small meta table for the one-shot backfill marker (and any future dedup
-- housekeeping flags). A single row per key; value is free-form jsonb.
CREATE TABLE IF NOT EXISTS knowledge_dedup_meta (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

-- Grant app-role CRUD. The sweeper itself runs under withAdminSql (admin
-- context), but enqueue from ops-execute happens on request-thread
-- connections, which inherit the request actor's RLS context. No RLS
-- policies are created — these are internal operational tables.
GRANT SELECT, INSERT, UPDATE, DELETE ON knowledge_dedup_queue TO arke_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON knowledge_dedup_meta TO arke_app;

-- Drop the unique-pending-consolidate index — there's no more consolidate
-- job type; the sweeper supplants it. Keep the partial unique index drop
-- idempotent so re-running this migration is a no-op.
DROP INDEX IF EXISTS idx_knowledge_jobs_consolidate_active;
