-- =============================================================================
-- Comments
-- =============================================================================
--
-- Lightweight discussion attached to entities. Not first-class entities.
-- Single-depth threading (replies to top-level only).
-- Permissions inherited from parent entity's read_level.
--
-- =============================================================================

CREATE TABLE comments (
  id         TEXT PRIMARY KEY,                             -- ULID
  entity_id  TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  author_id  TEXT NOT NULL,                                -- actor ID (no FK, comments survive deactivation)
  body       TEXT NOT NULL,
  parent_id  TEXT REFERENCES comments(id) ON DELETE CASCADE, -- NULL for top-level
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT body_length CHECK (char_length(body) BETWEEN 1 AND 4096)
);

CREATE INDEX IF NOT EXISTS idx_comments_entity ON comments(entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_comments_parent ON comments(parent_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_comments_author ON comments(author_id);

GRANT SELECT, INSERT, DELETE ON comments TO arke_app;
