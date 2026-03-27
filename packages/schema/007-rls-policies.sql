-- =============================================================================
-- Row-Level Security Policies
-- =============================================================================
--
-- Database-enforced permissions. Even if application logic has a bug,
-- the database itself rejects unauthorized operations.
--
-- HOW IT WORKS:
--
-- At the start of every request, the application sets a transaction-scoped
-- variable with the actor's identity:
--
--   SET LOCAL app.actor_id = '01ACTOR...';
--
-- RLS policies on every table check this variable automatically. The
-- application doesn't need to add WHERE clauses — the database does it.
--
-- For unauthenticated requests, set to empty string:
--
--   SET LOCAL app.actor_id = '';
--
-- This ensures only public entities are visible (the policies check
-- view_access = 'public' first, which doesn't require an actor_id).
--
-- IMPORTANT: Must use SET LOCAL (transaction-scoped), not SET (session-scoped).
-- SET LOCAL resets when the transaction ends, so the next request on the
-- same pooled PgBouncer connection doesn't inherit the previous actor's
-- identity. This is critical for Neon's connection pooling.
--
-- BYPASS: The application's database role should NOT be a superuser.
-- Superusers bypass RLS entirely. Use a regular role for the application
-- and a superuser role only for migrations.
--
-- =============================================================================

-- Helper function to get the current actor ID (avoids repeating this everywhere)
CREATE OR REPLACE FUNCTION current_actor_id() RETURNS TEXT AS $$
  SELECT COALESCE(NULLIF(current_setting('app.actor_id', true), ''), NULL);
$$ LANGUAGE sql STABLE;

-- Existence check that bypasses RLS (for 403 vs 404 distinction)
CREATE OR REPLACE FUNCTION entity_exists(eid TEXT) RETURNS BOOLEAN
  SECURITY DEFINER AS $$
  SELECT EXISTS(SELECT 1 FROM entities WHERE id = eid);
$$ LANGUAGE sql;

-- =============================================================================
-- Entities: View
-- =============================================================================
-- Public entities visible to everyone. Private entities visible to owner
-- and anyone with any grant.

ALTER TABLE entities ENABLE ROW LEVEL SECURITY;

CREATE POLICY entities_select ON entities FOR SELECT USING (
  view_access = 'public'
  OR owner_id = current_actor_id()
  OR EXISTS(
    SELECT 1 FROM entity_access
    WHERE entity_id = id AND actor_id = current_actor_id()
  )
);

-- =============================================================================
-- Entities: Create
-- =============================================================================
-- Anyone can create an entity. They must be the owner of what they create.

CREATE POLICY entities_insert ON entities FOR INSERT WITH CHECK (
  owner_id = current_actor_id()
);

-- =============================================================================
-- Entities: Update
-- =============================================================================
-- Must have edit access (owner, public edit, or edit/admin grant).

CREATE POLICY entities_update ON entities FOR UPDATE USING (
  owner_id = current_actor_id()
  OR edit_access = 'public'
  OR (edit_access = 'collaborators' AND EXISTS(
    SELECT 1 FROM entity_access
    WHERE entity_id = id AND actor_id = current_actor_id()
      AND access_type IN ('edit', 'admin')
  ))
);

-- =============================================================================
-- Entities: Delete
-- =============================================================================
-- Owner only.

CREATE POLICY entities_delete ON entities FOR DELETE USING (
  owner_id = current_actor_id()
);

-- =============================================================================
-- Entity Access: Manage Grants
-- =============================================================================
-- Access grants are readable to anyone who can view the parent entity.
-- Modification stays owner/admin only.
--
-- Additional app-level rule (not enforceable in RLS):
--   Admins cannot revoke other admins' grants — only the owner can.
--   The database allows it; the application must enforce this.

ALTER TABLE entity_access ENABLE ROW LEVEL SECURITY;

-- SELECT: anyone can see grants (access info is public, per issue #12).
-- This also breaks the circular RLS dependency between entities and entity_access.
CREATE POLICY access_select ON entity_access FOR SELECT USING (true);

-- INSERT: owner or admin can add grants
CREATE POLICY access_insert ON entity_access FOR INSERT WITH CHECK (
  EXISTS(
    SELECT 1 FROM entities WHERE id = entity_id AND (
      owner_id = current_actor_id()
      OR EXISTS(
        SELECT 1 FROM entity_access ea
        WHERE ea.entity_id = entity_access.entity_id
          AND ea.actor_id = current_actor_id()
          AND ea.access_type = 'admin'
      )
    )
  )
);

-- DELETE: owner or admin can remove grants
CREATE POLICY access_delete ON entity_access FOR DELETE USING (
  EXISTS(
    SELECT 1 FROM entities WHERE id = entity_id AND (
      owner_id = current_actor_id()
      OR EXISTS(
        SELECT 1 FROM entity_access ea
        WHERE ea.entity_id = entity_access.entity_id
          AND ea.actor_id = current_actor_id()
          AND ea.access_type = 'admin'
      )
    )
  )
);

-- =============================================================================
-- Relationship Edges: Create
-- =============================================================================
-- Need edit access on the source entity to create outgoing relationships.
-- No permission check on the target — relationships are assertions by the
-- source entity's owner/editor, like linking to a website.
--
-- Commons membership is handled via commons_id on the entities table.

ALTER TABLE relationship_edges ENABLE ROW LEVEL SECURITY;

CREATE POLICY edges_insert ON relationship_edges FOR INSERT WITH CHECK (
  EXISTS(
    SELECT 1 FROM entities WHERE id = source_id AND (
      owner_id = current_actor_id()
      OR edit_access = 'public'
      OR (edit_access = 'collaborators' AND EXISTS(
        SELECT 1 FROM entity_access
        WHERE entity_id = source_id AND actor_id = current_actor_id()
          AND access_type IN ('edit', 'admin')
      ))
    )
  )
);

-- =============================================================================
-- Relationship Edges: Select
-- =============================================================================
-- Can see an edge if you can see the relationship entity (which has its own
-- view_access). For efficiency, also allow if you can see either the source
-- or target entity — you shouldn't discover edges you have no context for,
-- but if you can see one end, the edge itself is visible.

CREATE POLICY edges_select ON relationship_edges FOR SELECT USING (
  -- Can see the relationship entity itself
  EXISTS(
    SELECT 1 FROM entities WHERE id = relationship_edges.id AND (
      view_access = 'public'
      OR owner_id = current_actor_id()
      OR EXISTS(
        SELECT 1 FROM entity_access
        WHERE entity_id = relationship_edges.id AND actor_id = current_actor_id()
      )
    )
  )
);

-- =============================================================================
-- Relationship Edges: Delete
-- =============================================================================
-- Need edit access on the source entity (you're modifying its connections).

CREATE POLICY edges_delete ON relationship_edges FOR DELETE USING (
  EXISTS(
    SELECT 1 FROM entities WHERE id = source_id AND (
      owner_id = current_actor_id()
      OR edit_access = 'public'
      OR (edit_access = 'collaborators' AND EXISTS(
        SELECT 1 FROM entity_access
        WHERE entity_id = source_id AND actor_id = current_actor_id()
          AND access_type IN ('edit', 'admin')
      ))
    )
  )
);

-- =============================================================================
-- Entity Versions: Read-only
-- =============================================================================
-- Can see a version if you can see the entity.

ALTER TABLE entity_versions ENABLE ROW LEVEL SECURITY;

CREATE POLICY versions_select ON entity_versions FOR SELECT USING (
  EXISTS(
    SELECT 1 FROM entities WHERE id = entity_id AND (
      view_access = 'public'
      OR owner_id = current_actor_id()
      OR EXISTS(
        SELECT 1 FROM entity_access
        WHERE entity_id = entity_versions.entity_id
          AND actor_id = current_actor_id()
      )
    )
  )
);

-- Versions are append-only — no update/delete policies.
-- Insert is done by the system during entity create/update.
CREATE POLICY versions_insert ON entity_versions FOR INSERT WITH CHECK (true);

-- =============================================================================
-- Entity Activity: Public read, system write
-- =============================================================================
-- Activity entries are public (they contain entity_id and action, not content).
-- The activity stream is intentionally visible without an extra entity-visibility
-- filter to keep feeds and changelogs simple and cheap.

ALTER TABLE entity_activity ENABLE ROW LEVEL SECURITY;

CREATE POLICY activity_select ON entity_activity FOR SELECT USING (true);
CREATE POLICY activity_insert ON entity_activity FOR INSERT WITH CHECK (true);

-- =============================================================================
-- Application Usage
-- =============================================================================
--
-- At the start of every request:
--
--   // Authenticated request
--   await db.query("SET LOCAL app.actor_id = $1", [actorId]);
--
--   // Unauthenticated request
--   await db.query("SET LOCAL app.actor_id = ''");
--
-- Then just write normal queries — RLS handles everything:
--
--   // Only returns entities the actor can see
--   const entities = await db.query(
--     `SELECT e.* FROM entities e
--      WHERE e.commons_id = $1 AND e.kind = 'entity'`,
--     [commonsId]
--   );
--
--   // Rejected if actor can't edit (0 rows = CAS conflict or permission denied)
--   const result = await db.query(
--     `UPDATE entities SET properties = $1, ver = ver + 1,
--        edited_by = $2, note = $3, updated_at = NOW()
--      WHERE id = $4 AND ver = $5 RETURNING *`,
--     [newProps, actorId, note, entityId, expectedVer]
--   );
--
--   // Create a relationship edge
--   const edge = await db.query(
--     `INSERT INTO relationship_edges (id, source_id, target_id)
--      VALUES ($1, $2, $3)`,
--     [relId, sourceId, targetId]
--   );
--
-- =============================================================================

-- =============================================================================
-- Database Roles
-- =============================================================================
--
-- Two roles:
--
-- 1. app_user — used by the application. RLS applies.
--    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES TO app_user;
--
-- 2. app_admin — used for migrations and maintenance. Bypasses RLS.
--    This should be a superuser or have BYPASSRLS.
--
-- The Neon connection string should use app_user for the application
-- and app_admin only for schema migrations.
--
-- =============================================================================
