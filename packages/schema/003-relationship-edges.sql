-- =============================================================================
-- Relationship Edges Table
-- =============================================================================
--
-- The graph structure. Every relationship in the system is an entity
-- (kind='relationship') with an entry in this table that records its
-- source, target, and predicate.
--
-- A relationship entity has:
--   - kind = 'relationship'
--   - type = 'relationship' (fixed — the predicate lives on the edge, not here)
--   - properties = relationship metadata (source_text, context, weight, etc.)
--   - ver = versioned like any entity
--   - owner_id/permissions = owned by whoever created it
--
-- The predicate (cites, contains, references, etc.) lives on the EDGE,
-- not the entity. This keeps graph queries fast — filter on the edge table
-- without joining entities.
--
-- This table adds the graph edges: source_id --[predicate]--> target_id.
-- It's a thin structural index on top of the entities table.
--
-- Relationships are OPEN by default — anyone can create one.
-- No permission check on the target. "My work cites your work" doesn't
-- need your permission. Only requires edit access on the source entity.
--
-- All entity-to-entity structure lives here — including containment
-- (e.g., "contains", "part_of"). No separate parent_id hierarchy.
--
-- WHY RELATIONSHIPS ARE ENTITIES:
--
-- In a knowledge graph, the connection between two things is often as
-- important as the things themselves. A citation has source text, context,
-- provenance. An annotation has content, a description. These deserve:
--   - Versioning (the citation description can be updated)
--   - Permissions (who can edit this citation's metadata?)
--   - Properties (rich JSONB content)
--
-- =============================================================================

CREATE TABLE relationship_edges (
  id TEXT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  predicate TEXT NOT NULL                    -- cites, contains, references, inspired_by, etc.

  -- A source can have multiple relationships to the same target,
  -- even with the same predicate (e.g., two "cites" with different
  -- citation contexts). No UNIQUE constraint — the PK is sufficient.
);

-- =============================================================================
-- Indexes
-- =============================================================================

-- "All relationships FROM entity X" (outgoing edges)
CREATE INDEX idx_edges_source ON relationship_edges(source_id);

-- "All relationships TO entity X" (incoming edges — reverse lookup)
CREATE INDEX idx_edges_target ON relationship_edges(target_id);

-- "All relationships FROM X TO Y" (check if two entities are connected)
CREATE INDEX idx_edges_source_target ON relationship_edges(source_id, target_id);

-- "All edges with a given predicate FROM X" (e.g., all citations from a work)
CREATE INDEX idx_edges_source_predicate ON relationship_edges(source_id, predicate);

-- "All edges with a given predicate TO X" (e.g., who cites this work?)
CREATE INDEX idx_edges_target_predicate ON relationship_edges(target_id, predicate);

-- =============================================================================
-- Creating a Relationship
-- =============================================================================
--
-- 1. Create the relationship entity:
--    INSERT INTO entities (id, kind, type, properties, owner_id, ...)
--    VALUES ($rel_id, 'relationship', 'relationship',
--            '{"source_text": "As shown by...", "context": "Introduction"}',
--            $actor_id, ...);
--
-- 2. Create the edge:
--    INSERT INTO relationship_edges (id, source_id, target_id, predicate)
--    VALUES ($rel_id, $my_work_id, $their_work_id, 'cites');
--
-- Permission: actor must have edit access on the SOURCE entity (they're
-- modifying its outgoing connections). No check on the target.
--
-- =============================================================================

-- =============================================================================
-- Query Patterns
-- =============================================================================
--
-- All citations from a work (with metadata):
--   SELECT rel.properties as citation_context,
--          target.properties->>'label' as cited_work_label,
--          target.type as cited_work_type
--   FROM relationship_edges re
--   JOIN entities rel ON re.id = rel.id             -- relationship entity
--   JOIN entities target ON re.target_id = target.id -- cited entity
--   WHERE re.source_id = $work_id AND re.predicate = 'cites';
--
-- Reverse lookup: "Who cites this work?":
--   SELECT source.properties->>'label' as citing_work,
--          rel.properties as citation_context
--   FROM relationship_edges re
--   JOIN entities rel ON re.id = rel.id
--   JOIN entities source ON re.source_id = source.id
--   WHERE re.target_id = $work_id AND re.predicate = 'cites';
--
-- 2-hop traversal: "What do my citations cite?":
--   SELECT DISTINCT e.id, e.type, e.properties->>'label'
--   FROM relationship_edges re1
--   JOIN relationship_edges re2 ON re1.target_id = re2.source_id
--   JOIN entities e ON re2.target_id = e.id
--   WHERE re1.source_id = $id
--     AND re1.predicate = 'cites' AND re2.predicate = 'cites';
--
-- Recursive traversal (variable depth):
--   WITH RECURSIVE traversal AS (
--     SELECT re.target_id, 1 as depth
--     FROM relationship_edges re
--     WHERE re.source_id = $start_id AND re.predicate = $predicate
--     UNION ALL
--     SELECT re.target_id, t.depth + 1
--     FROM relationship_edges re
--     JOIN traversal t ON re.source_id = t.target_id
--     WHERE re.predicate = $predicate AND t.depth < $max_depth
--   )
--   SELECT DISTINCT e.* FROM traversal t
--   JOIN entities e ON t.target_id = e.id;
--
-- =============================================================================

-- =============================================================================
-- Endpoints
-- =============================================================================
--
-- List outgoing:
--   GET /entities/:id/relationships
--   GET /entities/:id/relationships?predicate=cites
--
-- List incoming (reverse lookup):
--   GET /entities/:id/relationships?direction=in
--   GET /entities/:id/relationships?direction=in&predicate=cites
--
-- Create (requires edit on source entity):
--   POST /entities/:id/relationships
--   {
--     "predicate": "cites",
--     "target_id": "01TARGET...",
--     "properties": { "source_text": "As shown by...", "context": "Introduction" }
--   }
--
-- Update relationship metadata (requires edit on the relationship entity):
--   PUT /relationships/:rel_id
--   { "properties": { "source_text": "Updated context..." }, "ver": 2 }
--
-- Delete (requires edit on source entity):
--   DELETE /relationships/:rel_id
--
-- =============================================================================
