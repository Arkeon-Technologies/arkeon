-- Functional index for entity upsert on (type, label).
-- Speeds up the pre-flight lookup used by ops upsert_on: ["label", "type"].
CREATE INDEX IF NOT EXISTS idx_entities_type_label_lower
  ON entities (type, lower(properties->>'label'))
  WHERE kind = 'entity' AND properties->>'label' IS NOT NULL;
