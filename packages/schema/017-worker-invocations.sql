-- =============================================================================
-- 017: Worker Invocations
-- =============================================================================
--
-- Immutable log of worker invocations (HTTP and scheduled).
-- Records who triggered it, the prompt, result, timing, and optionally
-- the full agent log.
--
-- =============================================================================

CREATE TABLE worker_invocations (
  id            BIGSERIAL PRIMARY KEY,
  worker_id     TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  invoker_id    TEXT NOT NULL,                              -- actor who triggered the invocation
  source        TEXT NOT NULL,                              -- 'http' | 'scheduler'
  prompt        TEXT NOT NULL,
  success       BOOLEAN NOT NULL,
  summary       TEXT,
  iterations    INT NOT NULL DEFAULT 0,
  error_message TEXT,
  log           JSONB,                                      -- full agent log (optional)
  started_at    TIMESTAMPTZ NOT NULL,
  completed_at  TIMESTAMPTZ NOT NULL,
  duration_ms   INT NOT NULL,
  ts            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT valid_invocation_source CHECK (source IN ('http', 'scheduler'))
);

CREATE INDEX IF NOT EXISTS idx_invocations_worker ON worker_invocations(worker_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_invocations_invoker ON worker_invocations(invoker_id, ts DESC);

-- Immutable log: SELECT and INSERT only, no UPDATE or DELETE
GRANT SELECT, INSERT ON worker_invocations TO arke_app;
GRANT USAGE ON SEQUENCE worker_invocations_id_seq TO arke_app;

-- RLS: visible to worker owner or admin
ALTER TABLE worker_invocations ENABLE ROW LEVEL SECURITY;

CREATE POLICY invocations_select ON worker_invocations
FOR SELECT TO arke_app
USING (
  invoker_id = current_setting('app.actor_id', true)
  OR current_setting('app.actor_is_admin', true) = 'true'
  OR EXISTS (
    SELECT 1 FROM actors a
    WHERE a.id = worker_id AND a.owner_id = current_setting('app.actor_id', true)
  )
);

CREATE POLICY invocations_insert ON worker_invocations
FOR INSERT TO arke_app
WITH CHECK (true);

-- Retention: prune invocations older than 30 days
SELECT cron.schedule(
  'prune-worker-invocations',
  '0 4 * * *',
  $$DELETE FROM worker_invocations WHERE ts < NOW() - INTERVAL '30 days'$$
);
