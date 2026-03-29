-- =============================================================================
-- Entity Versions (Content Snapshots)
-- =============================================================================
--
-- Stores the properties at each version. Enables version browsing, diffing,
-- and rollback context. edited_by references actors.
--
-- Append-only — no UPDATE or DELETE on this table.
--
-- =============================================================================

CREATE TABLE entity_versions (
  entity_id  TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  ver        INTEGER NOT NULL,
  properties JSONB NOT NULL,                               -- properties at this version
  edited_by  TEXT NOT NULL,                                -- actor ID (no FK, append-only)
  note       TEXT,
  created_at TIMESTAMPTZ NOT NULL,

  PRIMARY KEY (entity_id, ver)
);

CREATE INDEX idx_versions_entity_desc ON entity_versions(entity_id, ver DESC);

GRANT SELECT, INSERT ON entity_versions TO arke_app;
