-- =============================================================================
-- Groups & Group Hierarchy
-- =============================================================================

CREATE TABLE IF NOT EXISTS groups (
  id              TEXT PRIMARY KEY,
  network_id      TEXT NOT NULL REFERENCES entities(id),
  name            TEXT NOT NULL,
  description     TEXT,
  parent_group_id TEXT REFERENCES groups(id),
  can_invite      BOOLEAN NOT NULL DEFAULT false,
  system_group    BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(network_id, name)
);

CREATE INDEX IF NOT EXISTS idx_groups_network ON groups(network_id);
CREATE INDEX IF NOT EXISTS idx_groups_parent ON groups(parent_group_id);

-- Group memberships (direct only; inherited computed via CTE)
CREATE TABLE IF NOT EXISTS group_memberships (
  group_id    TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  actor_id    TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  granted_by  TEXT NOT NULL REFERENCES entities(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (group_id, actor_id)
);

CREATE INDEX IF NOT EXISTS idx_group_memberships_actor ON group_memberships(actor_id);

-- RLS (permissive — admin enforcement at app level)
ALTER TABLE groups ENABLE ROW LEVEL SECURITY;
CREATE POLICY groups_select ON groups FOR SELECT USING (true);
CREATE POLICY groups_insert ON groups FOR INSERT WITH CHECK (true);
CREATE POLICY groups_update ON groups FOR UPDATE USING (true);
CREATE POLICY groups_delete ON groups FOR DELETE USING (true);

ALTER TABLE group_memberships ENABLE ROW LEVEL SECURITY;
CREATE POLICY memberships_select ON group_memberships FOR SELECT USING (true);
CREATE POLICY memberships_insert ON group_memberships FOR INSERT WITH CHECK (true);
CREATE POLICY memberships_delete ON group_memberships FOR DELETE USING (true);

-- Returns all group IDs an actor belongs to (direct + inherited ancestors).
-- Called once per request in middleware, not per-row in RLS.
CREATE OR REPLACE FUNCTION actor_effective_groups(aid TEXT)
RETURNS TABLE(group_id TEXT) AS $$
  WITH RECURSIVE effective AS (
    SELECT gm.group_id
    FROM group_memberships gm
    WHERE gm.actor_id = aid
    UNION
    SELECT g.parent_group_id
    FROM groups g
    JOIN effective e ON e.group_id = g.id
    WHERE g.parent_group_id IS NOT NULL
  )
  SELECT group_id FROM effective;
$$ LANGUAGE sql STABLE;

-- Returns a group and all its descendant groups (children, grandchildren, etc).
-- Used when materializing permission rules: a grant to tier-1 must also
-- create rows for tier-2, tier-3 (children that inherit).
CREATE OR REPLACE FUNCTION group_with_descendants(gid TEXT)
RETURNS TABLE(group_id TEXT) AS $$
  WITH RECURSIVE descendants AS (
    SELECT gid AS group_id
    UNION
    SELECT g.id
    FROM groups g
    JOIN descendants d ON g.parent_group_id = d.group_id
  )
  SELECT group_id FROM descendants;
$$ LANGUAGE sql STABLE;
