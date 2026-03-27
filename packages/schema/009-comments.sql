-- =============================================================================
-- Comments
-- =============================================================================
--
-- Lightweight discussion attached to any entity. Not first-class entities —
-- no versioning, no permissions beyond the parent entity's view access.
--
-- Single-depth threading: replies to top-level comments only.
--
-- =============================================================================

CREATE TABLE comments (
  id TEXT PRIMARY KEY,                    -- ULID
  entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL,                -- actor who wrote the comment
  body TEXT NOT NULL,                     -- plaintext or markdown (1-4096 chars)
  parent_id TEXT REFERENCES comments(id) ON DELETE CASCADE,  -- null = top-level
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT body_length CHECK (char_length(body) BETWEEN 1 AND 4096)
);

-- List comments on an entity (newest first for top-level)
CREATE INDEX idx_comments_entity ON comments(entity_id, created_at DESC);

-- Fetch replies for a parent comment (oldest first)
CREATE INDEX idx_comments_parent ON comments(parent_id, created_at ASC);

-- Actor's comments (for cleanup, moderation)
CREATE INDEX idx_comments_author ON comments(author_id);

-- RLS: anyone who can view the entity can read comments
ALTER TABLE comments ENABLE ROW LEVEL SECURITY;

CREATE POLICY comments_select ON comments
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM entities e
      WHERE e.id = comments.entity_id
      -- RLS on entities table handles view access check
    )
  );

-- Insert: any authenticated actor (view access checked in application layer
-- since RLS can't easily cross-check entity view permissions on INSERT)
CREATE POLICY comments_insert ON comments
  FOR INSERT WITH CHECK (author_id = current_setting('app.actor_id', true));

-- Delete: author, entity owner, or entity admin (checked in application layer)
CREATE POLICY comments_delete ON comments
  FOR DELETE USING (
    author_id = current_setting('app.actor_id', true)
    OR EXISTS (
      SELECT 1 FROM entities e
      WHERE e.id = comments.entity_id
      AND e.owner_id = current_setting('app.actor_id', true)
    )
    OR EXISTS (
      SELECT 1 FROM entity_access ea
      WHERE ea.entity_id = comments.entity_id
      AND ea.actor_id = current_setting('app.actor_id', true)
      AND ea.access_type = 'admin'
    )
  );
