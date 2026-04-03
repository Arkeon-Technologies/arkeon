-- Worker permissions: allow sharing invocation access beyond the owner
--
-- Follows the same pattern as entity_permissions / space_permissions.
-- The only role for now is 'invoker' (can invoke the worker).
-- Owner retains exclusive control over worker config (prompt, keys, etc.).

CREATE TABLE worker_permissions (
  worker_id    TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  grantee_type TEXT NOT NULL,
  grantee_id   TEXT NOT NULL,
  role         TEXT NOT NULL,
  granted_by   TEXT NOT NULL REFERENCES actors(id),
  granted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (worker_id, grantee_type, grantee_id),
  CONSTRAINT valid_wp_grantee_type CHECK (grantee_type IN ('actor', 'group')),
  CONSTRAINT valid_worker_perm_role CHECK (role IN ('invoker'))
);

CREATE INDEX idx_worker_perms_grantee ON worker_permissions (grantee_type, grantee_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON worker_permissions TO arke_app;

-- Helper: does the current actor hold any of the given roles on a worker?
CREATE OR REPLACE FUNCTION actor_has_worker_role(
  p_worker_id TEXT,
  p_roles TEXT[]
) RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM worker_permissions wp
    WHERE wp.worker_id = p_worker_id
    AND wp.role = ANY(p_roles)
    AND (
      (wp.grantee_type = 'actor' AND wp.grantee_id = current_actor_id())
      OR (wp.grantee_type = 'group' AND EXISTS (
        SELECT 1 FROM group_memberships gm
        WHERE gm.group_id = wp.grantee_id::text
        AND gm.actor_id = current_actor_id()
      ))
    )
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- RLS

ALTER TABLE worker_permissions ENABLE ROW LEVEL SECURITY;

-- SELECT: visible to worker owner, the grantee, or admin
CREATE POLICY worker_perms_select ON worker_permissions
FOR SELECT TO arke_app
USING (
  current_actor_is_admin()
  OR EXISTS (
    SELECT 1 FROM actors a
    WHERE a.id = worker_id
    AND a.owner_id = current_actor_id()
  )
  OR (grantee_type = 'actor' AND grantee_id = current_actor_id())
  OR (grantee_type = 'group' AND EXISTS (
    SELECT 1 FROM group_memberships gm
    WHERE gm.group_id = grantee_id::text
    AND gm.actor_id = current_actor_id()
  ))
);

-- INSERT: worker owner or admin
CREATE POLICY worker_perms_insert ON worker_permissions
FOR INSERT TO arke_app
WITH CHECK (
  current_actor_is_admin()
  OR EXISTS (
    SELECT 1 FROM actors a
    WHERE a.id = worker_id
    AND a.owner_id = current_actor_id()
  )
);

-- UPDATE: worker owner or admin (needed for ON CONFLICT upsert)
CREATE POLICY worker_perms_update ON worker_permissions
FOR UPDATE TO arke_app
USING (
  current_actor_is_admin()
  OR EXISTS (
    SELECT 1 FROM actors a
    WHERE a.id = worker_id
    AND a.owner_id = current_actor_id()
  )
);

-- DELETE: worker owner or admin
CREATE POLICY worker_perms_delete ON worker_permissions
FOR DELETE TO arke_app
USING (
  current_actor_is_admin()
  OR EXISTS (
    SELECT 1 FROM actors a
    WHERE a.id = worker_id
    AND a.owner_id = current_actor_id()
  )
);
