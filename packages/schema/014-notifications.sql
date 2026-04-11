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

CREATE INDEX IF NOT EXISTS idx_notifications_recipient ON notifications(recipient_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_ts ON notifications(ts);

GRANT SELECT, INSERT, DELETE ON notifications TO arke_app;
GRANT USAGE, SELECT ON SEQUENCE notifications_id_seq TO arke_app;

-- Retention runs in-process (see packages/api/src/lib/retention.ts),
-- not via pg_cron. An admin-context RLS policy in 015-rls-policies.sql
-- lets the system retention job delete rows across all recipients.
