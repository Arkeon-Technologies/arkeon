-- =============================================================================
-- Text Search (pg_trgm)
-- =============================================================================
--
-- Trigram index on entity properties for ILIKE and regex pattern matching.
-- pg_trgm extension is created in 001-roles.sql.
--
-- =============================================================================

CREATE INDEX idx_entities_props_trgm ON entities
USING GIN ((properties::text) gin_trgm_ops);
