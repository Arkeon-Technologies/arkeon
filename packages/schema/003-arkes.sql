-- =============================================================================
-- Arkes (Networks)
-- =============================================================================
--
-- An Arke is the top-level container — one network, one knowledge graph.
-- Multiple Arkes can exist in a single database. Every entity and space
-- belongs to exactly one Arke.
--
-- The Arke stores network-wide configuration: default classification levels,
-- contribution policies, and metadata.
--
-- The bootstrap admin creates the first Arke on startup. Additional Arkes
-- can be created by system admins.
--
-- =============================================================================

CREATE TABLE arkes (
  id                  TEXT PRIMARY KEY,                    -- ULID
  name                TEXT NOT NULL,                       -- e.g., "Arkeon Internal", "Personal"
  description         TEXT,
  owner_id            TEXT NOT NULL REFERENCES actors(id), -- network owner (bootstrap admin)
  default_read_level  INT NOT NULL DEFAULT 1,              -- default for new entities/spaces
  default_write_level INT NOT NULL DEFAULT 1,              -- default for new entities/spaces
  properties          JSONB NOT NULL DEFAULT '{}',         -- additional config
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_arkes_owner ON arkes (owner_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON arkes TO arke_app;
