-- =============================================================================
-- Entity Access v2: Add group_id and rule_id columns
-- =============================================================================
-- Extends entity_access to support group-based grants (from permission rules)
-- alongside the existing individual actor grants.
--
-- Data safety: all existing rows have actor_id set, group_id=NULL.
-- num_nonnulls(actor_id, NULL) = 1, so the grantee_check constraint passes.
-- =============================================================================

-- Drop old primary key FIRST (actor_id is in PK, can't make nullable otherwise)
ALTER TABLE entity_access DROP CONSTRAINT IF EXISTS entity_access_pkey;

-- Add new columns (nullable)
ALTER TABLE entity_access ADD COLUMN IF NOT EXISTS group_id TEXT
  REFERENCES groups(id) ON DELETE CASCADE;

ALTER TABLE entity_access ADD COLUMN IF NOT EXISTS rule_id TEXT;
-- FK to permission_rules added in 015 after that table exists

-- Make actor_id nullable (was NOT NULL)
ALTER TABLE entity_access ALTER COLUMN actor_id DROP NOT NULL;

-- Exactly one of actor_id or group_id must be set
DO $$ BEGIN
  ALTER TABLE entity_access ADD CONSTRAINT grantee_check
    CHECK (num_nonnulls(actor_id, group_id) = 1);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Admin grants are always individual (never from rules/groups)
DO $$ BEGIN
  ALTER TABLE entity_access ADD CONSTRAINT admin_individual_only
    CHECK (access_type != 'admin' OR (actor_id IS NOT NULL AND rule_id IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Unique constraints replacing old PK
CREATE UNIQUE INDEX IF NOT EXISTS uq_entity_access_actor
  ON entity_access(entity_id, actor_id, access_type)
  WHERE actor_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_entity_access_group
  ON entity_access(entity_id, group_id, access_type)
  WHERE group_id IS NOT NULL;

-- Performance indexes
CREATE INDEX IF NOT EXISTS idx_entity_access_group_partial
  ON entity_access(entity_id, group_id, access_type)
  WHERE group_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_entity_access_rule
  ON entity_access(rule_id)
  WHERE rule_id IS NOT NULL;
