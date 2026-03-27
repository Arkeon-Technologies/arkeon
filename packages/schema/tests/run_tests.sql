-- =============================================================================
-- Schema Test Suite
-- =============================================================================
-- Run: psql $DATABASE_URL -f schema/tests/run_tests.sql
--
-- Tests constraints, cascades, CAS, triggers, RLS, and edge cases against
-- the current schema (commons_id, predicate on edges, Ed25519 auth, etc.)
-- =============================================================================

\set ON_ERROR_STOP off
\set QUIET on
\pset format unaligned
\pset tuples_only on

-- Track results
CREATE TEMP TABLE test_results (name TEXT, passed BOOLEAN, detail TEXT);

CREATE OR REPLACE FUNCTION test_pass(n TEXT) RETURNS void AS $$
  INSERT INTO test_results VALUES (n, true, NULL);
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION test_fail(n TEXT, msg TEXT) RETURNS void AS $$
  INSERT INTO test_results VALUES (n, false, msg);
$$ LANGUAGE sql;

-- =============================================================================
-- Setup: app_user role for RLS tests
-- =============================================================================

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user LOGIN PASSWORD 'test_password';
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;
GRANT app_user TO neondb_owner;

-- =============================================================================
-- Seed Data
-- =============================================================================

DELETE FROM entity_activity;
DELETE FROM entity_versions;
DELETE FROM relationship_edges;
DELETE FROM entity_access;
DELETE FROM api_keys;
DELETE FROM agent_keys;
DELETE FROM entities;

-- The Arke (root commons, commons_id = NULL)
INSERT INTO entities (id, kind, type, properties, owner_id, commons_id, edited_by, created_at, updated_at)
VALUES ('00000000000000000000000000', 'commons', 'commons', '{"label": "The Arke"}', 'SYSTEM', NULL, 'SYSTEM', NOW(), NOW());

-- Users (commons_id = NULL)
INSERT INTO entities (id, kind, type, properties, owner_id, commons_id, edited_by, created_at, updated_at)
VALUES
  ('01ALICE00000000000000000000', 'user', 'person', '{"label": "Alice"}', '01ALICE00000000000000000000', NULL, '01ALICE00000000000000000000', NOW(), NOW()),
  ('01BOB0000000000000000000000', 'user', 'person', '{"label": "Bob"}',   '01BOB0000000000000000000000', NULL, '01BOB0000000000000000000000', NOW(), NOW()),
  ('01CAROL00000000000000000000', 'user', 'person', '{"label": "Carol"}', '01CAROL00000000000000000000', NULL, '01CAROL00000000000000000000', NOW(), NOW());

-- Alice's commons (public view, contributors-only contribute)
INSERT INTO entities (id, kind, type, properties, owner_id, commons_id, view_access, contribute_access, edited_by, created_at, updated_at)
VALUES ('01COMMONS0000000000000000000', 'commons', 'collection', '{"label": "Test Commons"}', '01ALICE00000000000000000000', '00000000000000000000000000', 'public', 'contributors', '01ALICE00000000000000000000', NOW(), NOW());

-- Alice's public entity in the commons (edit_access = collaborators)
INSERT INTO entities (id, kind, type, properties, owner_id, commons_id, view_access, edit_access, edited_by, created_at, updated_at)
VALUES ('01ENT_PUB000000000000000000', 'entity', 'book', '{"label": "Public Book"}', '01ALICE00000000000000000000', '01COMMONS0000000000000000000', 'public', 'collaborators', '01ALICE00000000000000000000', NOW(), NOW());

-- Alice's private entity in the commons
INSERT INTO entities (id, kind, type, properties, owner_id, commons_id, view_access, edit_access, edited_by, created_at, updated_at)
VALUES ('01ENT_PRIV00000000000000000', 'entity', 'book', '{"label": "Private Book"}', '01ALICE00000000000000000000', '01COMMONS0000000000000000000', 'private', 'owner', '01ALICE00000000000000000000', NOW(), NOW());

-- Bob's entity
INSERT INTO entities (id, kind, type, properties, owner_id, commons_id, edited_by, created_at, updated_at)
VALUES ('01ENT_BOB000000000000000000', 'entity', 'essay', '{"label": "Bob Essay"}', '01BOB0000000000000000000000', '01COMMONS0000000000000000000', '01BOB0000000000000000000000', NOW(), NOW());

-- Grants: Bob has edit on Alice's public entity
INSERT INTO entity_access (entity_id, actor_id, access_type)
VALUES ('01ENT_PUB000000000000000000', '01BOB0000000000000000000000', 'edit');

-- Grants: Carol has view on Alice's private entity
INSERT INTO entity_access (entity_id, actor_id, access_type)
VALUES ('01ENT_PRIV00000000000000000', '01CAROL00000000000000000000', 'view');

-- =============================================================================
-- 1. CHECK Constraints
-- =============================================================================

-- 1a. Invalid kind (old values rejected)
DO $$ BEGIN
  BEGIN
    INSERT INTO entities (id, kind, type, properties, owner_id, edited_by, created_at, updated_at)
    VALUES ('01TEMP', 'work', 'book', '{}', 'x', 'x', NOW(), NOW());
    PERFORM test_fail('1a_invalid_kind_work', 'Accepted old kind "work"');
  EXCEPTION WHEN check_violation THEN
    PERFORM test_pass('1a_invalid_kind_work');
  END;
END $$;

DO $$ BEGIN
  BEGIN
    INSERT INTO entities (id, kind, type, properties, owner_id, edited_by, created_at, updated_at)
    VALUES ('01TEMP', 'part', 'chapter', '{}', 'x', 'x', NOW(), NOW());
    PERFORM test_fail('1b_invalid_kind_part', 'Accepted old kind "part"');
  EXCEPTION WHEN check_violation THEN
    PERFORM test_pass('1b_invalid_kind_part');
  END;
END $$;

-- 1c. All valid kinds accepted
DO $$ BEGIN
  -- We already have commons, entity, user in seed data. Test agent + relationship.
  INSERT INTO entities (id, kind, type, properties, owner_id, edited_by, created_at, updated_at)
  VALUES ('01TEMP_AGENT00000000000000', 'agent', 'bot', '{}', '01ALICE00000000000000000000', '01ALICE00000000000000000000', NOW(), NOW());
  INSERT INTO entities (id, kind, type, properties, owner_id, edited_by, created_at, updated_at)
  VALUES ('01TEMP_REL000000000000000000', 'relationship', 'relationship', '{}', '01ALICE00000000000000000000', '01ALICE00000000000000000000', NOW(), NOW());
  DELETE FROM entities WHERE id IN ('01TEMP_AGENT00000000000000', '01TEMP_REL000000000000000000');
  PERFORM test_pass('1c_valid_kinds');
EXCEPTION WHEN OTHERS THEN
  PERFORM test_fail('1c_valid_kinds', SQLERRM);
END $$;

-- 1d. Invalid view_access
DO $$ BEGIN
  BEGIN
    INSERT INTO entities (id, kind, type, properties, owner_id, view_access, edited_by, created_at, updated_at)
    VALUES ('01TEMP', 'entity', 'book', '{}', 'x', 'friends_only', 'x', NOW(), NOW());
    PERFORM test_fail('1d_invalid_view_access', 'Accepted invalid view_access');
  EXCEPTION WHEN check_violation THEN
    PERFORM test_pass('1d_invalid_view_access');
  END;
END $$;

-- 1e. Invalid edit_access
DO $$ BEGIN
  BEGIN
    INSERT INTO entities (id, kind, type, properties, owner_id, edit_access, edited_by, created_at, updated_at)
    VALUES ('01TEMP', 'entity', 'book', '{}', 'x', 'anyone', 'x', NOW(), NOW());
    PERFORM test_fail('1e_invalid_edit_access', 'Accepted invalid edit_access');
  EXCEPTION WHEN check_violation THEN
    PERFORM test_pass('1e_invalid_edit_access');
  END;
END $$;

-- 1f. Invalid contribute_access
DO $$ BEGIN
  BEGIN
    INSERT INTO entities (id, kind, type, properties, owner_id, contribute_access, edited_by, created_at, updated_at)
    VALUES ('01TEMP', 'entity', 'book', '{}', 'x', 'everyone', 'x', NOW(), NOW());
    PERFORM test_fail('1f_invalid_contribute_access', 'Accepted invalid contribute_access');
  EXCEPTION WHEN check_violation THEN
    PERFORM test_pass('1f_invalid_contribute_access');
  END;
END $$;

-- 1g. Invalid access_type on entity_access
DO $$ BEGIN
  BEGIN
    INSERT INTO entity_access (entity_id, actor_id, access_type)
    VALUES ('01ENT_PUB000000000000000000', '01CAROL00000000000000000000', 'superadmin');
    PERFORM test_fail('1g_invalid_access_type', 'Accepted invalid access_type');
  EXCEPTION WHEN check_violation THEN
    PERFORM test_pass('1g_invalid_access_type');
  END;
END $$;

-- =============================================================================
-- 2. Foreign Keys & Referential Integrity
-- =============================================================================

-- 2a. entity_access → nonexistent entity
DO $$ BEGIN
  BEGIN
    INSERT INTO entity_access (entity_id, actor_id, access_type)
    VALUES ('NONEXISTENT0000000000000000', '01BOB0000000000000000000000', 'view');
    PERFORM test_fail('2a_fk_access_entity', 'Accepted nonexistent entity_id');
  EXCEPTION WHEN foreign_key_violation THEN
    PERFORM test_pass('2a_fk_access_entity');
  END;
END $$;

-- 2b. relationship_edges.source_id → nonexistent
DO $$ BEGIN
  BEGIN
    INSERT INTO relationship_edges (id, source_id, target_id, predicate)
    VALUES ('01ENT_PUB000000000000000000', 'NONEXISTENT0000000000000000', '01ENT_BOB000000000000000000', 'cites');
    PERFORM test_fail('2b_fk_edge_source', 'Accepted nonexistent source_id');
  EXCEPTION WHEN foreign_key_violation THEN
    PERFORM test_pass('2b_fk_edge_source');
  END;
END $$;

-- 2c. relationship_edges.target_id → nonexistent
DO $$ BEGIN
  BEGIN
    INSERT INTO relationship_edges (id, source_id, target_id, predicate)
    VALUES ('01ENT_PUB000000000000000000', '01ENT_PUB000000000000000000', 'NONEXISTENT0000000000000000', 'cites');
    PERFORM test_fail('2c_fk_edge_target', 'Accepted nonexistent target_id');
  EXCEPTION WHEN foreign_key_violation THEN
    PERFORM test_pass('2c_fk_edge_target');
  END;
END $$;

-- 2d. relationship_edges.id → must reference entity
DO $$ BEGIN
  BEGIN
    INSERT INTO relationship_edges (id, source_id, target_id, predicate)
    VALUES ('NONEXISTENT0000000000000000', '01ENT_PUB000000000000000000', '01ENT_BOB000000000000000000', 'cites');
    PERFORM test_fail('2d_fk_edge_id', 'Accepted nonexistent edge id');
  EXCEPTION WHEN foreign_key_violation THEN
    PERFORM test_pass('2d_fk_edge_id');
  END;
END $$;

-- 2e. commons_id → nonexistent entity
DO $$ BEGIN
  BEGIN
    INSERT INTO entities (id, kind, type, properties, owner_id, commons_id, edited_by, created_at, updated_at)
    VALUES ('01TEMP', 'entity', 'book', '{}', 'x', 'NONEXISTENT0000000000000000', 'x', NOW(), NOW());
    PERFORM test_fail('2e_fk_commons_id', 'Accepted nonexistent commons_id');
  EXCEPTION WHEN foreign_key_violation THEN
    PERFORM test_pass('2e_fk_commons_id');
  END;
END $$;

-- =============================================================================
-- 3. CASCADE Deletes
-- =============================================================================

-- 3a. Delete entity → cascades access, versions, activity
INSERT INTO entities (id, kind, type, properties, owner_id, commons_id, edited_by, created_at, updated_at)
VALUES ('01CASCADE_TEST0000000000000', 'entity', 'book', '{"label": "Cascade"}', '01ALICE00000000000000000000', '01COMMONS0000000000000000000', '01ALICE00000000000000000000', NOW(), NOW());
INSERT INTO entity_access (entity_id, actor_id, access_type) VALUES ('01CASCADE_TEST0000000000000', '01BOB0000000000000000000000', 'view');
INSERT INTO entity_versions (entity_id, ver, properties, edited_by, created_at) VALUES ('01CASCADE_TEST0000000000000', 1, '{"label": "Cascade"}', '01ALICE00000000000000000000', NOW());
INSERT INTO entity_activity (entity_id, actor_id, action) VALUES ('01CASCADE_TEST0000000000000', '01ALICE00000000000000000000', 'entity_created');

DELETE FROM entities WHERE id = '01CASCADE_TEST0000000000000';

DO $$
DECLARE a INT; v INT; act INT;
BEGIN
  SELECT COUNT(*) INTO a FROM entity_access WHERE entity_id = '01CASCADE_TEST0000000000000';
  SELECT COUNT(*) INTO v FROM entity_versions WHERE entity_id = '01CASCADE_TEST0000000000000';
  SELECT COUNT(*) INTO act FROM entity_activity WHERE entity_id = '01CASCADE_TEST0000000000000';
  IF a = 0 AND v = 0 AND act = 0 THEN
    PERFORM test_pass('3a_cascade_access_versions_activity');
  ELSE
    PERFORM test_fail('3a_cascade_access_versions_activity', format('a=%s v=%s act=%s', a, v, act));
  END IF;
END $$;

-- 3b. Delete entity → cascades edges (source and target)
INSERT INTO entities (id, kind, type, properties, owner_id, commons_id, edited_by, created_at, updated_at)
VALUES ('01CASCADE_SRC00000000000000', 'entity', 'book', '{}', '01ALICE00000000000000000000', '01COMMONS0000000000000000000', '01ALICE00000000000000000000', NOW(), NOW());
INSERT INTO entities (id, kind, type, properties, owner_id, edited_by, created_at, updated_at)
VALUES ('01CASCADE_REL00000000000000', 'relationship', 'relationship', '{}', '01ALICE00000000000000000000', '01ALICE00000000000000000000', NOW(), NOW());
INSERT INTO relationship_edges (id, source_id, target_id, predicate)
VALUES ('01CASCADE_REL00000000000000', '01CASCADE_SRC00000000000000', '01ENT_BOB000000000000000000', 'cites');

-- Delete source → edge should cascade
DELETE FROM entities WHERE id = '01CASCADE_SRC00000000000000';

DO $$
DECLARE e INT;
BEGIN
  SELECT COUNT(*) INTO e FROM relationship_edges WHERE id = '01CASCADE_REL00000000000000';
  IF e = 0 THEN
    PERFORM test_pass('3b_cascade_edge_on_source_delete');
  ELSE
    PERFORM test_fail('3b_cascade_edge_on_source_delete', 'Edge still exists');
  END IF;
END $$;

-- Cleanup orphaned rel entity
DELETE FROM entities WHERE id = '01CASCADE_REL00000000000000';

-- 3c. Delete relationship entity → cascades its edge
INSERT INTO entities (id, kind, type, properties, owner_id, edited_by, created_at, updated_at)
VALUES ('01CASCADE_REL2000000000000', 'relationship', 'relationship', '{}', '01ALICE00000000000000000000', '01ALICE00000000000000000000', NOW(), NOW());
INSERT INTO relationship_edges (id, source_id, target_id, predicate)
VALUES ('01CASCADE_REL2000000000000', '01ENT_PUB000000000000000000', '01ENT_BOB000000000000000000', 'cites');

DELETE FROM entities WHERE id = '01CASCADE_REL2000000000000';

DO $$
DECLARE e INT;
BEGIN
  SELECT COUNT(*) INTO e FROM relationship_edges WHERE id = '01CASCADE_REL2000000000000';
  IF e = 0 THEN
    PERFORM test_pass('3c_cascade_edge_on_rel_delete');
  ELSE
    PERFORM test_fail('3c_cascade_edge_on_rel_delete', 'Edge still exists');
  END IF;
END $$;

-- 3d. Delete commons with children → RESTRICTED (NO ACTION)
DO $$ BEGIN
  BEGIN
    DELETE FROM entities WHERE id = '01COMMONS0000000000000000000';
    PERFORM test_fail('3d_commons_delete_restricted', 'Allowed deleting commons with children');
  EXCEPTION WHEN foreign_key_violation THEN
    PERFORM test_pass('3d_commons_delete_restricted');
  END;
END $$;

-- =============================================================================
-- 4. Defaults
-- =============================================================================

INSERT INTO entities (id, kind, type, owner_id, commons_id, edited_by, created_at, updated_at)
VALUES ('01DEFAULTS_TEST000000000000', 'entity', 'book', '01ALICE00000000000000000000', '01COMMONS0000000000000000000', '01ALICE00000000000000000000', NOW(), NOW());

DO $$
DECLARE r RECORD;
BEGIN
  SELECT * INTO r FROM entities WHERE id = '01DEFAULTS_TEST000000000000';
  IF r.ver = 1 AND r.properties = '{}'::jsonb
     AND r.view_access = 'public' AND r.edit_access = 'collaborators'
     AND r.contribute_access = 'public' THEN
    PERFORM test_pass('4a_all_defaults');
  ELSE
    PERFORM test_fail('4a_all_defaults', format('ver=%s view=%s edit=%s contrib=%s props=%s',
      r.ver, r.view_access, r.edit_access, r.contribute_access, r.properties));
  END IF;
END $$;

DELETE FROM entities WHERE id = '01DEFAULTS_TEST000000000000';

-- =============================================================================
-- 5. CAS Pattern
-- =============================================================================

-- 5a. Successful CAS
DO $$
DECLARE cnt INT; new_ver INT;
BEGIN
  UPDATE entities SET ver = ver + 1, properties = '{"label": "Updated"}',
    edited_by = '01ALICE00000000000000000000', updated_at = NOW()
  WHERE id = '01ENT_PUB000000000000000000' AND ver = 1;
  GET DIAGNOSTICS cnt = ROW_COUNT;
  SELECT ver INTO new_ver FROM entities WHERE id = '01ENT_PUB000000000000000000';
  IF cnt = 1 AND new_ver = 2 THEN PERFORM test_pass('5a_cas_success');
  ELSE PERFORM test_fail('5a_cas_success', format('cnt=%s ver=%s', cnt, new_ver)); END IF;
END $$;

-- 5b. Failed CAS (stale ver)
DO $$
DECLARE cnt INT;
BEGIN
  UPDATE entities SET ver = ver + 1, properties = '{"label": "Conflict"}',
    edited_by = '01BOB0000000000000000000000', updated_at = NOW()
  WHERE id = '01ENT_PUB000000000000000000' AND ver = 1;  -- stale
  GET DIAGNOSTICS cnt = ROW_COUNT;
  IF cnt = 0 THEN PERFORM test_pass('5b_cas_conflict');
  ELSE PERFORM test_fail('5b_cas_conflict', 'Should have matched 0 rows'); END IF;
END $$;

-- =============================================================================
-- 6. Triggers
-- =============================================================================

-- 6a. Activity insert does not bump updated_at
DO $$
DECLARE old_ts TIMESTAMPTZ; new_ts TIMESTAMPTZ;
BEGIN
  SELECT updated_at INTO old_ts FROM entities WHERE id = '01ENT_BOB000000000000000000';
  PERFORM pg_sleep(0.01);
  INSERT INTO entity_activity (entity_id, actor_id, action) VALUES ('01ENT_BOB000000000000000000', '01BOB0000000000000000000000', 'content_updated');
  SELECT updated_at INTO new_ts FROM entities WHERE id = '01ENT_BOB000000000000000000';
  IF new_ts = old_ts THEN PERFORM test_pass('6a_activity_does_not_bump_updated_at');
  ELSE PERFORM test_fail('6a_activity_does_not_bump_updated_at', format('old=%s new=%s', old_ts, new_ts)); END IF;
END $$;

-- 6b. notify_activity function exists
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'notify_activity') THEN
    PERFORM test_pass('6b_notify_function_exists');
  ELSE
    PERFORM test_fail('6b_notify_function_exists', 'Function missing');
  END IF;
END $$;

-- =============================================================================
-- 7. entity_exists() Function
-- =============================================================================

-- 7a. Returns true for existing entity
DO $$
BEGIN
  IF entity_exists('01ENT_PUB000000000000000000') THEN
    PERFORM test_pass('7a_entity_exists_true');
  ELSE
    PERFORM test_fail('7a_entity_exists_true', 'Returned false for existing entity');
  END IF;
END $$;

-- 7b. Returns false for nonexistent
DO $$
BEGIN
  IF NOT entity_exists('NONEXISTENT0000000000000000') THEN
    PERFORM test_pass('7b_entity_exists_false');
  ELSE
    PERFORM test_fail('7b_entity_exists_false', 'Returned true for nonexistent entity');
  END IF;
END $$;

-- 7c. Bypasses RLS — app_user can check private entity they can't see
DO $$
DECLARE result BOOLEAN;
BEGIN
  SET LOCAL ROLE app_user;
  SET LOCAL app.actor_id = '01BOB0000000000000000000000';
  -- Bob has no grant on Alice's private entity
  SELECT entity_exists('01ENT_PRIV00000000000000000') INTO result;
  RESET ROLE;
  IF result THEN PERFORM test_pass('7c_entity_exists_bypasses_rls');
  ELSE PERFORM test_fail('7c_entity_exists_bypasses_rls', 'Did not bypass RLS'); END IF;
END $$;

-- =============================================================================
-- 8. commons_id Behavior
-- =============================================================================

-- 8a. Entity references commons
DO $$
DECLARE cid TEXT;
BEGIN
  SELECT commons_id INTO cid FROM entities WHERE id = '01ENT_PUB000000000000000000';
  IF cid = '01COMMONS0000000000000000000' THEN PERFORM test_pass('8a_commons_id_set');
  ELSE PERFORM test_fail('8a_commons_id_set', format('commons_id=%s', cid)); END IF;
END $$;

-- 8b. commons_id = NULL allowed
DO $$
DECLARE cid TEXT;
BEGIN
  SELECT commons_id INTO cid FROM entities WHERE id = '01ALICE00000000000000000000';
  IF cid IS NULL THEN PERFORM test_pass('8b_commons_id_null_allowed');
  ELSE PERFORM test_fail('8b_commons_id_null_allowed', format('commons_id=%s', cid)); END IF;
END $$;

-- 8c. commons_id FK to nonexistent (already tested in 2e, but explicit)
-- Covered by test 2e

-- =============================================================================
-- 9. Relationship Edges with Predicate
-- =============================================================================

-- 9a. predicate is NOT NULL
DO $$ BEGIN
  BEGIN
    INSERT INTO entities (id, kind, type, properties, owner_id, edited_by, created_at, updated_at)
    VALUES ('01TEMP_REL_NN00000000000000', 'relationship', 'relationship', '{}', '01ALICE00000000000000000000', '01ALICE00000000000000000000', NOW(), NOW());
    INSERT INTO relationship_edges (id, source_id, target_id, predicate)
    VALUES ('01TEMP_REL_NN00000000000000', '01ENT_PUB000000000000000000', '01ENT_BOB000000000000000000', NULL);
    PERFORM test_fail('9a_predicate_not_null', 'Accepted NULL predicate');
  EXCEPTION WHEN not_null_violation THEN
    PERFORM test_pass('9a_predicate_not_null');
  END;
  DELETE FROM entities WHERE id = '01TEMP_REL_NN00000000000000';
END $$;

-- 9b. Multiple predicates same source→target
DO $$ BEGIN
  INSERT INTO entities (id, kind, type, properties, owner_id, edited_by, created_at, updated_at)
  VALUES ('01REL_CITES0000000000000000', 'relationship', 'relationship', '{}', '01ALICE00000000000000000000', '01ALICE00000000000000000000', NOW(), NOW());
  INSERT INTO entities (id, kind, type, properties, owner_id, edited_by, created_at, updated_at)
  VALUES ('01REL_REFS00000000000000000', 'relationship', 'relationship', '{}', '01ALICE00000000000000000000', '01ALICE00000000000000000000', NOW(), NOW());

  INSERT INTO relationship_edges (id, source_id, target_id, predicate)
  VALUES ('01REL_CITES0000000000000000', '01ENT_PUB000000000000000000', '01ENT_BOB000000000000000000', 'cites');
  INSERT INTO relationship_edges (id, source_id, target_id, predicate)
  VALUES ('01REL_REFS00000000000000000', '01ENT_PUB000000000000000000', '01ENT_BOB000000000000000000', 'references');

  PERFORM test_pass('9b_multiple_predicates');

  DELETE FROM entities WHERE id IN ('01REL_CITES0000000000000000', '01REL_REFS00000000000000000');
EXCEPTION WHEN OTHERS THEN
  PERFORM test_fail('9b_multiple_predicates', SQLERRM);
END $$;

-- 9c. Self-referential edge
DO $$ BEGIN
  INSERT INTO entities (id, kind, type, properties, owner_id, edited_by, created_at, updated_at)
  VALUES ('01REL_SELF0000000000000000', 'relationship', 'relationship', '{}', '01ALICE00000000000000000000', '01ALICE00000000000000000000', NOW(), NOW());
  INSERT INTO relationship_edges (id, source_id, target_id, predicate)
  VALUES ('01REL_SELF0000000000000000', '01ENT_PUB000000000000000000', '01ENT_PUB000000000000000000', 'related_to');

  PERFORM test_pass('9c_self_referential_edge');
  DELETE FROM entities WHERE id = '01REL_SELF0000000000000000';
EXCEPTION WHEN OTHERS THEN
  PERFORM test_fail('9c_self_referential_edge', SQLERRM);
END $$;

-- =============================================================================
-- 10. RLS: Entities
-- =============================================================================

-- 10a. Unauthenticated sees only public
DO $$
DECLARE priv_visible BOOLEAN; pub_count INT;
BEGIN
  SET LOCAL ROLE app_user;
  SET LOCAL app.actor_id = '';
  SELECT EXISTS(SELECT 1 FROM entities WHERE id = '01ENT_PRIV00000000000000000') INTO priv_visible;
  SELECT COUNT(*) INTO pub_count FROM entities WHERE kind = 'entity';
  RESET ROLE;
  IF NOT priv_visible AND pub_count >= 2 THEN PERFORM test_pass('10a_unauth_public_only');
  ELSE PERFORM test_fail('10a_unauth_public_only', format('priv=%s pub=%s', priv_visible, pub_count)); END IF;
END $$;

-- 10b. Owner sees private
DO $$
DECLARE can_see BOOLEAN;
BEGIN
  SET LOCAL ROLE app_user;
  SET LOCAL app.actor_id = '01ALICE00000000000000000000';
  SELECT EXISTS(SELECT 1 FROM entities WHERE id = '01ENT_PRIV00000000000000000') INTO can_see;
  RESET ROLE;
  IF can_see THEN PERFORM test_pass('10b_owner_sees_private');
  ELSE PERFORM test_fail('10b_owner_sees_private', 'Owner cannot see'); END IF;
END $$;

-- 10c. Stranger cannot see private
DO $$
DECLARE can_see BOOLEAN;
BEGIN
  SET LOCAL ROLE app_user;
  SET LOCAL app.actor_id = '01BOB0000000000000000000000';
  SELECT EXISTS(SELECT 1 FROM entities WHERE id = '01ENT_PRIV00000000000000000') INTO can_see;
  RESET ROLE;
  IF NOT can_see THEN PERFORM test_pass('10c_stranger_cant_see_private');
  ELSE PERFORM test_fail('10c_stranger_cant_see_private', 'Stranger sees private'); END IF;
END $$;

-- 10d. View grant gives visibility
DO $$
DECLARE can_see BOOLEAN;
BEGIN
  SET LOCAL ROLE app_user;
  SET LOCAL app.actor_id = '01CAROL00000000000000000000';
  SELECT EXISTS(SELECT 1 FROM entities WHERE id = '01ENT_PRIV00000000000000000') INTO can_see;
  RESET ROLE;
  IF can_see THEN PERFORM test_pass('10d_view_grant_visibility');
  ELSE PERFORM test_fail('10d_view_grant_visibility', 'Granted viewer cannot see'); END IF;
END $$;

-- 10e. INSERT must be owner
DO $$
DECLARE ok BOOLEAN;
BEGIN
  SET LOCAL ROLE app_user;
  SET LOCAL app.actor_id = '01BOB0000000000000000000000';
  BEGIN
    INSERT INTO entities (id, kind, type, properties, owner_id, edited_by, created_at, updated_at)
    VALUES ('01RLS_INS_TEST0000000000000', 'entity', 'book', '{}', '01ALICE00000000000000000000', '01BOB0000000000000000000000', NOW(), NOW());
    ok := true;
  EXCEPTION WHEN OTHERS THEN ok := false; END;
  RESET ROLE;
  IF NOT ok THEN PERFORM test_pass('10e_insert_must_be_owner');
  ELSE
    DELETE FROM entities WHERE id = '01RLS_INS_TEST0000000000000';
    PERFORM test_fail('10e_insert_must_be_owner', 'Allowed insert with different owner');
  END IF;
END $$;

-- 10f. INSERT with correct owner works
DO $$
DECLARE ok BOOLEAN;
BEGIN
  SET LOCAL ROLE app_user;
  SET LOCAL app.actor_id = '01BOB0000000000000000000000';
  BEGIN
    INSERT INTO entities (id, kind, type, properties, owner_id, commons_id, edited_by, created_at, updated_at)
    VALUES ('01RLS_INS_OK0000000000000000', 'entity', 'book', '{}', '01BOB0000000000000000000000', '01COMMONS0000000000000000000', '01BOB0000000000000000000000', NOW(), NOW());
    ok := true;
  EXCEPTION WHEN OTHERS THEN ok := false; END;
  RESET ROLE;
  DELETE FROM entities WHERE id = '01RLS_INS_OK0000000000000000';
  IF ok THEN PERFORM test_pass('10f_insert_as_owner_works');
  ELSE PERFORM test_fail('10f_insert_as_owner_works', 'Owner could not insert'); END IF;
END $$;

-- 10g. Owner can update
DO $$
DECLARE cnt INT;
BEGIN
  SET LOCAL ROLE app_user;
  SET LOCAL app.actor_id = '01ALICE00000000000000000000';
  UPDATE entities SET properties = '{"label": "Alice Updated"}', updated_at = NOW()
  WHERE id = '01ENT_PUB000000000000000000';
  GET DIAGNOSTICS cnt = ROW_COUNT;
  RESET ROLE;
  IF cnt = 1 THEN PERFORM test_pass('10g_owner_can_update');
  ELSE PERFORM test_fail('10g_owner_can_update', format('cnt=%s', cnt)); END IF;
END $$;

-- 10h. Editor (with grant) can update
DO $$
DECLARE cnt INT;
BEGIN
  SET LOCAL ROLE app_user;
  SET LOCAL app.actor_id = '01BOB0000000000000000000000';
  UPDATE entities SET properties = '{"label": "Bob Updated"}', updated_at = NOW()
  WHERE id = '01ENT_PUB000000000000000000';
  GET DIAGNOSTICS cnt = ROW_COUNT;
  RESET ROLE;
  IF cnt = 1 THEN PERFORM test_pass('10h_editor_can_update');
  ELSE PERFORM test_fail('10h_editor_can_update', format('cnt=%s', cnt)); END IF;
END $$;

-- 10i. Stranger cannot update
DO $$
DECLARE cnt INT;
BEGIN
  SET LOCAL ROLE app_user;
  SET LOCAL app.actor_id = '01CAROL00000000000000000000';
  UPDATE entities SET properties = '{"label": "Hacked"}', updated_at = NOW()
  WHERE id = '01ENT_PUB000000000000000000';
  GET DIAGNOSTICS cnt = ROW_COUNT;
  RESET ROLE;
  IF cnt = 0 THEN PERFORM test_pass('10i_stranger_cant_update');
  ELSE PERFORM test_fail('10i_stranger_cant_update', 'Stranger updated entity'); END IF;
END $$;

-- 10j. Owner can delete, non-owner cannot
DO $$
DECLARE cnt INT;
BEGIN
  -- Bob tries to delete Alice's entity
  SET LOCAL ROLE app_user;
  SET LOCAL app.actor_id = '01BOB0000000000000000000000';
  DELETE FROM entities WHERE id = '01ENT_PUB000000000000000000';
  GET DIAGNOSTICS cnt = ROW_COUNT;
  RESET ROLE;
  IF cnt = 0 THEN PERFORM test_pass('10j_nonowner_cant_delete');
  ELSE PERFORM test_fail('10j_nonowner_cant_delete', 'Non-owner deleted entity'); END IF;
END $$;

DO $$
DECLARE cnt INT;
BEGIN
  -- Create throwaway, delete as owner
  INSERT INTO entities (id, kind, type, properties, owner_id, edited_by, created_at, updated_at)
  VALUES ('01RLS_DEL_TEST0000000000000', 'entity', 'book', '{}', '01ALICE00000000000000000000', '01ALICE00000000000000000000', NOW(), NOW());
  SET LOCAL ROLE app_user;
  SET LOCAL app.actor_id = '01ALICE00000000000000000000';
  DELETE FROM entities WHERE id = '01RLS_DEL_TEST0000000000000';
  GET DIAGNOSTICS cnt = ROW_COUNT;
  RESET ROLE;
  IF cnt = 1 THEN PERFORM test_pass('10k_owner_can_delete');
  ELSE PERFORM test_fail('10k_owner_can_delete', 'Owner could not delete'); END IF;
END $$;

-- =============================================================================
-- 11. RLS: Entity Access
-- =============================================================================

-- 11a. Anyone can read grants
DO $$
DECLARE cnt INT;
BEGIN
  SET LOCAL ROLE app_user;
  SET LOCAL app.actor_id = '01CAROL00000000000000000000';
  SELECT COUNT(*) INTO cnt FROM entity_access WHERE entity_id = '01ENT_PUB000000000000000000';
  RESET ROLE;
  IF cnt > 0 THEN PERFORM test_pass('11a_anyone_reads_grants');
  ELSE PERFORM test_fail('11a_anyone_reads_grants', 'Grants not visible'); END IF;
END $$;

-- 11b. Owner can add grant
DO $$
DECLARE ok BOOLEAN;
BEGIN
  SET LOCAL ROLE app_user;
  SET LOCAL app.actor_id = '01ALICE00000000000000000000';
  BEGIN
    INSERT INTO entity_access (entity_id, actor_id, access_type)
    VALUES ('01ENT_PUB000000000000000000', '01CAROL00000000000000000000', 'view');
    ok := true;
  EXCEPTION WHEN OTHERS THEN ok := false; END;
  RESET ROLE;
  IF ok THEN PERFORM test_pass('11b_owner_can_grant');
  ELSE PERFORM test_fail('11b_owner_can_grant', 'Owner could not add grant'); END IF;
END $$;

-- 11c. Admin can add grant
INSERT INTO entity_access (entity_id, actor_id, access_type)
VALUES ('01ENT_PUB000000000000000000', '01BOB0000000000000000000000', 'admin');

DO $$
DECLARE ok BOOLEAN;
BEGIN
  SET LOCAL ROLE app_user;
  SET LOCAL app.actor_id = '01BOB0000000000000000000000';
  BEGIN
    INSERT INTO entity_access (entity_id, actor_id, access_type)
    VALUES ('01ENT_PUB000000000000000000', '01CAROL00000000000000000000', 'edit');
    ok := true;
  EXCEPTION WHEN OTHERS THEN ok := false; END;
  RESET ROLE;
  IF ok THEN PERFORM test_pass('11c_admin_can_grant');
  ELSE PERFORM test_fail('11c_admin_can_grant', 'Admin could not add grant'); END IF;
END $$;

-- 11d. Stranger cannot add grant
DO $$
DECLARE ok BOOLEAN;
BEGIN
  SET LOCAL ROLE app_user;
  SET LOCAL app.actor_id = '01CAROL00000000000000000000';
  BEGIN
    INSERT INTO entity_access (entity_id, actor_id, access_type)
    VALUES ('01ENT_BOB000000000000000000', '01CAROL00000000000000000000', 'admin');
    ok := true;
  EXCEPTION WHEN OTHERS THEN ok := false; END;
  RESET ROLE;
  IF NOT ok THEN PERFORM test_pass('11d_stranger_cant_grant');
  ELSE
    DELETE FROM entity_access WHERE entity_id = '01ENT_BOB000000000000000000' AND actor_id = '01CAROL00000000000000000000' AND access_type = 'admin';
    PERFORM test_fail('11d_stranger_cant_grant', 'Stranger added grant');
  END IF;
END $$;

-- =============================================================================
-- 12. RLS: Relationship Edges
-- =============================================================================

-- 12a. Owner of source can create edge
DO $$
DECLARE ok BOOLEAN;
BEGIN
  INSERT INTO entities (id, kind, type, properties, owner_id, edited_by, created_at, updated_at)
  VALUES ('01REL_RLS_A0000000000000000', 'relationship', 'relationship', '{}', '01ALICE00000000000000000000', '01ALICE00000000000000000000', NOW(), NOW());

  SET LOCAL ROLE app_user;
  SET LOCAL app.actor_id = '01ALICE00000000000000000000';
  BEGIN
    INSERT INTO relationship_edges (id, source_id, target_id, predicate)
    VALUES ('01REL_RLS_A0000000000000000', '01ENT_PUB000000000000000000', '01ENT_BOB000000000000000000', 'cites');
    ok := true;
  EXCEPTION WHEN OTHERS THEN ok := false; END;
  RESET ROLE;

  IF ok THEN PERFORM test_pass('12a_owner_creates_edge');
  ELSE PERFORM test_fail('12a_owner_creates_edge', 'Owner could not create edge'); END IF;

  DELETE FROM entities WHERE id = '01REL_RLS_A0000000000000000';
END $$;

-- 12b. Editor of source can create edge
DO $$
DECLARE ok BOOLEAN;
BEGIN
  -- Bob has edit grant on Alice's public entity
  INSERT INTO entities (id, kind, type, properties, owner_id, edited_by, created_at, updated_at)
  VALUES ('01REL_RLS_B0000000000000000', 'relationship', 'relationship', '{}', '01BOB0000000000000000000000', '01BOB0000000000000000000000', NOW(), NOW());

  SET LOCAL ROLE app_user;
  SET LOCAL app.actor_id = '01BOB0000000000000000000000';
  BEGIN
    INSERT INTO relationship_edges (id, source_id, target_id, predicate)
    VALUES ('01REL_RLS_B0000000000000000', '01ENT_PUB000000000000000000', '01ENT_BOB000000000000000000', 'references');
    ok := true;
  EXCEPTION WHEN OTHERS THEN ok := false; END;
  RESET ROLE;

  IF ok THEN PERFORM test_pass('12b_editor_creates_edge');
  ELSE PERFORM test_fail('12b_editor_creates_edge', 'Editor could not create edge'); END IF;

  DELETE FROM entities WHERE id = '01REL_RLS_B0000000000000000';
END $$;

-- 12c. Stranger cannot create edge (Carol has no edit on Bob's entity)
DO $$
DECLARE ok BOOLEAN;
BEGIN
  INSERT INTO entities (id, kind, type, properties, owner_id, edited_by, created_at, updated_at)
  VALUES ('01REL_RLS_C0000000000000000', 'relationship', 'relationship', '{}', '01CAROL00000000000000000000', '01CAROL00000000000000000000', NOW(), NOW());

  SET LOCAL ROLE app_user;
  SET LOCAL app.actor_id = '01CAROL00000000000000000000';
  BEGIN
    INSERT INTO relationship_edges (id, source_id, target_id, predicate)
    VALUES ('01REL_RLS_C0000000000000000', '01ENT_BOB000000000000000000', '01ENT_PUB000000000000000000', 'cites');
    ok := true;
  EXCEPTION WHEN OTHERS THEN ok := false; END;
  RESET ROLE;

  DELETE FROM entities WHERE id = '01REL_RLS_C0000000000000000';

  IF NOT ok THEN PERFORM test_pass('12c_stranger_cant_create_edge');
  ELSE PERFORM test_fail('12c_stranger_cant_create_edge', 'Stranger created edge'); END IF;
END $$;

-- 12d. Can see edge if relationship entity is public
DO $$
DECLARE cnt INT;
BEGIN
  -- Create a public relationship entity + edge
  INSERT INTO entities (id, kind, type, properties, owner_id, view_access, edited_by, created_at, updated_at)
  VALUES ('01REL_RLS_D0000000000000000', 'relationship', 'relationship', '{}', '01ALICE00000000000000000000', 'public', '01ALICE00000000000000000000', NOW(), NOW());
  INSERT INTO relationship_edges (id, source_id, target_id, predicate)
  VALUES ('01REL_RLS_D0000000000000000', '01ENT_PUB000000000000000000', '01ENT_BOB000000000000000000', 'cites');

  SET LOCAL ROLE app_user;
  SET LOCAL app.actor_id = '01CAROL00000000000000000000';
  SELECT COUNT(*) INTO cnt FROM relationship_edges WHERE id = '01REL_RLS_D0000000000000000';
  RESET ROLE;

  DELETE FROM entities WHERE id = '01REL_RLS_D0000000000000000';

  IF cnt = 1 THEN PERFORM test_pass('12d_public_edge_visible');
  ELSE PERFORM test_fail('12d_public_edge_visible', format('cnt=%s', cnt)); END IF;
END $$;

-- 12e. Edge delete requires edit on source (Carol has no edit on Bob's entity)
DO $$
DECLARE cnt INT;
BEGIN
  INSERT INTO entities (id, kind, type, properties, owner_id, view_access, edited_by, created_at, updated_at)
  VALUES ('01REL_RLS_E0000000000000000', 'relationship', 'relationship', '{}', '01BOB0000000000000000000000', 'public', '01BOB0000000000000000000000', NOW(), NOW());
  INSERT INTO relationship_edges (id, source_id, target_id, predicate)
  VALUES ('01REL_RLS_E0000000000000000', '01ENT_BOB000000000000000000', '01ENT_PUB000000000000000000', 'cites');

  -- Carol (no edit on Bob's entity) tries to delete
  SET LOCAL ROLE app_user;
  SET LOCAL app.actor_id = '01CAROL00000000000000000000';
  DELETE FROM relationship_edges WHERE id = '01REL_RLS_E0000000000000000';
  GET DIAGNOSTICS cnt = ROW_COUNT;
  RESET ROLE;

  DELETE FROM entities WHERE id = '01REL_RLS_E0000000000000000';

  IF cnt = 0 THEN PERFORM test_pass('12e_stranger_cant_delete_edge');
  ELSE PERFORM test_fail('12e_stranger_cant_delete_edge', 'Stranger deleted edge'); END IF;
END $$;

-- =============================================================================
-- 13. RLS: Entity Versions
-- =============================================================================

-- Seed a version
INSERT INTO entity_versions (entity_id, ver, properties, edited_by, created_at)
VALUES ('01ENT_PUB000000000000000000', 1, '{"label": "Public Book"}', '01ALICE00000000000000000000', NOW());
INSERT INTO entity_versions (entity_id, ver, properties, edited_by, created_at)
VALUES ('01ENT_PRIV00000000000000000', 1, '{"label": "Private Book"}', '01ALICE00000000000000000000', NOW());

-- 13a. Can see versions of public entity
DO $$
DECLARE cnt INT;
BEGIN
  SET LOCAL ROLE app_user;
  SET LOCAL app.actor_id = '';
  SELECT COUNT(*) INTO cnt FROM entity_versions WHERE entity_id = '01ENT_PUB000000000000000000';
  RESET ROLE;
  IF cnt > 0 THEN PERFORM test_pass('13a_public_versions_visible');
  ELSE PERFORM test_fail('13a_public_versions_visible', 'Cannot see public versions'); END IF;
END $$;

-- 13b. Cannot see versions of private entity (no grant)
DO $$
DECLARE cnt INT;
BEGIN
  SET LOCAL ROLE app_user;
  SET LOCAL app.actor_id = '01BOB0000000000000000000000';
  SELECT COUNT(*) INTO cnt FROM entity_versions WHERE entity_id = '01ENT_PRIV00000000000000000';
  RESET ROLE;
  IF cnt = 0 THEN PERFORM test_pass('13b_private_versions_hidden');
  ELSE PERFORM test_fail('13b_private_versions_hidden', format('cnt=%s', cnt)); END IF;
END $$;

-- 13c. Insert is open
DO $$
DECLARE ok BOOLEAN;
BEGIN
  SET LOCAL ROLE app_user;
  SET LOCAL app.actor_id = '01BOB0000000000000000000000';
  BEGIN
    INSERT INTO entity_versions (entity_id, ver, properties, edited_by, created_at)
    VALUES ('01ENT_PUB000000000000000000', 2, '{"label": "v2"}', '01BOB0000000000000000000000', NOW());
    ok := true;
  EXCEPTION WHEN OTHERS THEN ok := false; END;
  RESET ROLE;
  IF ok THEN PERFORM test_pass('13c_version_insert_open');
  ELSE PERFORM test_fail('13c_version_insert_open', 'Could not insert version'); END IF;
END $$;

-- =============================================================================
-- 14. RLS: Entity Activity
-- =============================================================================

-- 14a. Anyone can read activity
DO $$
DECLARE cnt INT;
BEGIN
  INSERT INTO entity_activity (entity_id, actor_id, action) VALUES ('01ENT_PUB000000000000000000', '01ALICE00000000000000000000', 'entity_created');
  SET LOCAL ROLE app_user;
  SET LOCAL app.actor_id = '';
  SELECT COUNT(*) INTO cnt FROM entity_activity;
  RESET ROLE;
  IF cnt > 0 THEN PERFORM test_pass('14a_activity_readable');
  ELSE PERFORM test_fail('14a_activity_readable', 'Cannot read activity'); END IF;
END $$;

-- 14b. Anyone can insert activity
DO $$
DECLARE ok BOOLEAN;
BEGIN
  SET LOCAL ROLE app_user;
  SET LOCAL app.actor_id = '01BOB0000000000000000000000';
  BEGIN
    INSERT INTO entity_activity (entity_id, actor_id, action) VALUES ('01ENT_BOB000000000000000000', '01BOB0000000000000000000000', 'content_updated');
    ok := true;
  EXCEPTION WHEN OTHERS THEN ok := false; END;
  RESET ROLE;
  IF ok THEN PERFORM test_pass('14b_activity_insertable');
  ELSE PERFORM test_fail('14b_activity_insertable', 'Cannot insert activity'); END IF;
END $$;

-- =============================================================================
-- 15. RLS: API Keys
-- =============================================================================

-- Seed API keys
INSERT INTO api_keys (id, key_prefix, key_hash, actor_id, label)
VALUES ('key_alice', 'ak_alice', 'hash_alice', '01ALICE00000000000000000000', 'Alice key');
INSERT INTO api_keys (id, key_prefix, key_hash, actor_id, label)
VALUES ('key_bob', 'ak_bob00', 'hash_bob', '01BOB0000000000000000000000', 'Bob key');

-- 15a. Can only see own keys
DO $$
DECLARE cnt INT;
BEGIN
  SET LOCAL ROLE app_user;
  SET LOCAL app.actor_id = '01ALICE00000000000000000000';
  SELECT COUNT(*) INTO cnt FROM api_keys;
  RESET ROLE;
  IF cnt = 1 THEN PERFORM test_pass('15a_see_own_keys_only');
  ELSE PERFORM test_fail('15a_see_own_keys_only', format('cnt=%s (expected 1)', cnt)); END IF;
END $$;

-- 15b. Cannot insert key for another actor
DO $$
DECLARE ok BOOLEAN;
BEGIN
  SET LOCAL ROLE app_user;
  SET LOCAL app.actor_id = '01ALICE00000000000000000000';
  BEGIN
    INSERT INTO api_keys (id, key_prefix, key_hash, actor_id) VALUES ('key_fake', 'ak_fake', 'hash_fake', '01BOB0000000000000000000000');
    ok := true;
  EXCEPTION WHEN OTHERS THEN ok := false; END;
  RESET ROLE;
  DELETE FROM api_keys WHERE id = 'key_fake';
  IF NOT ok THEN PERFORM test_pass('15b_cant_insert_others_key');
  ELSE PERFORM test_fail('15b_cant_insert_others_key', 'Inserted key for another actor'); END IF;
END $$;

-- 15c. Can only update own keys
DO $$
DECLARE cnt INT;
BEGIN
  SET LOCAL ROLE app_user;
  SET LOCAL app.actor_id = '01ALICE00000000000000000000';
  UPDATE api_keys SET revoked_at = NOW() WHERE id = 'key_bob';
  GET DIAGNOSTICS cnt = ROW_COUNT;
  RESET ROLE;
  IF cnt = 0 THEN PERFORM test_pass('15c_cant_update_others_key');
  ELSE PERFORM test_fail('15c_cant_update_others_key', 'Updated another actors key'); END IF;
END $$;

-- =============================================================================
-- 16. RLS: Agent Keys
-- =============================================================================

-- Seed agent key
INSERT INTO agent_keys (entity_id, public_key) VALUES ('01ALICE00000000000000000000', 'base64pubkey_alice');

-- 16a. Anyone can read agent keys
DO $$
DECLARE cnt INT;
BEGIN
  SET LOCAL ROLE app_user;
  SET LOCAL app.actor_id = '01BOB0000000000000000000000';
  SELECT COUNT(*) INTO cnt FROM agent_keys;
  RESET ROLE;
  IF cnt > 0 THEN PERFORM test_pass('16a_agent_keys_public_read');
  ELSE PERFORM test_fail('16a_agent_keys_public_read', 'Cannot read agent keys'); END IF;
END $$;

-- =============================================================================
-- 17. Edge Cases
-- =============================================================================

-- 17a. Duplicate PK rejected
DO $$ BEGIN
  BEGIN
    INSERT INTO entities (id, kind, type, properties, owner_id, edited_by, created_at, updated_at)
    VALUES ('01ALICE00000000000000000000', 'entity', 'book', '{}', 'x', 'x', NOW(), NOW());
    PERFORM test_fail('17a_duplicate_pk', 'Accepted duplicate PK');
  EXCEPTION WHEN unique_violation THEN
    PERFORM test_pass('17a_duplicate_pk');
  END;
END $$;

-- 17b. Duplicate access grant rejected
DO $$ BEGIN
  BEGIN
    INSERT INTO entity_access (entity_id, actor_id, access_type)
    VALUES ('01ENT_PUB000000000000000000', '01BOB0000000000000000000000', 'edit');
    PERFORM test_fail('17b_duplicate_grant', 'Accepted duplicate grant');
  EXCEPTION WHEN unique_violation THEN
    PERFORM test_pass('17b_duplicate_grant');
  END;
END $$;

-- 17c. Multiple access types for same actor
DO $$ BEGIN
  -- Bob already has 'edit' and 'admin'. Add 'view'.
  INSERT INTO entity_access (entity_id, actor_id, access_type)
  VALUES ('01ENT_PUB000000000000000000', '01BOB0000000000000000000000', 'view');
  PERFORM test_pass('17c_multiple_access_types');
EXCEPTION WHEN OTHERS THEN
  PERFORM test_fail('17c_multiple_access_types', SQLERRM);
END $$;

-- 17d. Large JSONB properties
DO $$ BEGIN
  INSERT INTO entities (id, kind, type, properties, owner_id, edited_by, created_at, updated_at)
  VALUES ('01LARGE_JSON0000000000000000', 'entity', 'book',
    (SELECT jsonb_build_object('data', repeat('x', 100000))),
    '01ALICE00000000000000000000', '01ALICE00000000000000000000', NOW(), NOW());
  PERFORM test_pass('17d_large_jsonb');
  DELETE FROM entities WHERE id = '01LARGE_JSON0000000000000000';
EXCEPTION WHEN OTHERS THEN
  PERFORM test_fail('17d_large_jsonb', SQLERRM);
END $$;

-- =============================================================================
-- Results
-- =============================================================================

\echo ''
\echo '==========================================='
\echo '  SCHEMA TEST RESULTS'
\echo '==========================================='
\echo ''

\pset format aligned
\pset tuples_only off

SELECT
  CASE WHEN passed THEN '  PASS' ELSE '  FAIL' END AS status,
  name,
  COALESCE(detail, '') AS detail
FROM test_results
ORDER BY
  -- Sort by category number, then name
  (regexp_replace(name, '^(\d+)[a-z]_.*', '\1'))::int,
  name;

\echo ''

SELECT
  format('%s/%s passed', COUNT(*) FILTER (WHERE passed), COUNT(*)) AS summary,
  CASE WHEN COUNT(*) FILTER (WHERE NOT passed) = 0
    THEN 'ALL TESTS PASSED'
    ELSE format('%s FAILED', COUNT(*) FILTER (WHERE NOT passed))
  END AS result
FROM test_results;

-- =============================================================================
-- Cleanup
-- =============================================================================

DELETE FROM entity_activity;
DELETE FROM entity_versions;
DELETE FROM relationship_edges;
DELETE FROM entity_access;
DELETE FROM api_keys;
DELETE FROM agent_keys;
DELETE FROM entities;

DROP FUNCTION test_pass(TEXT);
DROP FUNCTION test_fail(TEXT, TEXT);
