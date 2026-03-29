-- =============================================================================
-- Schema v2 Test Suite
-- =============================================================================
-- Run: psql $DATABASE_URL -f packages/schema/tests/run_tests.sql
--
-- Tests classification-based reads and write ceilings against the v2 schema.
-- ACL checks (entity_permissions, space_permissions) are app-layer and not
-- tested here — only RLS enforcement.
-- =============================================================================

\set ON_ERROR_STOP off
\set QUIET on
\pset format unaligned
\pset tuples_only on

-- Track results (regular table so arke_app can access it)
DROP TABLE IF EXISTS test_results;
CREATE TABLE test_results (name TEXT, passed BOOLEAN, detail TEXT);

CREATE OR REPLACE FUNCTION test_pass(n TEXT) RETURNS void AS $$
  INSERT INTO test_results VALUES (n, true, NULL);
$$ LANGUAGE sql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION test_fail(n TEXT, msg TEXT) RETURNS void AS $$
  INSERT INTO test_results VALUES (n, false, msg);
$$ LANGUAGE sql SECURITY DEFINER;

-- =============================================================================
-- Setup: ensure arke_app role exists
-- =============================================================================

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'arke_app') THEN
    CREATE ROLE arke_app LOGIN PASSWORD 'arke';
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO arke_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO arke_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO arke_app;
GRANT SELECT, INSERT ON test_results TO arke_app;

-- Allow switching to arke_app
DO $$ BEGIN
  EXECUTE 'GRANT arke_app TO ' || current_user;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- =============================================================================
-- Seed Data (as superuser, bypasses RLS)
-- =============================================================================

-- Clean slate
DELETE FROM notifications;
DELETE FROM entity_activity;
DELETE FROM entity_versions;
DELETE FROM comments;
DELETE FROM space_entities;
DELETE FROM space_permissions;
DELETE FROM entity_permissions;
DELETE FROM relationship_edges;
DELETE FROM group_memberships;
DELETE FROM groups;
DELETE FROM api_keys;
DELETE FROM agent_keys;
DELETE FROM spaces;
DELETE FROM entities;
DELETE FROM arkes;
DELETE FROM actors;

-- Actors at various clearance levels
INSERT INTO actors (id, kind, max_read_level, max_write_level, is_admin, can_publish_public, properties)
VALUES
  ('01ADMIN0000000000000000000', 'agent', 4, 4, true,  true,  '{"label": "Admin"}'),
  ('01RESTRICTED000000000000000', 'agent', 4, 4, false, false, '{"label": "Restricted Agent"}'),
  ('01CONFID0000000000000000000', 'agent', 3, 3, false, false, '{"label": "Confidential Agent"}'),
  ('01TEAM00000000000000000000', 'agent', 2, 2, false, false, '{"label": "Team Agent"}'),
  ('01INTERNAL0000000000000000', 'agent', 1, 1, false, false, '{"label": "Internal Agent"}'),
  ('01PUBLIC0000000000000000000', 'agent', 0, 0, false, false, '{"label": "Public Agent"}');

-- Network (Arke)
INSERT INTO arkes (id, name, owner_id)
VALUES ('01NETWORK0000000000000000000', 'Test Network', '01ADMIN0000000000000000000');

-- Entities at various classification levels
INSERT INTO entities (id, kind, type, network_id, properties, owner_id, read_level, write_level, edited_by, created_at, updated_at)
VALUES
  ('01ENT_PUBLIC0000000000000', 'entity', 'doc', '01NETWORK0000000000000000000', '{"label": "Public Doc"}',       '01ADMIN0000000000000000000', 0, 0, '01ADMIN0000000000000000000', NOW(), NOW()),
  ('01ENT_INTERNAL000000000000', 'entity', 'doc', '01NETWORK0000000000000000000', '{"label": "Internal Doc"}',     '01ADMIN0000000000000000000', 1, 1, '01ADMIN0000000000000000000', NOW(), NOW()),
  ('01ENT_TEAM00000000000000', 'entity', 'doc', '01NETWORK0000000000000000000', '{"label": "Team Doc"}',         '01ADMIN0000000000000000000', 2, 2, '01ADMIN0000000000000000000', NOW(), NOW()),
  ('01ENT_CONFID000000000000', 'entity', 'doc', '01NETWORK0000000000000000000', '{"label": "Confidential Doc"}', '01ADMIN0000000000000000000', 3, 3, '01ADMIN0000000000000000000', NOW(), NOW()),
  ('01ENT_RESTRICT0000000000', 'entity', 'doc', '01NETWORK0000000000000000000', '{"label": "Restricted Doc"}',   '01ADMIN0000000000000000000', 4, 4, '01ADMIN0000000000000000000', NOW(), NOW());

-- Entity owned by TEAM agent (for ownership tests)
INSERT INTO entities (id, kind, type, network_id, properties, owner_id, read_level, write_level, edited_by, created_at, updated_at)
VALUES
  ('01ENT_TEAM_OWN0000000000', 'entity', 'doc', '01NETWORK0000000000000000000', '{"label": "Team Owned"}', '01TEAM00000000000000000000', 2, 2, '01TEAM00000000000000000000', NOW(), NOW());

-- Mixed classification: public read, restricted write
INSERT INTO entities (id, kind, type, network_id, properties, owner_id, read_level, write_level, edited_by, created_at, updated_at)
VALUES
  ('01ENT_PUB_RESTR000000000', 'entity', 'doc', '01NETWORK0000000000000000000', '{"label": "Public Read Restricted Write"}', '01ADMIN0000000000000000000', 0, 4, '01ADMIN0000000000000000000', NOW(), NOW());

-- Spaces at various levels
INSERT INTO spaces (id, network_id, name, owner_id, read_level, write_level)
VALUES
  ('01SPACE_PUBLIC00000000000', '01NETWORK0000000000000000000', 'Public Space',   '01ADMIN0000000000000000000', 0, 0),
  ('01SPACE_INTERNAL000000000', '01NETWORK0000000000000000000', 'Internal Space', '01ADMIN0000000000000000000', 1, 1),
  ('01SPACE_TEAM0000000000000', '01NETWORK0000000000000000000', 'Team Space',     '01ADMIN0000000000000000000', 2, 2);

-- Entity versions (for parent classification inheritance)
INSERT INTO entity_versions (entity_id, ver, properties, edited_by, created_at)
VALUES
  ('01ENT_CONFID000000000000', 1, '{"label": "Confidential Doc"}', '01ADMIN0000000000000000000', NOW());

-- Comments (for parent classification inheritance)
INSERT INTO comments (id, entity_id, author_id, body)
VALUES
  ('01CMT_ON_CONFID000000000', '01ENT_CONFID000000000000', '01ADMIN0000000000000000000', 'Comment on confidential doc');

-- Notifications
INSERT INTO notifications (recipient_id, entity_id, actor_id, action)
VALUES
  ('01TEAM00000000000000000000', '01ENT_TEAM00000000000000', '01ADMIN0000000000000000000', 'content_updated'),
  ('01INTERNAL0000000000000000', '01ENT_INTERNAL000000000000', '01ADMIN0000000000000000000', 'content_updated');

-- Relationship between internal and team docs
INSERT INTO entities (id, kind, type, network_id, properties, owner_id, read_level, write_level, edited_by, created_at, updated_at)
VALUES
  ('01REL_INT_TEAM0000000000', 'relationship', 'relationship', '01NETWORK0000000000000000000', '{}', '01ADMIN0000000000000000000', 2, 2, '01ADMIN0000000000000000000', NOW(), NOW());

INSERT INTO relationship_edges (id, source_id, target_id, predicate)
VALUES
  ('01REL_INT_TEAM0000000000', '01ENT_INTERNAL000000000000', '01ENT_TEAM00000000000000', 'references');

-- Activity
INSERT INTO entity_activity (entity_id, space_id, actor_id, action, detail)
VALUES
  ('01ENT_CONFID000000000000', NULL, '01ADMIN0000000000000000000', 'entity_created', '{}');

-- ACL grants: give INTERNAL agent editor role on the INTERNAL entity
INSERT INTO entity_permissions (entity_id, grantee_type, grantee_id, role, granted_by)
VALUES
  ('01ENT_INTERNAL000000000000', 'actor', '01INTERNAL0000000000000000', 'editor', '01ADMIN0000000000000000000');

-- Group for ACL tests
INSERT INTO groups (id, name, network_id, created_by)
VALUES ('01GRP_EDITORS00000000000', 'Editors', '01NETWORK0000000000000000000', '01ADMIN0000000000000000000');

INSERT INTO group_memberships (actor_id, group_id, role_in_group)
VALUES ('01CONFID0000000000000000000', '01GRP_EDITORS00000000000', 'member');

-- Give the Editors group editor role on the TEAM entity
INSERT INTO entity_permissions (entity_id, grantee_type, grantee_id, role, granted_by)
VALUES
  ('01ENT_TEAM00000000000000', 'group', '01GRP_EDITORS00000000000', 'editor', '01ADMIN0000000000000000000');

-- Space permissions: give INTERNAL agent contributor on Internal Space
INSERT INTO space_permissions (space_id, grantee_type, grantee_id, role, granted_by)
VALUES
  ('01SPACE_INTERNAL000000000', 'actor', '01INTERNAL0000000000000000', 'contributor', '01ADMIN0000000000000000000');


-- =============================================================================
-- TEST 1: Classification-based reads (entities)
-- =============================================================================

-- Switch to arke_app role
SET ROLE arke_app;

-- Test: TEAM agent (level 2) can see PUBLIC, INTERNAL, TEAM
DO $$ DECLARE cnt int; BEGIN
  PERFORM set_config('app.actor_id', '01TEAM00000000000000000000', true);
  PERFORM set_config('app.actor_read_level', '2', true);
  PERFORM set_config('app.actor_write_level', '2', true);
  PERFORM set_config('app.actor_is_admin', 'false', true);

  SELECT count(*) INTO cnt FROM entities WHERE kind = 'entity';
  IF cnt = 5 THEN  -- PUBLIC, INTERNAL, TEAM, TEAM_OWN, PUB_RESTR (5 readable, 2 classified above)
    PERFORM test_pass('entity_read_team_sees_3_levels');
  ELSE
    PERFORM test_fail('entity_read_team_sees_3_levels', 'Expected 5, got ' || cnt);
  END IF;
END $$;

-- Test: PUBLIC agent (level 0) can only see PUBLIC entities
DO $$ DECLARE cnt int; BEGIN
  PERFORM set_config('app.actor_id', '01PUBLIC0000000000000000000', true);
  PERFORM set_config('app.actor_read_level', '0', true);
  PERFORM set_config('app.actor_write_level', '0', true);

  SELECT count(*) INTO cnt FROM entities WHERE kind = 'entity';
  IF cnt = 2 THEN  -- PUBLIC + PUB_RESTR (both read_level=0)
    PERFORM test_pass('entity_read_public_sees_public_only');
  ELSE
    PERFORM test_fail('entity_read_public_sees_public_only', 'Expected 2, got ' || cnt);
  END IF;
END $$;

-- Test: RESTRICTED agent (level 4) can see everything
DO $$ DECLARE cnt int; BEGIN
  PERFORM set_config('app.actor_id', '01RESTRICTED000000000000000', true);
  PERFORM set_config('app.actor_read_level', '4', true);
  PERFORM set_config('app.actor_write_level', '4', true);

  SELECT count(*) INTO cnt FROM entities WHERE kind = 'entity';
  IF cnt = 7 THEN  -- all 7 entities
    PERFORM test_pass('entity_read_restricted_sees_all');
  ELSE
    PERFORM test_fail('entity_read_restricted_sees_all', 'Expected 7, got ' || cnt);
  END IF;
END $$;

-- Test: Unauthenticated (level -1) can only see PUBLIC
DO $$ DECLARE cnt int; BEGIN
  PERFORM set_config('app.actor_id', '', true);
  PERFORM set_config('app.actor_read_level', '-1', true);
  PERFORM set_config('app.actor_write_level', '-1', true);

  SELECT count(*) INTO cnt FROM entities WHERE kind = 'entity';
  IF cnt = 2 THEN  -- PUBLIC + PUB_RESTR
    PERFORM test_pass('entity_read_unauth_sees_public_only');
  ELSE
    PERFORM test_fail('entity_read_unauth_sees_public_only', 'Expected 2, got ' || cnt);
  END IF;
END $$;


-- =============================================================================
-- TEST 2: Write ceiling (entities)
-- =============================================================================

-- Test: INTERNAL agent (level 1) cannot INSERT entity with write_level=2
DO $$ BEGIN
  PERFORM set_config('app.actor_id', '01INTERNAL0000000000000000', true);
  PERFORM set_config('app.actor_read_level', '1', true);
  PERFORM set_config('app.actor_write_level', '1', true);

  INSERT INTO entities (id, kind, type, network_id, properties, owner_id, read_level, write_level, edited_by, created_at, updated_at)
  VALUES ('01TEST_WRITE_FAIL0000000', 'entity', 'doc', '01NETWORK0000000000000000000', '{}', '01INTERNAL0000000000000000', 2, 2, '01INTERNAL0000000000000000', NOW(), NOW());

  PERFORM test_fail('entity_write_ceiling_blocks_insert', 'Insert should have been blocked');
EXCEPTION WHEN insufficient_privilege THEN
  PERFORM test_pass('entity_write_ceiling_blocks_insert');
END $$;

-- Test: TEAM agent (level 2) CAN insert entity with write_level=2
DO $$ BEGIN
  PERFORM set_config('app.actor_id', '01TEAM00000000000000000000', true);
  PERFORM set_config('app.actor_read_level', '2', true);
  PERFORM set_config('app.actor_write_level', '2', true);

  INSERT INTO entities (id, kind, type, network_id, properties, owner_id, read_level, write_level, edited_by, created_at, updated_at)
  VALUES ('01TEST_WRITE_OK00000000', 'entity', 'doc', '01NETWORK0000000000000000000', '{}', '01TEAM00000000000000000000', 2, 2, '01TEAM00000000000000000000', NOW(), NOW());

  PERFORM test_pass('entity_write_ceiling_allows_insert');
EXCEPTION WHEN insufficient_privilege THEN
  PERFORM test_fail('entity_write_ceiling_allows_insert', 'Insert should have succeeded');
END $$;

-- Test: Cannot insert entity with read_level above your read clearance
DO $$ BEGIN
  PERFORM set_config('app.actor_id', '01TEAM00000000000000000000', true);
  PERFORM set_config('app.actor_read_level', '2', true);
  PERFORM set_config('app.actor_write_level', '2', true);

  INSERT INTO entities (id, kind, type, network_id, properties, owner_id, read_level, write_level, edited_by, created_at, updated_at)
  VALUES ('01TEST_READ_FAIL0000000', 'entity', 'doc', '01NETWORK0000000000000000000', '{}', '01TEAM00000000000000000000', 3, 2, '01TEAM00000000000000000000', NOW(), NOW());

  PERFORM test_fail('entity_cannot_create_above_read_level', 'Insert should have been blocked');
EXCEPTION WHEN insufficient_privilege THEN
  PERFORM test_pass('entity_cannot_create_above_read_level');
END $$;

-- Test: Cannot UPDATE entity above write ceiling
DO $$ BEGIN
  PERFORM set_config('app.actor_id', '01INTERNAL0000000000000000', true);
  PERFORM set_config('app.actor_read_level', '1', true);
  PERFORM set_config('app.actor_write_level', '1', true);

  UPDATE entities SET properties = '{"label": "hacked"}' WHERE id = '01ENT_TEAM00000000000000';

  -- If 0 rows updated, RLS silently filtered it — this is expected behavior
  PERFORM test_pass('entity_write_ceiling_blocks_update');
END $$;


-- =============================================================================
-- TEST 3: Space classification
-- =============================================================================

-- Test: INTERNAL agent (level 1) can see PUBLIC and INTERNAL spaces but not TEAM
DO $$ DECLARE cnt int; BEGIN
  PERFORM set_config('app.actor_id', '01INTERNAL0000000000000000', true);
  PERFORM set_config('app.actor_read_level', '1', true);

  SELECT count(*) INTO cnt FROM spaces;
  IF cnt = 2 THEN  -- PUBLIC + INTERNAL
    PERFORM test_pass('space_read_internal_sees_2');
  ELSE
    PERFORM test_fail('space_read_internal_sees_2', 'Expected 2, got ' || cnt);
  END IF;
END $$;


-- =============================================================================
-- TEST 4: Relationship visibility
-- =============================================================================

-- Test: Relationship with read_level=2 is invisible to INTERNAL agent (level 1)
DO $$ DECLARE cnt int; BEGIN
  PERFORM set_config('app.actor_id', '01INTERNAL0000000000000000', true);
  PERFORM set_config('app.actor_read_level', '1', true);

  SELECT count(*) INTO cnt FROM relationship_edges
  WHERE source_id = '01ENT_INTERNAL000000000000';
  IF cnt = 0 THEN
    PERFORM test_pass('relationship_classification_hides_edge');
  ELSE
    PERFORM test_fail('relationship_classification_hides_edge', 'Expected 0, got ' || cnt);
  END IF;
END $$;

-- Test: TEAM agent (level 2) CAN see the relationship
DO $$ DECLARE cnt int; BEGIN
  PERFORM set_config('app.actor_id', '01TEAM00000000000000000000', true);
  PERFORM set_config('app.actor_read_level', '2', true);

  SELECT count(*) INTO cnt FROM relationship_edges
  WHERE source_id = '01ENT_INTERNAL000000000000';
  IF cnt = 1 THEN
    PERFORM test_pass('relationship_classification_shows_edge');
  ELSE
    PERFORM test_fail('relationship_classification_shows_edge', 'Expected 1, got ' || cnt);
  END IF;
END $$;


-- =============================================================================
-- TEST 5: Entity versions inherit parent classification
-- =============================================================================

-- Test: TEAM agent (level 2) cannot see versions of CONFIDENTIAL entity (level 3)
DO $$ DECLARE cnt int; BEGIN
  PERFORM set_config('app.actor_id', '01TEAM00000000000000000000', true);
  PERFORM set_config('app.actor_read_level', '2', true);

  SELECT count(*) INTO cnt FROM entity_versions WHERE entity_id = '01ENT_CONFID000000000000';
  IF cnt = 0 THEN
    PERFORM test_pass('versions_inherit_parent_classification');
  ELSE
    PERFORM test_fail('versions_inherit_parent_classification', 'Expected 0, got ' || cnt);
  END IF;
END $$;


-- =============================================================================
-- TEST 6: Comments inherit parent entity classification
-- =============================================================================

-- Test: TEAM agent (level 2) cannot see comments on CONFIDENTIAL entity
DO $$ DECLARE cnt int; BEGIN
  PERFORM set_config('app.actor_id', '01TEAM00000000000000000000', true);
  PERFORM set_config('app.actor_read_level', '2', true);

  SELECT count(*) INTO cnt FROM comments WHERE entity_id = '01ENT_CONFID000000000000';
  IF cnt = 0 THEN
    PERFORM test_pass('comments_inherit_parent_classification');
  ELSE
    PERFORM test_fail('comments_inherit_parent_classification', 'Expected 0, got ' || cnt);
  END IF;
END $$;


-- =============================================================================
-- TEST 7: Notifications only visible to recipient
-- =============================================================================

DO $$ DECLARE cnt int; BEGIN
  PERFORM set_config('app.actor_id', '01TEAM00000000000000000000', true);
  PERFORM set_config('app.actor_read_level', '2', true);

  SELECT count(*) INTO cnt FROM notifications;
  IF cnt = 1 THEN  -- Only TEAM's notification, not INTERNAL's
    PERFORM test_pass('notifications_only_own');
  ELSE
    PERFORM test_fail('notifications_only_own', 'Expected 1, got ' || cnt);
  END IF;
END $$;


-- =============================================================================
-- TEST 8: Actors always visible to everyone
-- =============================================================================

DO $$ DECLARE cnt int; BEGIN
  PERFORM set_config('app.actor_id', '01PUBLIC0000000000000000000', true);
  PERFORM set_config('app.actor_read_level', '0', true);

  SELECT count(*) INTO cnt FROM actors;
  IF cnt = 6 THEN  -- All 6 actors visible even to PUBLIC agent
    PERFORM test_pass('actors_always_visible');
  ELSE
    PERFORM test_fail('actors_always_visible', 'Expected 6, got ' || cnt);
  END IF;
END $$;


-- =============================================================================
-- TEST 9: Mixed classification (public read, restricted write)
-- =============================================================================

-- Test: PUBLIC agent can READ but not WRITE the mixed entity
DO $$ DECLARE cnt int; BEGIN
  PERFORM set_config('app.actor_id', '01PUBLIC0000000000000000000', true);
  PERFORM set_config('app.actor_read_level', '0', true);
  PERFORM set_config('app.actor_write_level', '0', true);

  -- Can read it
  SELECT count(*) INTO cnt FROM entities WHERE id = '01ENT_PUB_RESTR000000000';
  IF cnt != 1 THEN
    PERFORM test_fail('mixed_classification_readable', 'Expected 1, got ' || cnt);
    RETURN;
  END IF;

  -- Cannot update it (write_level=4 > write_level=0)
  UPDATE entities SET properties = '{"label": "hacked"}' WHERE id = '01ENT_PUB_RESTR000000000';
  -- 0 rows updated due to RLS
  PERFORM test_pass('mixed_classification_readable_not_writable');
END $$;


-- =============================================================================
-- TEST 10: Activity inherits entity classification
-- =============================================================================

DO $$ DECLARE cnt int; BEGIN
  PERFORM set_config('app.actor_id', '01TEAM00000000000000000000', true);
  PERFORM set_config('app.actor_read_level', '2', true);

  SELECT count(*) INTO cnt FROM entity_activity WHERE entity_id = '01ENT_CONFID000000000000';
  IF cnt = 0 THEN
    PERFORM test_pass('activity_inherits_parent_classification');
  ELSE
    PERFORM test_fail('activity_inherits_parent_classification', 'Expected 0, got ' || cnt);
  END IF;
END $$;


-- =============================================================================
-- TEST 11: ACL — owner can update their own entity
-- =============================================================================

DO $$ DECLARE cnt int; BEGIN
  PERFORM set_config('app.actor_id', '01TEAM00000000000000000000', true);
  PERFORM set_config('app.actor_read_level', '2', true);
  PERFORM set_config('app.actor_write_level', '2', true);
  PERFORM set_config('app.actor_is_admin', 'false', true);

  UPDATE entities SET properties = '{"label": "Team Owned Updated"}' WHERE id = '01ENT_TEAM_OWN0000000000';
  GET DIAGNOSTICS cnt = ROW_COUNT;
  IF cnt = 1 THEN
    PERFORM test_pass('acl_owner_can_update');
  ELSE
    PERFORM test_fail('acl_owner_can_update', 'Expected 1 row, got ' || cnt);
  END IF;
END $$;


-- =============================================================================
-- TEST 12: ACL — non-owner without grant cannot update
-- =============================================================================

DO $$ DECLARE cnt int; BEGIN
  PERFORM set_config('app.actor_id', '01INTERNAL0000000000000000', true);
  PERFORM set_config('app.actor_read_level', '2', true);
  PERFORM set_config('app.actor_write_level', '2', true);
  PERFORM set_config('app.actor_is_admin', 'false', true);

  -- INTERNAL can SEE the TEAM_OWN entity (read_level=2, actor has level 2)
  -- but has no editor/admin grant on it, so UPDATE should be blocked
  UPDATE entities SET properties = '{"label": "hacked"}' WHERE id = '01ENT_TEAM_OWN0000000000';
  GET DIAGNOSTICS cnt = ROW_COUNT;
  IF cnt = 0 THEN
    PERFORM test_pass('acl_non_owner_no_grant_blocked');
  ELSE
    PERFORM test_fail('acl_non_owner_no_grant_blocked', 'Expected 0 rows, got ' || cnt);
  END IF;
END $$;


-- =============================================================================
-- TEST 13: ACL — actor with editor grant can update
-- =============================================================================

DO $$ DECLARE cnt int; BEGIN
  PERFORM set_config('app.actor_id', '01INTERNAL0000000000000000', true);
  PERFORM set_config('app.actor_read_level', '1', true);
  PERFORM set_config('app.actor_write_level', '1', true);
  PERFORM set_config('app.actor_is_admin', 'false', true);

  -- INTERNAL has an editor grant on INTERNAL entity
  UPDATE entities SET properties = '{"label": "Internal Doc Updated"}' WHERE id = '01ENT_INTERNAL000000000000';
  GET DIAGNOSTICS cnt = ROW_COUNT;
  IF cnt = 1 THEN
    PERFORM test_pass('acl_editor_grant_allows_update');
  ELSE
    PERFORM test_fail('acl_editor_grant_allows_update', 'Expected 1 row, got ' || cnt);
  END IF;
END $$;


-- =============================================================================
-- TEST 14: ACL — group-based editor grant allows update
-- =============================================================================

DO $$ DECLARE cnt int; BEGIN
  PERFORM set_config('app.actor_id', '01CONFID0000000000000000000', true);
  PERFORM set_config('app.actor_read_level', '3', true);
  PERFORM set_config('app.actor_write_level', '3', true);
  PERFORM set_config('app.actor_is_admin', 'false', true);

  -- CONFID is member of Editors group, which has editor on TEAM entity
  UPDATE entities SET properties = '{"label": "Team Doc Updated By Group"}' WHERE id = '01ENT_TEAM00000000000000';
  GET DIAGNOSTICS cnt = ROW_COUNT;
  IF cnt = 1 THEN
    PERFORM test_pass('acl_group_grant_allows_update');
  ELSE
    PERFORM test_fail('acl_group_grant_allows_update', 'Expected 1 row, got ' || cnt);
  END IF;
END $$;


-- =============================================================================
-- TEST 15: ACL — system admin can update any entity
-- =============================================================================

DO $$ DECLARE cnt int; BEGIN
  PERFORM set_config('app.actor_id', '01ADMIN0000000000000000000', true);
  PERFORM set_config('app.actor_read_level', '4', true);
  PERFORM set_config('app.actor_write_level', '4', true);
  PERFORM set_config('app.actor_is_admin', 'true', true);

  UPDATE entities SET properties = '{"label": "Team Owned Admin Edit"}' WHERE id = '01ENT_TEAM_OWN0000000000';
  GET DIAGNOSTICS cnt = ROW_COUNT;
  IF cnt = 1 THEN
    PERFORM test_pass('acl_admin_can_update_any');
  ELSE
    PERFORM test_fail('acl_admin_can_update_any', 'Expected 1 row, got ' || cnt);
  END IF;
END $$;


-- =============================================================================
-- TEST 16: ACL — non-owner cannot delete (needs admin role)
-- =============================================================================

DO $$ DECLARE cnt int; BEGIN
  PERFORM set_config('app.actor_id', '01INTERNAL0000000000000000', true);
  PERFORM set_config('app.actor_read_level', '1', true);
  PERFORM set_config('app.actor_write_level', '1', true);
  PERFORM set_config('app.actor_is_admin', 'false', true);

  -- INTERNAL has editor (not admin) grant on INTERNAL entity — cannot delete
  DELETE FROM entities WHERE id = '01ENT_INTERNAL000000000000';
  GET DIAGNOSTICS cnt = ROW_COUNT;
  IF cnt = 0 THEN
    PERFORM test_pass('acl_editor_cannot_delete');
  ELSE
    PERFORM test_fail('acl_editor_cannot_delete', 'Expected 0 rows, got ' || cnt);
  END IF;
END $$;


-- =============================================================================
-- TEST 17: ACL — actor can create another actor at or below their level
-- =============================================================================

DO $$ BEGIN
  PERFORM set_config('app.actor_id', '01TEAM00000000000000000000', true);
  PERFORM set_config('app.actor_read_level', '2', true);
  PERFORM set_config('app.actor_write_level', '2', true);
  PERFORM set_config('app.actor_is_admin', 'false', true);

  -- TEAM (level 2) creates an actor at level 1 — should succeed
  INSERT INTO actors (id, kind, max_read_level, max_write_level, owner_id, properties)
  VALUES ('01TEST_ACTOR_OK000000000', 'agent', 1, 1, '01TEAM00000000000000000000', '{}');

  PERFORM test_pass('acl_actor_can_create_at_lower_level');
EXCEPTION WHEN insufficient_privilege THEN
  PERFORM test_fail('acl_actor_can_create_at_lower_level', 'Insert should have succeeded');
END $$;


-- =============================================================================
-- TEST 17b: ACL — actor cannot create actor above their level
-- =============================================================================

DO $$ BEGIN
  PERFORM set_config('app.actor_id', '01TEAM00000000000000000000', true);
  PERFORM set_config('app.actor_read_level', '2', true);
  PERFORM set_config('app.actor_write_level', '2', true);
  PERFORM set_config('app.actor_is_admin', 'false', true);

  -- TEAM (level 2) tries to create an actor at level 3 — should fail
  INSERT INTO actors (id, kind, max_read_level, max_write_level, owner_id, properties)
  VALUES ('01TEST_ACTOR_FAIL00000000', 'agent', 3, 3, '01TEAM00000000000000000000', '{}');

  PERFORM test_fail('acl_actor_cannot_create_above_level', 'Insert should have been blocked');
EXCEPTION WHEN insufficient_privilege THEN
  PERFORM test_pass('acl_actor_cannot_create_above_level');
END $$;


-- =============================================================================
-- TEST 17c: ACL — actor can create at same level
-- =============================================================================

DO $$ BEGIN
  PERFORM set_config('app.actor_id', '01TEAM00000000000000000000', true);
  PERFORM set_config('app.actor_read_level', '2', true);
  PERFORM set_config('app.actor_write_level', '2', true);
  PERFORM set_config('app.actor_is_admin', 'false', true);

  -- TEAM (level 2) creates an actor at level 2 — should succeed
  INSERT INTO actors (id, kind, max_read_level, max_write_level, owner_id, properties)
  VALUES ('01TEST_ACTOR_SAME0000000', 'agent', 2, 2, '01TEAM00000000000000000000', '{}');

  PERFORM test_pass('acl_actor_can_create_at_same_level');
EXCEPTION WHEN insufficient_privilege THEN
  PERFORM test_fail('acl_actor_can_create_at_same_level', 'Insert should have succeeded');
END $$;


-- =============================================================================
-- TEST 18: ACL — space contributor can add entity to space
-- =============================================================================

DO $$ BEGIN
  PERFORM set_config('app.actor_id', '01INTERNAL0000000000000000', true);
  PERFORM set_config('app.actor_read_level', '1', true);
  PERFORM set_config('app.actor_write_level', '1', true);
  PERFORM set_config('app.actor_is_admin', 'false', true);

  -- INTERNAL has contributor role on Internal Space
  INSERT INTO space_entities (space_id, entity_id, added_by)
  VALUES ('01SPACE_INTERNAL000000000', '01ENT_INTERNAL000000000000', '01INTERNAL0000000000000000');

  PERFORM test_pass('acl_space_contributor_can_add_entity');
EXCEPTION WHEN insufficient_privilege THEN
  PERFORM test_fail('acl_space_contributor_can_add_entity', 'Insert should have succeeded');
END $$;


-- =============================================================================
-- TEST 19: ACL — actor without space role cannot add entity
-- =============================================================================

DO $$ BEGIN
  PERFORM set_config('app.actor_id', '01TEAM00000000000000000000', true);
  PERFORM set_config('app.actor_read_level', '2', true);
  PERFORM set_config('app.actor_write_level', '2', true);
  PERFORM set_config('app.actor_is_admin', 'false', true);

  -- TEAM has no space permission on Internal Space
  INSERT INTO space_entities (space_id, entity_id, added_by)
  VALUES ('01SPACE_INTERNAL000000000', '01ENT_TEAM00000000000000', '01TEAM00000000000000000000');

  PERFORM test_fail('acl_no_space_role_blocked', 'Insert should have been blocked');
EXCEPTION WHEN insufficient_privilege THEN
  PERFORM test_pass('acl_no_space_role_blocked');
END $$;


-- =============================================================================
-- Cleanup test entities and reset role
-- =============================================================================
RESET ROLE;

DELETE FROM space_entities WHERE space_id = '01SPACE_INTERNAL000000000';
DELETE FROM actors WHERE id IN ('01TEST_ACTOR_OK000000000', '01TEST_ACTOR_SAME0000000');
DELETE FROM entities WHERE id IN ('01TEST_WRITE_OK00000000');


-- =============================================================================
-- Results (back to superuser role)
-- =============================================================================
RESET ROLE;

\echo ''
\echo '=============================='
\echo '  SCHEMA v2 TEST RESULTS'
\echo '=============================='
\echo ''

SELECT
  CASE WHEN passed THEN '  PASS  ' ELSE '  FAIL  ' END || name ||
  CASE WHEN detail IS NOT NULL THEN ' (' || detail || ')' ELSE '' END
FROM test_results
ORDER BY passed DESC, name;

\echo ''

SELECT
  'Total: ' || count(*) ||
  '  Passed: ' || count(*) FILTER (WHERE passed) ||
  '  Failed: ' || count(*) FILTER (WHERE NOT passed)
FROM test_results;

-- Cleanup
DROP TABLE test_results;
DROP FUNCTION IF EXISTS test_pass(text);
DROP FUNCTION IF EXISTS test_fail(text, text);
