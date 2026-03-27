-- =============================================================================
-- Entity Versions Table
-- =============================================================================
--
-- Content snapshots. Every time an entity's properties change (ver increments),
-- the properties at that version are stored here. This is NOT a full manifest
-- blob — just the properties, since relationships and permissions have their
-- own tracking (entity_activity).
--
-- Used for:
--   - Version history browsing ("show me version 3 of this work")
--   - Diffing between versions ("what changed?")
--   - Rollback context
--
-- To reconstruct full state at version N:
--   - Properties: from this table
--   - Relationships: query entity_activity for relationship events before version N's timestamp
--   - Permissions: query entity_activity for access events before version N's timestamp
--
-- =============================================================================

CREATE TABLE entity_versions (
  entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  ver INTEGER NOT NULL,
  properties JSONB NOT NULL,                        -- properties at this version
  edited_by TEXT NOT NULL,                          -- who made this version
  note TEXT,                                        -- version note
  created_at TIMESTAMPTZ NOT NULL,

  PRIMARY KEY (entity_id, ver)
);

-- Version history for an entity (newest first)
CREATE INDEX idx_versions_entity_desc ON entity_versions(entity_id, ver DESC);

-- =============================================================================
-- Usage
-- =============================================================================
--
-- On every content update (ver increment), snapshot the properties:
--
--   INSERT INTO entity_versions (entity_id, ver, properties, edited_by, note, created_at)
--   VALUES ($entity_id, $new_ver, $properties, $actor_id, $note, NOW());
--
-- Version history:
--   SELECT ver, edited_by, note, created_at
--   FROM entity_versions
--   WHERE entity_id = $id
--   ORDER BY ver DESC;
--
-- Get specific version:
--   SELECT * FROM entity_versions
--   WHERE entity_id = $id AND ver = $ver;
--
-- Diff between versions:
--   SELECT v1.properties as before, v2.properties as after
--   FROM entity_versions v1, entity_versions v2
--   WHERE v1.entity_id = $id AND v1.ver = $ver1
--     AND v2.entity_id = $id AND v2.ver = $ver2;
--
-- =============================================================================

-- =============================================================================
-- Endpoints
-- =============================================================================
--
-- List versions:
--   GET /entities/:id/versions
--   → [{ ver: 3, edited_by: "01ALICE...", note: "...", created_at: "..." }, ...]
--
-- Get specific version:
--   GET /entities/:id/versions/:ver
--   → { ver: 3, properties: { ... }, edited_by: "...", note: "..." }
--
-- =============================================================================
