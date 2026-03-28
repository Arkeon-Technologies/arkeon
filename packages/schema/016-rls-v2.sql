-- =============================================================================
-- RLS v2: Group-aware policies + materializer functions
-- =============================================================================

-- Helper: parse app.actor_groups setting into TEXT[]
CREATE OR REPLACE FUNCTION current_actor_groups() RETURNS TEXT[] AS $$
  SELECT COALESCE(
    string_to_array(
      NULLIF(current_setting('app.actor_groups', true), ''),
      ','
    ),
    '{}'::text[]
  );
$$ LANGUAGE sql STABLE;

-- =============================================================================
-- Replace entity policies
-- =============================================================================

DROP POLICY IF EXISTS entities_select ON entities;
CREATE POLICY entities_select ON entities FOR SELECT USING (
  view_access = 'public'
  OR owner_id = current_actor_id()
  OR EXISTS(
    SELECT 1 FROM entity_access ea
    WHERE ea.entity_id = entities.id
      AND (
        ea.actor_id = current_actor_id()
        OR ea.group_id = ANY(current_actor_groups())
      )
  )
);

DROP POLICY IF EXISTS entities_update ON entities;
CREATE POLICY entities_update ON entities FOR UPDATE USING (
  owner_id = current_actor_id()
  OR edit_access = 'public'
  OR (edit_access = 'collaborators' AND EXISTS(
    SELECT 1 FROM entity_access ea
    WHERE ea.entity_id = entities.id
      AND ea.access_type IN ('edit', 'admin')
      AND (
        ea.actor_id = current_actor_id()
        OR ea.group_id = ANY(current_actor_groups())
      )
  ))
  -- Rule-derived group edit grants bypass the 'collaborators' gate
  OR EXISTS(
    SELECT 1 FROM entity_access ea
    WHERE ea.entity_id = entities.id
      AND ea.access_type = 'edit'
      AND ea.group_id = ANY(current_actor_groups())
      AND ea.rule_id IS NOT NULL
  )
)
-- WITH CHECK (true): USING validates the actor has permission to update.
-- The resulting row is allowed to have any values (e.g., ownership transfer
-- changes owner_id to someone else — the old owner had permission to do it).
WITH CHECK (true);

-- entities_insert and entities_delete unchanged (owner-only)

-- =============================================================================
-- Replace entity_access policies
-- =============================================================================

DROP POLICY IF EXISTS access_insert ON entity_access;
CREATE POLICY access_insert ON entity_access FOR INSERT WITH CHECK (
  -- Rule-derived grants (materializer)
  rule_id IS NOT NULL
  -- Manual grants: owner or admin of the entity
  OR EXISTS(
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

DROP POLICY IF EXISTS access_delete ON entity_access;
CREATE POLICY access_delete ON entity_access FOR DELETE USING (
  -- Rule-derived grants (materializer cleanup via CASCADE)
  rule_id IS NOT NULL
  -- Manual grants: owner or admin
  OR EXISTS(
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
-- Replace relationship edge policies
-- =============================================================================

DROP POLICY IF EXISTS edges_insert ON relationship_edges;
CREATE POLICY edges_insert ON relationship_edges FOR INSERT WITH CHECK (
  EXISTS(
    SELECT 1 FROM entities WHERE id = source_id AND (
      owner_id = current_actor_id()
      OR edit_access = 'public'
      OR (edit_access = 'collaborators' AND EXISTS(
        SELECT 1 FROM entity_access ea
        WHERE ea.entity_id = source_id
          AND ea.access_type IN ('edit', 'admin')
          AND (ea.actor_id = current_actor_id() OR ea.group_id = ANY(current_actor_groups()))
      ))
      OR EXISTS(
        SELECT 1 FROM entity_access ea
        WHERE ea.entity_id = source_id
          AND ea.access_type = 'edit'
          AND ea.group_id = ANY(current_actor_groups())
          AND ea.rule_id IS NOT NULL
      )
    )
  )
);

DROP POLICY IF EXISTS edges_select ON relationship_edges;
CREATE POLICY edges_select ON relationship_edges FOR SELECT USING (
  EXISTS(
    SELECT 1 FROM entities WHERE id = relationship_edges.id AND (
      view_access = 'public'
      OR owner_id = current_actor_id()
      OR EXISTS(
        SELECT 1 FROM entity_access ea
        WHERE ea.entity_id = relationship_edges.id
          AND (ea.actor_id = current_actor_id() OR ea.group_id = ANY(current_actor_groups()))
      )
    )
  )
);

DROP POLICY IF EXISTS edges_delete ON relationship_edges;
CREATE POLICY edges_delete ON relationship_edges FOR DELETE USING (
  EXISTS(
    SELECT 1 FROM entities WHERE id = source_id AND (
      owner_id = current_actor_id()
      OR edit_access = 'public'
      OR (edit_access = 'collaborators' AND EXISTS(
        SELECT 1 FROM entity_access ea
        WHERE ea.entity_id = source_id
          AND ea.access_type IN ('edit', 'admin')
          AND (ea.actor_id = current_actor_id() OR ea.group_id = ANY(current_actor_groups()))
      ))
      OR EXISTS(
        SELECT 1 FROM entity_access ea
        WHERE ea.entity_id = source_id
          AND ea.access_type = 'edit'
          AND ea.group_id = ANY(current_actor_groups())
          AND ea.rule_id IS NOT NULL
      )
    )
  )
);

-- =============================================================================
-- Replace entity versions policy
-- =============================================================================

DROP POLICY IF EXISTS versions_select ON entity_versions;
CREATE POLICY versions_select ON entity_versions FOR SELECT USING (
  EXISTS(
    SELECT 1 FROM entities WHERE id = entity_id AND (
      view_access = 'public'
      OR owner_id = current_actor_id()
      OR EXISTS(
        SELECT 1 FROM entity_access ea
        WHERE ea.entity_id = entity_versions.entity_id
          AND (ea.actor_id = current_actor_id() OR ea.group_id = ANY(current_actor_groups()))
      )
    )
  )
);

-- =============================================================================
-- Materializer: SECURITY DEFINER functions
-- =============================================================================

-- Materialize a single permission rule into entity_access rows.
-- Finds all matching entities, expands descendant groups, bulk inserts.
CREATE OR REPLACE FUNCTION materialize_rule(rid TEXT) RETURNS INTEGER
SECURITY DEFINER AS $$
DECLARE
  r RECORD;
  cnt INTEGER;
BEGIN
  SELECT * INTO r FROM permission_rules WHERE id = rid;
  IF NOT FOUND THEN RETURN 0; END IF;

  WITH matched_entities AS (
    SELECT e.id FROM entities e
    WHERE (r.match_kind IS NULL OR e.kind = r.match_kind)
      AND (r.match_type IS NULL OR e.type = r.match_type)
      AND (r.match_commons IS NULL OR e.commons_id = r.match_commons)
      AND (r.match_property IS NULL OR e.properties @> r.match_property)
  ),
  target_groups AS (
    SELECT gwd.group_id FROM group_with_descendants(
      COALESCE(r.grant_group_id, (
        SELECT id FROM groups
        WHERE network_id = r.network_id AND name = 'everyone'
        LIMIT 1
      ))
    ) gwd
  )
  INSERT INTO entity_access (entity_id, access_type, group_id, rule_id)
  SELECT me.id, r.grant_access, tg.group_id, rid
  FROM matched_entities me CROSS JOIN target_groups tg
  ON CONFLICT DO NOTHING;

  GET DIAGNOSTICS cnt = ROW_COUNT;
  RETURN cnt;
END;
$$ LANGUAGE plpgsql;

-- Evaluate all permission rules for a single entity.
-- Called after entity create/update to ensure rule-derived grants are current.
CREATE OR REPLACE FUNCTION materialize_entity_rules(eid TEXT) RETURNS void
SECURITY DEFINER AS $$
DECLARE
  e RECORD;
  r RECORD;
BEGIN
  SELECT * INTO e FROM entities WHERE id = eid;
  IF NOT FOUND THEN RETURN; END IF;

  -- Delete existing rule-derived grants for this entity
  DELETE FROM entity_access WHERE entity_id = eid AND rule_id IS NOT NULL;

  -- Evaluate all rules
  FOR r IN SELECT * FROM permission_rules LOOP
    IF (r.match_kind IS NULL OR r.match_kind = e.kind)
       AND (r.match_type IS NULL OR r.match_type = e.type)
       AND (r.match_commons IS NULL OR r.match_commons = e.commons_id)
       AND (r.match_property IS NULL OR e.properties @> r.match_property)
    THEN
      INSERT INTO entity_access (entity_id, access_type, group_id, rule_id)
      SELECT eid, r.grant_access, gwd.group_id, r.id
      FROM group_with_descendants(
        COALESCE(r.grant_group_id, (
          SELECT id FROM groups
          WHERE network_id = r.network_id AND name = 'everyone'
          LIMIT 1
        ))
      ) gwd
      ON CONFLICT DO NOTHING;
    END IF;
  END LOOP;
END;
$$ LANGUAGE plpgsql;
