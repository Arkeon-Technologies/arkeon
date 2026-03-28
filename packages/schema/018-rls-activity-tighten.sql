-- =============================================================================
-- Tighten RLS: activity follows entity visibility
-- =============================================================================
-- entity_activity SELECT was fully public (anyone could read all activity).
-- This leaks metadata: "entity X was created by actor Y in commons Z" even
-- if the reader can't see entity X.
--
-- Fix: activity is visible if the reader can see the related entity.
-- =============================================================================

DROP POLICY IF EXISTS activity_select ON entity_activity;
CREATE POLICY activity_select ON entity_activity FOR SELECT USING (
  EXISTS(
    SELECT 1 FROM entities e
    WHERE e.id = entity_activity.entity_id
      AND (
        e.view_access = 'public'
        OR e.owner_id = current_actor_id()
        OR EXISTS(
          SELECT 1 FROM entity_access ea
          WHERE ea.entity_id = e.id
            AND (
              ea.actor_id = current_actor_id()
              OR ea.group_id = ANY(current_actor_groups())
            )
        )
      )
  )
);

-- activity INSERT stays permissive (system writes audit entries)
-- No change to activity_insert.

-- =============================================================================
-- Tighten comments SELECT to also include group-based access
-- (Current policy joins entities but doesn't check entity_access groups)
-- =============================================================================

DROP POLICY IF EXISTS comments_select ON comments;
CREATE POLICY comments_select ON comments FOR SELECT USING (
  EXISTS(
    SELECT 1 FROM entities e
    WHERE e.id = comments.entity_id
      AND (
        e.view_access = 'public'
        OR e.owner_id = current_actor_id()
        OR EXISTS(
          SELECT 1 FROM entity_access ea
          WHERE ea.entity_id = e.id
            AND (
              ea.actor_id = current_actor_id()
              OR ea.group_id = ANY(current_actor_groups())
            )
        )
      )
  )
);
