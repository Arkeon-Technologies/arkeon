-- =============================================================================
-- Database Roles, Extensions & Helper Functions
-- =============================================================================
--
-- Sets up the non-superuser application role (arke_app) that all API
-- requests run as. RLS policies are enforced on this role.
--
-- The migration itself runs as the database owner (superuser or equivalent).
-- The arke_app role gets CRUD on all tables but is subject to RLS.
--
-- =============================================================================

-- Create the application role (idempotent)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'arke_app') THEN
    CREATE ROLE arke_app LOGIN PASSWORD 'arke';
  END IF;
END $$;

-- Schema access
GRANT USAGE ON SCHEMA public TO arke_app;

-- Extensions
-- pg_trgm removed: search is now handled by Meilisearch sidecar

-- =============================================================================
-- Session Context Helper Functions
-- =============================================================================
--
-- Middleware sets these per request via SET LOCAL:
--   app.actor_id         — the authenticated actor's ID
--   app.actor_read_level — actor's max_read_level (integer)
--   app.actor_write_level — actor's max_write_level (integer)
--   app.actor_is_admin   — actor's is_admin flag (boolean)
--
-- These helper functions provide safe defaults when context is not set
-- (e.g., unauthenticated requests for PUBLIC content).
--
-- =============================================================================

CREATE OR REPLACE FUNCTION current_actor_id() RETURNS TEXT AS $$
  SELECT COALESCE(NULLIF(current_setting('app.actor_id', true), ''), NULL);
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION current_actor_read_level() RETURNS INT AS $$
  SELECT COALESCE(NULLIF(current_setting('app.actor_read_level', true), '')::int, -1);
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION current_actor_write_level() RETURNS INT AS $$
  SELECT COALESCE(NULLIF(current_setting('app.actor_write_level', true), '')::int, -1);
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION current_actor_is_admin() RETURNS BOOLEAN AS $$
  SELECT COALESCE(NULLIF(current_setting('app.actor_is_admin', true), '')::boolean, false);
$$ LANGUAGE sql STABLE;
