-- =============================================================================
-- Actor Arke Membership + Rename network_id to arke_id
-- =============================================================================
--
-- Actors now belong to an arke (network). Regular actors are scoped to their
-- arke — they can only see/create data within it. Admins have NULL arke_id
-- and can operate across all arkes.
--
-- Also renames network_id → arke_id on entities, groups, and spaces for
-- consistency with user-facing terminology.
--
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Add arke_id to actors (nullable = admin/unrestricted)
-- -----------------------------------------------------------------------------

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'actors' AND column_name = 'arke_id'
  ) THEN
    ALTER TABLE actors ADD COLUMN arke_id TEXT REFERENCES arkes(id);
    CREATE INDEX idx_actors_arke_id ON actors(arke_id);
  END IF;
END $$;


-- -----------------------------------------------------------------------------
-- 2. Rename network_id → arke_id on entities, groups, spaces
-- -----------------------------------------------------------------------------

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'entities' AND column_name = 'network_id'
  ) THEN
    ALTER TABLE entities RENAME COLUMN network_id TO arke_id;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'groups' AND column_name = 'network_id'
  ) THEN
    ALTER TABLE groups RENAME COLUMN network_id TO arke_id;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'spaces' AND column_name = 'network_id'
  ) THEN
    ALTER TABLE spaces RENAME COLUMN network_id TO arke_id;
  END IF;
END $$;


-- -----------------------------------------------------------------------------
-- 3. Session context helper for actor's arke_id
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION current_actor_arke_id() RETURNS TEXT AS $$
  SELECT COALESCE(NULLIF(current_setting('app.actor_arke_id', true), ''), NULL);
$$ LANGUAGE sql STABLE;


-- -----------------------------------------------------------------------------
-- 4. Update RLS policies: add arke_id scoping to entities, groups, spaces
-- -----------------------------------------------------------------------------
-- Pattern: current_actor_arke_id() IS NULL = admin bypass (no filter)
--          current_actor_arke_id() = arke_id = regular actor scoped to their arke


-- ---- ENTITIES ----

DROP POLICY IF EXISTS entities_select ON entities;
CREATE POLICY entities_select ON entities
FOR SELECT TO arke_app
USING (
  (current_actor_arke_id() IS NULL OR arke_id = current_actor_arke_id())
  AND (read_level = 0 OR current_actor_read_level() >= read_level)
);

DROP POLICY IF EXISTS entities_insert ON entities;
CREATE POLICY entities_insert ON entities
FOR INSERT TO arke_app
WITH CHECK (
  (current_actor_arke_id() IS NULL OR arke_id = current_actor_arke_id())
  AND current_actor_write_level() >= write_level
  AND current_actor_read_level() >= read_level
);

DROP POLICY IF EXISTS entities_update ON entities;
CREATE POLICY entities_update ON entities
FOR UPDATE TO arke_app
USING (
  (current_actor_arke_id() IS NULL OR arke_id = current_actor_arke_id())
  AND current_actor_write_level() >= write_level
  AND current_actor_read_level() >= read_level
  AND (
    owner_id = current_actor_id()
    OR current_actor_is_admin()
    OR actor_has_entity_role(id, ARRAY['editor', 'admin'])
  )
)
WITH CHECK (
  (current_actor_arke_id() IS NULL OR arke_id = current_actor_arke_id())
  AND current_actor_write_level() >= write_level
  AND current_actor_read_level() >= read_level
);

DROP POLICY IF EXISTS entities_delete ON entities;
CREATE POLICY entities_delete ON entities
FOR DELETE TO arke_app
USING (
  (current_actor_arke_id() IS NULL OR arke_id = current_actor_arke_id())
  AND current_actor_write_level() >= write_level
  AND current_actor_read_level() >= read_level
  AND (
    owner_id = current_actor_id()
    OR current_actor_is_admin()
    OR actor_has_entity_role(id, ARRAY['admin'])
  )
);


-- ---- GROUPS ----

DROP POLICY IF EXISTS groups_select ON groups;
CREATE POLICY groups_select ON groups
FOR SELECT TO arke_app
USING (
  (current_actor_arke_id() IS NULL OR arke_id = current_actor_arke_id())
  AND (read_level = 0 OR current_actor_read_level() >= read_level)
);

DROP POLICY IF EXISTS groups_insert ON groups;
CREATE POLICY groups_insert ON groups
FOR INSERT TO arke_app
WITH CHECK (
  (current_actor_arke_id() IS NULL OR arke_id = current_actor_arke_id())
  AND current_actor_is_admin()
  AND current_actor_read_level() >= read_level
);

DROP POLICY IF EXISTS groups_update ON groups;
CREATE POLICY groups_update ON groups
FOR UPDATE TO arke_app
USING (
  (current_actor_arke_id() IS NULL OR arke_id = current_actor_arke_id())
  AND (
    current_actor_is_admin()
    OR EXISTS (
      SELECT 1 FROM group_memberships gm
      WHERE gm.group_id = groups.id
      AND gm.actor_id = current_actor_id()
      AND gm.role_in_group = 'admin'
    )
  )
)
WITH CHECK (true);

DROP POLICY IF EXISTS groups_delete ON groups;
CREATE POLICY groups_delete ON groups
FOR DELETE TO arke_app
USING (
  (current_actor_arke_id() IS NULL OR arke_id = current_actor_arke_id())
  AND (
    current_actor_is_admin()
    OR EXISTS (
      SELECT 1 FROM group_memberships gm
      WHERE gm.group_id = groups.id
      AND gm.actor_id = current_actor_id()
      AND gm.role_in_group = 'admin'
    )
  )
);


-- ---- SPACES ----

DROP POLICY IF EXISTS spaces_select ON spaces;
CREATE POLICY spaces_select ON spaces
FOR SELECT TO arke_app
USING (
  (current_actor_arke_id() IS NULL OR arke_id = current_actor_arke_id())
  AND (read_level = 0 OR current_actor_read_level() >= read_level)
);

DROP POLICY IF EXISTS spaces_insert ON spaces;
CREATE POLICY spaces_insert ON spaces
FOR INSERT TO arke_app
WITH CHECK (
  (current_actor_arke_id() IS NULL OR arke_id = current_actor_arke_id())
  AND current_actor_write_level() >= write_level
  AND current_actor_read_level() >= read_level
);

DROP POLICY IF EXISTS spaces_update ON spaces;
CREATE POLICY spaces_update ON spaces
FOR UPDATE TO arke_app
USING (
  (current_actor_arke_id() IS NULL OR arke_id = current_actor_arke_id())
  AND current_actor_write_level() >= write_level
  AND (
    owner_id = current_actor_id()
    OR current_actor_is_admin()
    OR actor_has_space_role(id, ARRAY['editor', 'admin'])
  )
)
WITH CHECK (
  (current_actor_arke_id() IS NULL OR arke_id = current_actor_arke_id())
  AND current_actor_write_level() >= write_level
);

DROP POLICY IF EXISTS spaces_delete ON spaces;
CREATE POLICY spaces_delete ON spaces
FOR DELETE TO arke_app
USING (
  (current_actor_arke_id() IS NULL OR arke_id = current_actor_arke_id())
  AND current_actor_write_level() >= write_level
  AND (
    owner_id = current_actor_id()
    OR current_actor_is_admin()
    OR actor_has_space_role(id, ARRAY['admin'])
  )
);


-- -----------------------------------------------------------------------------
-- 5. Update actor_update_guard: arke_id is immutable for non-admins
-- -----------------------------------------------------------------------------

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

  IF NEW.arke_id IS DISTINCT FROM OLD.arke_id THEN
    RAISE EXCEPTION 'non-admin actors cannot change arke_id';
  END IF;

  RETURN NEW;
END;
$$;


-- -----------------------------------------------------------------------------
-- 6. Grants
-- -----------------------------------------------------------------------------

-- actors.arke_id is part of the existing actors table, already granted.
-- Just ensure the new function is usable.
GRANT EXECUTE ON FUNCTION current_actor_arke_id() TO arke_app;
