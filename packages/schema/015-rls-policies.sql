-- =============================================================================
-- Row-Level Security Policies (v2)
-- =============================================================================
--
-- RLS enforces BOTH classification AND ACL.
--   - Reads: classification check (integer comparison)
--   - Writes: classification ceiling + ACL (owner/editor/admin/group membership)
--
-- The app layer can still do pre-checks for better error messages (403 vs 404),
-- but the database is the final authority. A route that forgets to check
-- permissions will still be blocked by RLS.
--
-- Session context (set by middleware per request):
--   app.actor_id          — authenticated actor's ID
--   app.actor_read_level  — actor's max_read_level (int, -1 if unauth)
--   app.actor_write_level — actor's max_write_level (int, -1 if unauth)
--   app.actor_is_admin    — actor's is_admin flag (bool)
--
-- =============================================================================


-- =============================================================================
-- HELPER: check if current actor has a given role (or higher) on an entity
-- =============================================================================
--
-- Checks: owner, direct actor grant, or group grant.
-- role_check should be an array of acceptable roles.
--
-- =============================================================================

CREATE OR REPLACE FUNCTION actor_has_entity_role(
  p_entity_id TEXT,
  p_roles TEXT[]
) RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM entity_permissions ep
    WHERE ep.entity_id = p_entity_id
    AND ep.role = ANY(p_roles)
    AND (
      (ep.grantee_type = 'actor' AND ep.grantee_id = current_actor_id())
      OR (ep.grantee_type = 'group' AND EXISTS (
        SELECT 1 FROM group_memberships gm
        WHERE gm.group_id = ep.grantee_id::text
        AND gm.actor_id = current_actor_id()
      ))
    )
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER;


CREATE OR REPLACE FUNCTION actor_has_space_role(
  p_space_id TEXT,
  p_roles TEXT[]
) RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM space_permissions sp
    WHERE sp.space_id = p_space_id
    AND sp.role = ANY(p_roles)
    AND (
      (sp.grantee_type = 'actor' AND sp.grantee_id = current_actor_id())
      OR (sp.grantee_type = 'group' AND EXISTS (
        SELECT 1 FROM group_memberships gm
        WHERE gm.group_id = sp.grantee_id::text
        AND gm.actor_id = current_actor_id()
      ))
    )
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER;


-- =============================================================================
-- ENTITIES
-- =============================================================================

ALTER TABLE entities ENABLE ROW LEVEL SECURITY;

-- SELECT: classification-gated reads
CREATE POLICY entities_select ON entities
FOR SELECT TO arke_app
USING (
  read_level = 0
  OR current_actor_read_level() >= read_level
);

-- INSERT: classification ceiling (creator becomes owner, no ACL check needed)
CREATE POLICY entities_insert ON entities
FOR INSERT TO arke_app
WITH CHECK (
  current_actor_write_level() >= write_level
  AND current_actor_read_level() >= read_level
);

-- UPDATE: classification ceiling + ACL
-- Must be owner, have editor/admin grant, or be system admin
CREATE POLICY entities_update ON entities
FOR UPDATE TO arke_app
USING (
  current_actor_write_level() >= write_level
  AND current_actor_read_level() >= read_level
  AND (
    owner_id = current_actor_id()
    OR current_actor_is_admin()
    OR actor_has_entity_role(id, ARRAY['editor', 'admin'])
  )
)
WITH CHECK (
  current_actor_write_level() >= write_level
  AND current_actor_read_level() >= read_level
);

-- DELETE: classification ceiling (read + write) + admin ACL
-- Must be owner, have admin grant, or be system admin
CREATE POLICY entities_delete ON entities
FOR DELETE TO arke_app
USING (
  current_actor_write_level() >= write_level
  AND current_actor_read_level() >= read_level
  AND (
    owner_id = current_actor_id()
    OR current_actor_is_admin()
    OR actor_has_entity_role(id, ARRAY['admin'])
  )
);


-- =============================================================================
-- ENTITY PERMISSIONS
-- =============================================================================

ALTER TABLE entity_permissions ENABLE ROW LEVEL SECURITY;

-- SELECT: visible if the parent entity is visible (classification-gated)
CREATE POLICY entity_perms_select ON entity_permissions
FOR SELECT TO arke_app
USING (
  current_actor_is_admin()
  OR EXISTS (
    SELECT 1 FROM entities e
    WHERE e.id = entity_id
    AND (e.read_level = 0 OR current_actor_read_level() >= e.read_level)
  )
);

-- INSERT: must be owner or admin of the entity
CREATE POLICY entity_perms_insert ON entity_permissions
FOR INSERT TO arke_app
WITH CHECK (
  current_actor_is_admin()
  OR EXISTS (
    SELECT 1 FROM entities e
    WHERE e.id = entity_id
    AND e.owner_id = current_actor_id()
  )
  OR actor_has_entity_role(entity_id, ARRAY['admin'])
);

-- DELETE: must be owner or admin of the entity
CREATE POLICY entity_perms_delete ON entity_permissions
FOR DELETE TO arke_app
USING (
  current_actor_is_admin()
  OR EXISTS (
    SELECT 1 FROM entities e
    WHERE e.id = entity_id
    AND e.owner_id = current_actor_id()
  )
  OR actor_has_entity_role(entity_id, ARRAY['admin'])
);


-- =============================================================================
-- RELATIONSHIP EDGES
-- =============================================================================

ALTER TABLE relationship_edges ENABLE ROW LEVEL SECURITY;

-- SELECT: visible if the relationship entity is visible (classification check)
CREATE POLICY edges_select ON relationship_edges
FOR SELECT TO arke_app
USING (
  EXISTS (
    SELECT 1 FROM entities
    WHERE entities.id = relationship_edges.id
    AND (entities.read_level = 0 OR current_actor_read_level() >= entities.read_level)
  )
);

-- INSERT: must have edit access on the source entity
CREATE POLICY edges_insert ON relationship_edges
FOR INSERT TO arke_app
WITH CHECK (
  current_actor_is_admin()
  OR EXISTS (
    SELECT 1 FROM entities e
    WHERE e.id = source_id
    AND (
      e.owner_id = current_actor_id()
      OR actor_has_entity_role(e.id, ARRAY['editor', 'admin'])
    )
  )
);

-- DELETE: must have edit access on the source entity or own the relationship
CREATE POLICY edges_delete ON relationship_edges
FOR DELETE TO arke_app
USING (
  current_actor_is_admin()
  OR EXISTS (
    SELECT 1 FROM entities e
    WHERE e.id = relationship_edges.id
    AND e.owner_id = current_actor_id()
  )
  OR EXISTS (
    SELECT 1 FROM entities e
    WHERE e.id = source_id
    AND (
      e.owner_id = current_actor_id()
      OR actor_has_entity_role(e.id, ARRAY['editor', 'admin'])
    )
  )
);


-- =============================================================================
-- ENTITY VERSIONS
-- =============================================================================

ALTER TABLE entity_versions ENABLE ROW LEVEL SECURITY;

-- SELECT: visible if the parent entity is visible
CREATE POLICY versions_select ON entity_versions
FOR SELECT TO arke_app
USING (
  EXISTS (
    SELECT 1 FROM entities
    WHERE entities.id = entity_versions.entity_id
    AND (entities.read_level = 0 OR current_actor_read_level() >= entities.read_level)
  )
);

-- INSERT: must have edit access on the parent entity
CREATE POLICY versions_insert ON entity_versions
FOR INSERT TO arke_app
WITH CHECK (
  EXISTS (
    SELECT 1 FROM entities e
    WHERE e.id = entity_id
    AND (
      e.owner_id = current_actor_id()
      OR current_actor_is_admin()
      OR actor_has_entity_role(e.id, ARRAY['editor', 'admin'])
    )
  )
);


-- =============================================================================
-- ENTITY ACTIVITY
-- =============================================================================

ALTER TABLE entity_activity ENABLE ROW LEVEL SECURITY;

-- SELECT: visible if the related entity is visible
CREATE POLICY activity_select ON entity_activity
FOR SELECT TO arke_app
USING (
  EXISTS (
    SELECT 1 FROM entities
    WHERE entities.id = entity_activity.entity_id
    AND (entities.read_level = 0 OR current_actor_read_level() >= entities.read_level)
  )
);

-- INSERT: must have edit access on the parent entity, OR be the actor
-- performing the logged action (needed for ownership transfers where
-- owner_id changes before the activity row is inserted)
CREATE POLICY activity_insert ON entity_activity
FOR INSERT TO arke_app
WITH CHECK (
  actor_id = current_actor_id()
  OR EXISTS (
    SELECT 1 FROM entities e
    WHERE e.id = entity_id
    AND (
      e.owner_id = current_actor_id()
      OR current_actor_is_admin()
      OR actor_has_entity_role(e.id, ARRAY['editor', 'admin'])
    )
  )
);


-- =============================================================================
-- ACTORS
-- =============================================================================

ALTER TABLE actors ENABLE ROW LEVEL SECURITY;

-- All actors visible to everyone
CREATE POLICY actors_select ON actors
FOR SELECT TO arke_app
USING (true);

-- INSERT: any authenticated actor can create actors at or below their own level
-- Admins can create at any level
CREATE POLICY actors_insert ON actors
FOR INSERT TO arke_app
WITH CHECK (
  current_actor_is_admin()
  OR (
    current_actor_id() IS NOT NULL
    AND max_read_level <= current_actor_read_level()
    AND max_write_level <= current_actor_write_level()
  )
);

-- UPDATE: system admin or self (for properties only — clearance changes
-- require admin, but RLS can't distinguish which columns changed, so
-- the app layer must validate that non-admins only change properties)
CREATE POLICY actors_update ON actors
FOR UPDATE TO arke_app
USING (
  current_actor_is_admin()
  OR id = current_actor_id()
)
WITH CHECK (
  current_actor_is_admin()
  OR id = current_actor_id()
);

-- DELETE: only system admins
CREATE POLICY actors_delete ON actors
FOR DELETE TO arke_app
USING (
  current_actor_is_admin()
);


-- =============================================================================
-- ARKES (Networks)
-- =============================================================================

ALTER TABLE arkes ENABLE ROW LEVEL SECURITY;

-- All Arkes visible to everyone
CREATE POLICY arkes_select ON arkes
FOR SELECT TO arke_app
USING (true);

-- Only system admins can manage Arkes
CREATE POLICY arkes_insert ON arkes
FOR INSERT TO arke_app
WITH CHECK (current_actor_is_admin());

CREATE POLICY arkes_update ON arkes
FOR UPDATE TO arke_app
USING (current_actor_is_admin())
WITH CHECK (current_actor_is_admin());

CREATE POLICY arkes_delete ON arkes
FOR DELETE TO arke_app
USING (current_actor_is_admin());


-- =============================================================================
-- GROUPS & GROUP MEMBERSHIPS
-- =============================================================================

ALTER TABLE groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE group_memberships ENABLE ROW LEVEL SECURITY;

-- All groups readable
CREATE POLICY groups_select ON groups
FOR SELECT TO arke_app
USING (true);

-- Create: system admin only
CREATE POLICY groups_insert ON groups
FOR INSERT TO arke_app
WITH CHECK (current_actor_is_admin());

-- Update: system admin or group admin
CREATE POLICY groups_update ON groups
FOR UPDATE TO arke_app
USING (
  current_actor_is_admin()
  OR EXISTS (
    SELECT 1 FROM group_memberships gm
    WHERE gm.group_id = groups.id
    AND gm.actor_id = current_actor_id()
    AND gm.role_in_group = 'admin'
  )
)
WITH CHECK (true);

-- Delete: system admin or group admin
CREATE POLICY groups_delete ON groups
FOR DELETE TO arke_app
USING (
  current_actor_is_admin()
  OR EXISTS (
    SELECT 1 FROM group_memberships gm
    WHERE gm.group_id = groups.id
    AND gm.actor_id = current_actor_id()
    AND gm.role_in_group = 'admin'
  )
);

-- Memberships: all readable
CREATE POLICY memberships_select ON group_memberships
FOR SELECT TO arke_app
USING (true);

-- Insert membership: system admin or group admin
CREATE POLICY memberships_insert ON group_memberships
FOR INSERT TO arke_app
WITH CHECK (
  current_actor_is_admin()
  OR EXISTS (
    SELECT 1 FROM group_memberships gm
    WHERE gm.group_id = group_memberships.group_id
    AND gm.actor_id = current_actor_id()
    AND gm.role_in_group = 'admin'
  )
);

-- Delete membership: system admin or group admin
CREATE POLICY memberships_delete ON group_memberships
FOR DELETE TO arke_app
USING (
  current_actor_is_admin()
  OR EXISTS (
    SELECT 1 FROM group_memberships gm2
    WHERE gm2.group_id = group_memberships.group_id
    AND gm2.actor_id = current_actor_id()
    AND gm2.role_in_group = 'admin'
  )
);


-- =============================================================================
-- SPACES
-- =============================================================================

ALTER TABLE spaces ENABLE ROW LEVEL SECURITY;

-- SELECT: classification-gated
CREATE POLICY spaces_select ON spaces
FOR SELECT TO arke_app
USING (
  read_level = 0
  OR current_actor_read_level() >= read_level
);

-- INSERT: classification ceiling
CREATE POLICY spaces_insert ON spaces
FOR INSERT TO arke_app
WITH CHECK (
  current_actor_write_level() >= write_level
);

-- UPDATE: classification ceiling + ACL (owner, editor/admin, system admin)
CREATE POLICY spaces_update ON spaces
FOR UPDATE TO arke_app
USING (
  current_actor_write_level() >= write_level
  AND (
    owner_id = current_actor_id()
    OR current_actor_is_admin()
    OR actor_has_space_role(id, ARRAY['editor', 'admin'])
  )
)
WITH CHECK (
  current_actor_write_level() >= write_level
);

-- DELETE: classification ceiling + admin ACL (owner, admin, system admin)
CREATE POLICY spaces_delete ON spaces
FOR DELETE TO arke_app
USING (
  current_actor_write_level() >= write_level
  AND (
    owner_id = current_actor_id()
    OR current_actor_is_admin()
    OR actor_has_space_role(id, ARRAY['admin'])
  )
);


-- =============================================================================
-- SPACE PERMISSIONS
-- =============================================================================

ALTER TABLE space_permissions ENABLE ROW LEVEL SECURITY;

-- Readable by anyone
CREATE POLICY space_perms_select ON space_permissions
FOR SELECT TO arke_app
USING (true);

-- Insert: must be owner or admin of the space
CREATE POLICY space_perms_insert ON space_permissions
FOR INSERT TO arke_app
WITH CHECK (
  current_actor_is_admin()
  OR EXISTS (
    SELECT 1 FROM spaces s
    WHERE s.id = space_id
    AND s.owner_id = current_actor_id()
  )
  OR actor_has_space_role(space_id, ARRAY['admin'])
);

-- Update: must be owner or admin of the space (needed for ON CONFLICT DO UPDATE)
CREATE POLICY space_perms_update ON space_permissions
FOR UPDATE TO arke_app
USING (
  current_actor_is_admin()
  OR EXISTS (
    SELECT 1 FROM spaces s
    WHERE s.id = space_id
    AND s.owner_id = current_actor_id()
  )
  OR actor_has_space_role(space_id, ARRAY['admin'])
);

-- Delete: must be owner or admin of the space
CREATE POLICY space_perms_delete ON space_permissions
FOR DELETE TO arke_app
USING (
  current_actor_is_admin()
  OR EXISTS (
    SELECT 1 FROM spaces s
    WHERE s.id = space_id
    AND s.owner_id = current_actor_id()
  )
  OR actor_has_space_role(space_id, ARRAY['admin'])
);


-- =============================================================================
-- SPACE ENTITIES
-- =============================================================================

ALTER TABLE space_entities ENABLE ROW LEVEL SECURITY;

-- Readable by anyone
CREATE POLICY space_entities_select ON space_entities
FOR SELECT TO arke_app
USING (true);

-- Insert: must be contributor+ on the space (owner, contributor, editor, admin)
CREATE POLICY space_entities_insert ON space_entities
FOR INSERT TO arke_app
WITH CHECK (
  current_actor_is_admin()
  OR EXISTS (
    SELECT 1 FROM spaces s
    WHERE s.id = space_id
    AND s.owner_id = current_actor_id()
  )
  OR actor_has_space_role(space_id, ARRAY['contributor', 'editor', 'admin'])
);

-- Delete: must be editor+ on the space, or the one who added it
CREATE POLICY space_entities_delete ON space_entities
FOR DELETE TO arke_app
USING (
  current_actor_is_admin()
  OR added_by = current_actor_id()
  OR EXISTS (
    SELECT 1 FROM spaces s
    WHERE s.id = space_id
    AND s.owner_id = current_actor_id()
  )
  OR actor_has_space_role(space_id, ARRAY['editor', 'admin'])
);


-- =============================================================================
-- COMMENTS
-- =============================================================================

ALTER TABLE comments ENABLE ROW LEVEL SECURITY;

-- SELECT: visible if the parent entity is visible
CREATE POLICY comments_select ON comments
FOR SELECT TO arke_app
USING (
  EXISTS (
    SELECT 1 FROM entities
    WHERE entities.id = comments.entity_id
    AND (entities.read_level = 0 OR current_actor_read_level() >= entities.read_level)
  )
);

-- INSERT: must be authenticated and able to read the entity
CREATE POLICY comments_insert ON comments
FOR INSERT TO arke_app
WITH CHECK (
  author_id = current_actor_id()
  AND EXISTS (
    SELECT 1 FROM entities
    WHERE entities.id = entity_id
    AND (entities.read_level = 0 OR current_actor_read_level() >= entities.read_level)
  )
);

-- DELETE: author, entity owner, entity admin, or system admin
CREATE POLICY comments_delete ON comments
FOR DELETE TO arke_app
USING (
  author_id = current_actor_id()
  OR current_actor_is_admin()
  OR EXISTS (
    SELECT 1 FROM entities e
    WHERE e.id = comments.entity_id
    AND e.owner_id = current_actor_id()
  )
  OR actor_has_entity_role(entity_id, ARRAY['admin'])
);


-- =============================================================================
-- NOTIFICATIONS
-- =============================================================================

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

-- SELECT: only your own
CREATE POLICY notifications_select ON notifications
FOR SELECT TO arke_app
USING (recipient_id = current_actor_id());

-- INSERT: actor can only insert notifications for actions they performed
CREATE POLICY notifications_insert ON notifications
FOR INSERT TO arke_app
WITH CHECK (actor_id = current_actor_id());

-- DELETE: only your own
CREATE POLICY notifications_delete ON notifications
FOR DELETE TO arke_app
USING (recipient_id = current_actor_id());


-- =============================================================================
-- AUTH TABLES
-- =============================================================================

ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_keys ENABLE ROW LEVEL SECURITY;

-- API keys: permissive reads (middleware reads by hash before knowing actor)
CREATE POLICY api_keys_select ON api_keys
FOR SELECT TO arke_app
USING (true);

-- Insert: own keys, keys for actors you own, or admin
CREATE POLICY api_keys_insert ON api_keys
FOR INSERT TO arke_app
WITH CHECK (
  actor_id = current_actor_id()
  OR current_actor_is_admin()
  OR EXISTS (
    SELECT 1 FROM actors
    WHERE actors.id = api_keys.actor_id
    AND actors.owner_id = current_actor_id()
  )
);

-- Update (revoke): own keys or admin
CREATE POLICY api_keys_update ON api_keys
FOR UPDATE TO arke_app
USING (
  actor_id = current_actor_id()
  OR current_actor_is_admin()
);

-- Agent keys: public keys readable by anyone
CREATE POLICY agent_keys_select ON agent_keys
FOR SELECT TO arke_app
USING (true);

-- Insert: own keys or admin
CREATE POLICY agent_keys_insert ON agent_keys
FOR INSERT TO arke_app
WITH CHECK (
  actor_id = current_actor_id()
  OR current_actor_is_admin()
);


-- =============================================================================
-- ACTOR UPDATE GUARD (BEFORE UPDATE trigger)
-- =============================================================================
--
-- RLS on actors allows self-updates (id = current_actor_id()), but it cannot
-- distinguish WHICH columns changed. The app layer restricts non-admins to
-- updating only `properties`, but a direct SQL client or a future route bug
-- could bypass that. This trigger is the database-level safety net.
--
-- Rules for non-admin self-updates:
--   - properties, updated_at     — freely changeable
--   - max_read_level             — can only lower (self-demotion)
--   - max_write_level            — can only lower (self-demotion)
--   - is_admin                   — immutable
--   - can_publish_public         — immutable
--   - status                     — immutable
--   - kind                       — immutable
--   - owner_id                   — immutable
--
-- System admins and admin-updating-another-actor are unrestricted.
--
-- =============================================================================

CREATE OR REPLACE FUNCTION actor_update_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- Admins are unrestricted
  IF current_actor_is_admin() THEN
    RETURN NEW;
  END IF;

  -- Only restrict self-updates by non-admins
  IF NEW.id <> current_actor_id() THEN
    RETURN NEW;
  END IF;

  -- Privilege columns: can only lower, never raise
  IF NEW.max_read_level > OLD.max_read_level THEN
    RAISE EXCEPTION 'non-admin actors cannot escalate max_read_level';
  END IF;

  IF NEW.max_write_level > OLD.max_write_level THEN
    RAISE EXCEPTION 'non-admin actors cannot escalate max_write_level';
  END IF;

  -- Immutable columns: cannot change at all
  IF NEW.is_admin IS DISTINCT FROM OLD.is_admin THEN
    RAISE EXCEPTION 'non-admin actors cannot change is_admin';
  END IF;

  IF NEW.can_publish_public IS DISTINCT FROM OLD.can_publish_public THEN
    RAISE EXCEPTION 'non-admin actors cannot change can_publish_public';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'non-admin actors cannot change status';
  END IF;

  IF NEW.kind IS DISTINCT FROM OLD.kind THEN
    RAISE EXCEPTION 'non-admin actors cannot change kind';
  END IF;

  IF NEW.owner_id IS DISTINCT FROM OLD.owner_id THEN
    RAISE EXCEPTION 'non-admin actors cannot change owner_id';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS actor_update_guard ON actors;
CREATE TRIGGER actor_update_guard
  BEFORE UPDATE ON actors
  FOR EACH ROW
  EXECUTE FUNCTION actor_update_guard();
