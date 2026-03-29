-- =============================================================================
-- Entity Activity Log
-- =============================================================================
--
-- Chronological stream of everything that happens. Single source of truth
-- for change tracking, audit trails, and activity feeds.
--
-- space_id is denormalized for feed queries (populated at write time from
-- the entity's space membership, if applicable).
--
-- =============================================================================

CREATE TABLE entity_activity (
  id        BIGSERIAL PRIMARY KEY,
  entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  space_id  TEXT REFERENCES spaces(id),                    -- denormalized for feed queries
  actor_id  TEXT NOT NULL,                                 -- who did it
  action    TEXT NOT NULL,                                 -- what happened (verb)
  detail    JSONB DEFAULT '{}',                            -- action-specific context
  ts        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_activity_entity ON entity_activity(entity_id, ts DESC);
CREATE INDEX idx_activity_entity_action ON entity_activity(entity_id, action, ts DESC);
CREATE INDEX idx_activity_space ON entity_activity(space_id, ts DESC);
CREATE INDEX idx_activity_actor ON entity_activity(actor_id, ts DESC);
CREATE INDEX idx_activity_ts ON entity_activity(ts DESC);
CREATE INDEX idx_activity_action ON entity_activity(action, ts DESC);

-- Real-time push via LISTEN/NOTIFY
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

-- Grants
GRANT SELECT, INSERT ON entity_activity TO arke_app;
GRANT USAGE, SELECT ON SEQUENCE entity_activity_id_seq TO arke_app;

-- Retention: prune after 15 days (keep entity_created and ownership_transferred)
CREATE EXTENSION IF NOT EXISTS pg_cron;

SELECT cron.schedule(
  'prune-activity',
  '0 3 * * *',
  $$DELETE FROM entity_activity
    WHERE ts < NOW() - INTERVAL '15 days'
      AND action NOT IN ('entity_created', 'ownership_transferred')$$
);
