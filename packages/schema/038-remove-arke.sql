-- =============================================================================
-- 038-remove-arke.sql
-- =============================================================================
--
-- Removes the legacy "arke" (network/multi-tenancy) concept from existing
-- deployments.
--
-- On fresh databases this migration is a no-op (all DROPs use IF EXISTS).
--
-- On databases that ran the pre-removal schema (003-arkes.sql + 019-actor-
-- arke-membership.sql), this drops:
--   - Foreign key columns: entities.arke_id, spaces.arke_id, groups.arke_id,
--     actors.arke_id (and the earlier network_id aliases)
--   - Associated indexes
--   - Session helper function current_actor_arke_id()
--   - The arkes table itself
--
-- NOTE: The old arke-scoped RLS policies on entities/spaces/groups are
-- replaced by the non-arke versions in 015-rls-policies.sql, which now
-- drops and recreates its policies on every run for idempotency.
--
-- =============================================================================

-- Drop arke_id / network_id columns. CASCADE not needed because no other
-- objects (indexes, constraints) remain that depend on them once the
-- policies from old 019 are gone (015 drops them on re-run).
ALTER TABLE entities DROP COLUMN IF EXISTS arke_id;
ALTER TABLE entities DROP COLUMN IF EXISTS network_id;
ALTER TABLE spaces   DROP COLUMN IF EXISTS arke_id;
ALTER TABLE spaces   DROP COLUMN IF EXISTS network_id;
ALTER TABLE groups   DROP COLUMN IF EXISTS arke_id;
ALTER TABLE groups   DROP COLUMN IF EXISTS network_id;
ALTER TABLE actors   DROP COLUMN IF EXISTS arke_id;

-- Drop associated indexes (column drops already cascade these, but belt
-- and suspenders in case any were created separately)
DROP INDEX IF EXISTS idx_actors_arke_id;
DROP INDEX IF EXISTS idx_entities_arke_id;
DROP INDEX IF EXISTS idx_entities_network;
DROP INDEX IF EXISTS idx_groups_arke_id;
DROP INDEX IF EXISTS idx_groups_network;
DROP INDEX IF EXISTS idx_spaces_arke_id;
DROP INDEX IF EXISTS idx_spaces_network;

-- Drop the session helper function used by old arke-scoped RLS policies
DROP FUNCTION IF EXISTS current_actor_arke_id();

-- Drop the arkes table last (nothing references it after the column drops)
DROP TABLE IF EXISTS arkes;
