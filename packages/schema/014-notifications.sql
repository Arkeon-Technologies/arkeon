-- =============================================================================
-- Notifications (Inbox)
-- =============================================================================
--
-- Pre-computed inbox. Fan-out happens at the application layer after the
-- primary write commits.
--
-- =============================================================================

CREATE TABLE notifications (
  id           BIGSERIAL PRIMARY KEY,
  recipient_id TEXT NOT NULL,                              -- actor who receives this
  entity_id    TEXT NOT NULL,                              -- what entity was affected
  actor_id     TEXT NOT NULL,                              -- who performed the action
  action       TEXT NOT NULL,                              -- mirrors entity_activity.action
  detail       JSONB DEFAULT '{}',
  ts           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_notifications_recipient ON notifications(recipient_id, ts DESC);
CREATE INDEX idx_notifications_ts ON notifications(ts);

GRANT SELECT, INSERT, DELETE ON notifications TO arke_app;
GRANT USAGE, SELECT ON SEQUENCE notifications_id_seq TO arke_app;

-- Retention: prune after 15 days
SELECT cron.schedule(
  'prune-notifications',
  '0 3 * * *',
  $$DELETE FROM notifications WHERE ts < NOW() - INTERVAL '15 days'$$
);
