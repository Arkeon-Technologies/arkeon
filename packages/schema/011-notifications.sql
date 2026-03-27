-- =============================================================================
-- Notifications (Pre-computed Inbox)
-- =============================================================================
--
-- Fan-out happens at the APPLICATION LAYER (not a database trigger) to avoid
-- blocking the main transaction. After the primary write commits and the
-- response is sent, the Worker uses ctx.waitUntil() to fan out notifications
-- in a separate transaction.
--
-- This avoids expensive read-time JOINs across entities + entity_access
-- on every inbox poll, while also keeping write transactions fast.
--
-- =============================================================================

CREATE TABLE notifications (
  id BIGSERIAL PRIMARY KEY,
  recipient_id TEXT NOT NULL,             -- who this notification is for
  entity_id TEXT NOT NULL,                -- what entity was affected
  actor_id TEXT NOT NULL,                 -- who performed the action
  action TEXT NOT NULL,                   -- what happened (mirrors entity_activity.action)
  detail JSONB DEFAULT '{}',             -- action-specific context (copied from activity)
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Primary inbox query: recipient's notifications in reverse chronological order
CREATE INDEX idx_notifications_recipient ON notifications(recipient_id, ts DESC);

-- Cleanup by time (for pg_cron pruning)
CREATE INDEX idx_notifications_ts ON notifications(ts);

-- RLS: agents can only read their own notifications
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY notifications_select ON notifications
  FOR SELECT USING (recipient_id = current_setting('app.actor_id', true));

-- =============================================================================
-- Fan-out (Application Layer)
-- =============================================================================
--
-- Notification fan-out is handled by the Cloudflare Worker, NOT a database
-- trigger. This keeps the main write transaction fast and avoids holding
-- locks while computing recipients.
--
-- Pattern:
--
--   // In route handler, after main transaction commits:
--   ctx.waitUntil(fanOutNotifications({
--     entity_id, commons_id, actor_id, action, detail, ts
--   }));
--
-- fanOutNotifications() is a single universal helper that handles ALL
-- activity types. It opens a separate DB transaction and determines
-- recipients based on the action type:
--
-- Recipients (all exclude self-actions):
--
--   1. Entity owner — always notified of activity on their entity
--      SELECT owner_id FROM entities WHERE id = $entity_id
--
--   2. Grant holders — anyone with a grant on the entity
--      SELECT DISTINCT actor_id FROM entity_access WHERE entity_id = $entity_id
--      (exclude owner to avoid duplicates with #1)
--
--   3. Target entity owner (relationship actions only)
--      "someone cited your work" / "someone linked to your entity"
--      Actions: relationship_created, relationship_removed, relationship_updated
--      SELECT owner_id FROM entities WHERE id = detail.target_id
--      (exclude if same as source entity owner)
--
--   4. Commons owner (entity_created only)
--      "someone created an entity in your commons"
--      SELECT owner_id FROM entities WHERE id = (entity's commons_id)
--      (exclude if same as entity owner)
--
--   5. Grantee (access_granted only)
--      "you were given access to an entity"
--      Recipient = detail.target_actor_id
--      (exclude if already a grant holder — they were notified via #2)
--
-- The helper collects all unique recipient IDs (excluding the actor),
-- then batch-inserts into notifications.
--
-- If the Worker is terminated mid-fan-out, some notifications may be lost.
-- This is acceptable — notifications are ephemeral (15-day auto-prune)
-- and agents can always poll entity_activity directly for full history.
--
-- =============================================================================

-- =============================================================================
-- Retention (pg_cron auto-pruning)
-- =============================================================================
--
-- Same 15-day retention as entity_activity.
--
-- =============================================================================

SELECT cron.schedule(
  'prune-notifications',
  '0 3 * * *',  -- daily at 3am UTC
  $$DELETE FROM notifications WHERE ts < NOW() - INTERVAL '15 days'$$
);

-- =============================================================================
-- Query Patterns
-- =============================================================================
--
-- Inbox (latest notifications):
--   SELECT * FROM notifications
--   WHERE recipient_id = $me
--   ORDER BY ts DESC LIMIT 50;
--
-- Inbox since last poll:
--   SELECT * FROM notifications
--   WHERE recipient_id = $me AND ts > $since
--   ORDER BY ts DESC LIMIT 50;
--
-- Inbox count since last poll:
--   SELECT COUNT(*) FROM notifications
--   WHERE recipient_id = $me AND ts > $since;
--
-- Inbox filtered by action:
--   SELECT * FROM notifications
--   WHERE recipient_id = $me AND ts > $since
--     AND action IN ('comment_created', 'relationship_created')
--   ORDER BY ts DESC LIMIT 50;
--
-- =============================================================================
