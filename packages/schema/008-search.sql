-- =============================================================================
-- Text Search (pg_trgm)
-- =============================================================================
--
-- Trigram-based text search for substring matching, multi-keyword search,
-- and regex patterns on entity properties. This is the MVP search —
-- simple, fast, no external dependencies.
--
-- pg_trgm breaks text into 3-character subsequences and indexes them,
-- enabling efficient ILIKE and regex (~) queries via GIN index.
--
-- Covers all entity kinds (commons, entity, relationship, user, agent)
-- since they share the entities table.
--
-- Usage:
--   ILIKE:  WHERE properties::text ILIKE '%neural%'
--   Regex:  WHERE properties::text ~ 'neuro(science|logy)'
--
-- The GIN index accelerates both patterns. Without it, these queries
-- would require full sequential scans.
--
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Trigram index on the text representation of properties JSONB.
-- This indexes the entire JSON structure as text, so searches match
-- against property keys AND values. Scoping by commons_id, kind, or
-- type via WHERE clauses narrows the scan before trigram matching.
CREATE INDEX idx_entities_props_trgm
  ON entities USING GIN ((properties::text) gin_trgm_ops);
