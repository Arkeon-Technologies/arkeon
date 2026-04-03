-- =============================================================================
-- Core Entities Table (v2)
-- =============================================================================
--
-- Entities are the nodes of the knowledge graph. Relationships are also
-- entities (kind = 'relationship') with additional edge data in
-- relationship_edges.
--
-- Key differences from v1:
--   - kind is only 'entity' or 'relationship' (actors and spaces are separate)
--   - owner_id and edited_by reference actors(id), not self
--   - read_level/write_level replace view_access/edit_access/contribute_access
--   - No commons_id (replaced by space_entities join table)
--
-- Read access is governed by classification:
--   read_level = 0 (PUBLIC) → anyone can read, even unauthenticated
--   read_level = N → actor.max_read_level >= N required
--
-- Write access is governed by ACL (at app layer):
--   write_level = ceiling (actor.max_write_level must be >= write_level)
--   PLUS actor must be owner, editor, or admin via entity_permissions
--
-- =============================================================================

CREATE TABLE entities (
  -- Identity
  id         TEXT PRIMARY KEY,                              -- ULID
  kind       TEXT NOT NULL,                                 -- 'entity' | 'relationship'
  type       TEXT NOT NULL,                                 -- semantic: book, chapter, person, etc.

  -- Network membership — every entity belongs to an Arke
  network_id TEXT NOT NULL REFERENCES arkes(id),

  -- Version chain (content versions only)
  ver        INTEGER NOT NULL DEFAULT 1,                    -- monotonically increasing

  -- Content
  properties JSONB NOT NULL DEFAULT '{}',                   -- type-specific data

  -- Ownership (references actors, not self)
  owner_id   TEXT NOT NULL REFERENCES actors(id),

  -- Classification levels
  read_level  INT NOT NULL DEFAULT 1,                      -- min clearance to read
  write_level INT NOT NULL DEFAULT 1,                      -- min clearance ceiling for writes

  -- Audit
  edited_by  TEXT NOT NULL REFERENCES actors(id),           -- actor who made latest content edit
  note       TEXT,                                          -- optional version note

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL,                         -- immutable
  updated_at TIMESTAMPTZ NOT NULL,                         -- bumped on content changes only

  -- Constraints
  CONSTRAINT valid_kind CHECK (kind IN ('entity', 'relationship'))
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_entities_kind ON entities(kind);
CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);
CREATE INDEX IF NOT EXISTS idx_entities_kind_type_updated ON entities(kind, type, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_entities_updated ON entities(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_entities_owner ON entities(owner_id);
CREATE INDEX IF NOT EXISTS idx_entities_edited_by ON entities(edited_by, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_entities_network ON entities(network_id);
CREATE INDEX IF NOT EXISTS idx_entities_read_level ON entities(read_level);

-- Grant table access to app role
GRANT SELECT, INSERT, UPDATE, DELETE ON entities TO arke_app;

-- =============================================================================
-- Existence check that bypasses RLS (for 403 vs 404 distinction)
-- =============================================================================

CREATE OR REPLACE FUNCTION entity_exists(eid TEXT) RETURNS BOOLEAN AS $$
  SELECT EXISTS (SELECT 1 FROM entities WHERE id = eid);
$$ LANGUAGE sql STABLE SECURITY DEFINER;
