-- =============================================================================
-- Permission Rules (Attribute-Based Access Control)
-- =============================================================================
-- Rules define attribute-based access patterns. They are NOT evaluated at
-- read time. When created/deleted, a materializer writes/removes entity_access
-- rows.

CREATE TABLE IF NOT EXISTS permission_rules (
  id              TEXT PRIMARY KEY,
  network_id      TEXT NOT NULL REFERENCES entities(id),
  match_kind      TEXT,
  match_type      TEXT,
  match_commons   TEXT,
  match_property  JSONB,
  grant_group_id  TEXT REFERENCES groups(id) ON DELETE CASCADE,
  grant_access    TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT valid_grant CHECK (grant_access IN ('view', 'edit', 'contribute'))
);

CREATE INDEX IF NOT EXISTS idx_permission_rules_network ON permission_rules(network_id);
CREATE INDEX IF NOT EXISTS idx_permission_rules_match_property
  ON permission_rules USING gin(match_property jsonb_path_ops);

-- Add FK from entity_access.rule_id now that permission_rules table exists
DO $$ BEGIN
  ALTER TABLE entity_access
    ADD CONSTRAINT fk_entity_access_rule
    FOREIGN KEY (rule_id) REFERENCES permission_rules(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE permission_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY rules_select ON permission_rules FOR SELECT USING (true);
CREATE POLICY rules_insert ON permission_rules FOR INSERT WITH CHECK (true);
CREATE POLICY rules_delete ON permission_rules FOR DELETE USING (true);
