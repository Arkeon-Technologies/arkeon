-- =============================================================================
-- Relationship Edges
-- =============================================================================
--
-- Every relationship is an entity (kind = 'relationship') with its own
-- properties, versioning, classification, and permissions. This table adds
-- the graph structure: source → [predicate] → target.
--
-- The relationship entity's read_level governs visibility of the edge.
-- Default read_level for a relationship should be
-- max(source.read_level, target.read_level) — the inference attack defense.
--
-- Creating a relationship requires:
--   1. Edit access on source entity (you're asserting a connection from it)
--   2. Read access on target entity (can't link to what you can't see)
--
-- =============================================================================

CREATE TABLE relationship_edges (
  id         TEXT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
  source_id  TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  target_id  TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  predicate  TEXT NOT NULL                                 -- cites, contains, references, etc.
);

CREATE INDEX IF NOT EXISTS idx_edges_source ON relationship_edges(source_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON relationship_edges(target_id);
CREATE INDEX IF NOT EXISTS idx_edges_source_target ON relationship_edges(source_id, target_id);
CREATE INDEX IF NOT EXISTS idx_edges_source_predicate ON relationship_edges(source_id, predicate);
CREATE INDEX IF NOT EXISTS idx_edges_target_predicate ON relationship_edges(target_id, predicate);

GRANT SELECT, INSERT, UPDATE, DELETE ON relationship_edges TO arke_app;
