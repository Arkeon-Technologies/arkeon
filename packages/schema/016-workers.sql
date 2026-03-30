-- =============================================================================
-- 016: Worker Actor Kind
-- =============================================================================
--
-- Introduces 'worker' as a new actor kind for invokable runtime agents.
-- Migrates any legacy 'user' rows to 'agent' and updates the constraint.
--
-- Note: The canonical CREATE TABLE in 002-actors.sql already reflects the new
-- constraint. This migration handles existing databases.
-- =============================================================================

BEGIN;

-- Set admin context so the actor_update_guard trigger allows kind changes
SELECT set_config('app.actor_id', 'MIGRATION', true);
SELECT set_config('app.actor_is_admin', 'true', true);

-- Migrate legacy 'user' actors to 'agent'
UPDATE actors SET kind = 'agent' WHERE kind = 'user';

-- Update constraint to reflect new valid kinds
ALTER TABLE actors DROP CONSTRAINT IF EXISTS valid_actor_kind;
ALTER TABLE actors ADD CONSTRAINT valid_actor_kind CHECK (kind IN ('agent', 'worker'));

COMMIT;
