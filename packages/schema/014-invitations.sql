-- =============================================================================
-- Invitation Codes
-- =============================================================================

CREATE TABLE IF NOT EXISTS invitations (
  code             TEXT PRIMARY KEY,
  network_id       TEXT NOT NULL REFERENCES entities(id),
  created_by       TEXT NOT NULL REFERENCES entities(id),
  max_uses         INT NOT NULL DEFAULT 1,
  uses             INT NOT NULL DEFAULT 0,
  assign_groups    TEXT[] NOT NULL DEFAULT '{}',
  expires_at       TIMESTAMPTZ,
  bound_public_key TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_invitations_network ON invitations(network_id);
CREATE INDEX IF NOT EXISTS idx_invitations_created_by ON invitations(created_by);

ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
CREATE POLICY invitations_select ON invitations FOR SELECT USING (true);
CREATE POLICY invitations_insert ON invitations FOR INSERT WITH CHECK (true);
CREATE POLICY invitations_update ON invitations FOR UPDATE USING (true);
CREATE POLICY invitations_delete ON invitations FOR DELETE USING (true);
