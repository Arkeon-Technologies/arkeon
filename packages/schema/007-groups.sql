-- =============================================================================
-- Groups & Memberships
-- =============================================================================
--
-- Flat actor groups. No hierarchy (no parent_group_id). Groups are referenced
-- in entity_permissions and space_permissions to grant roles to multiple
-- actors at once.
--
-- Group type is informational, not permission-bearing:
--   org       — organizational unit
--   project   — project team
--   editorial — editorial board
--   admin     — administrative group
--
-- =============================================================================

CREATE TABLE groups (
  id         TEXT PRIMARY KEY,                             -- ULID
  name       TEXT NOT NULL,
  type       TEXT NOT NULL DEFAULT 'project',
  network_id TEXT NOT NULL REFERENCES arkes(id),            -- which Arke this group belongs to
  read_level INT NOT NULL DEFAULT 1,                       -- min clearance to see this group
  created_by TEXT NOT NULL REFERENCES actors(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT valid_group_type CHECK (type IN ('org', 'project', 'editorial', 'admin'))
);

CREATE INDEX idx_groups_network ON groups (network_id);
CREATE INDEX idx_groups_read_level ON groups (read_level);

CREATE TABLE group_memberships (
  actor_id      TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  group_id      TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  role_in_group TEXT NOT NULL DEFAULT 'member',            -- member | admin
  PRIMARY KEY (actor_id, group_id),

  CONSTRAINT valid_group_role CHECK (role_in_group IN ('member', 'admin'))
);

CREATE INDEX idx_group_memberships_group ON group_memberships (group_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON groups TO arke_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON group_memberships TO arke_app;
