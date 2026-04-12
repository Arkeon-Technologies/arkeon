-- =============================================================================
-- 020: Invocation Queue
-- =============================================================================
--
-- Adds lifecycle tracking to worker_invocations so invocations can be queued
-- before execution. Makes timing columns nullable (unknown at queue time)
-- and adds status + queued_at columns.
--
-- =============================================================================

-- Add status column (default 'completed' so existing rows remain valid)
ALTER TABLE worker_invocations ADD COLUMN status TEXT NOT NULL DEFAULT 'completed';
ALTER TABLE worker_invocations ADD COLUMN queued_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Allow queued records where success/timing are unknown
ALTER TABLE worker_invocations ALTER COLUMN success DROP NOT NULL;
ALTER TABLE worker_invocations ALTER COLUMN started_at DROP NOT NULL;
ALTER TABLE worker_invocations ALTER COLUMN completed_at DROP NOT NULL;
ALTER TABLE worker_invocations ALTER COLUMN duration_ms DROP NOT NULL;

-- Status lifecycle constraint
ALTER TABLE worker_invocations ADD CONSTRAINT valid_invocation_status
  CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled'));

-- Partial index for active invocations (polling / queue management)
CREATE INDEX idx_invocations_active ON worker_invocations(id) WHERE status IN ('queued', 'running');

-- Need UPDATE for status transitions (table was INSERT+SELECT only)
GRANT UPDATE ON worker_invocations TO arke_app;

-- RLS policy for UPDATE (same visibility rules as SELECT)
CREATE POLICY invocations_update ON worker_invocations
FOR UPDATE TO arke_app
USING (
  invoker_id = current_setting('app.actor_id', true)
  OR current_setting('app.actor_is_admin', true) = 'true'
  OR EXISTS (
    SELECT 1 FROM actors a
    WHERE a.id = worker_id AND a.owner_id = current_setting('app.actor_id', true)
  )
);
