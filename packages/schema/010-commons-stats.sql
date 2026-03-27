-- =============================================================================
-- Commons Stats — Denormalized Counters
-- =============================================================================
--
-- Two columns on the entities table track commons-level activity signals:
--
--   entity_count     — number of children (entities + sub-commons) in this commons
--   last_activity_at — timestamp of the most recent entity create/update/delete
--
-- These are only meaningful for kind='commons' rows. They are updated
-- atomically within the same transaction as entity writes:
--
--   Entity created in commons  → +1, NOW()
--   Entity deleted from commons → -1, NOW()
--   Entity updated in commons  → NOW()
--   Entity moved out of commons → -1 on old, +1 on new, NOW() on both
--   Sub-commons created        → +1, NOW()
--
-- This avoids any joins or aggregation at read time — GET /commons is a
-- simple indexed scan.
--
-- =============================================================================

ALTER TABLE entities ADD COLUMN entity_count INTEGER DEFAULT 0;
ALTER TABLE entities ADD COLUMN last_activity_at TIMESTAMPTZ;

-- Partial indexes for sorting commons by these fields
CREATE INDEX idx_commons_last_activity ON entities(last_activity_at DESC NULLS LAST)
  WHERE kind = 'commons';
CREATE INDEX idx_commons_entity_count ON entities(entity_count DESC NULLS LAST)
  WHERE kind = 'commons';

-- =============================================================================
-- Trigger: auto-update commons stats on entity changes
-- =============================================================================
--
-- Instead of relying on application code to remember the UPDATE, a trigger
-- on the entities table handles it automatically. This guarantees consistency
-- even if new routes or batch operations are added later.
--
-- Fires AFTER INSERT, UPDATE, DELETE on entities (including sub-commons).
-- Sub-commons count toward their parent's entity_count.
-- =============================================================================

CREATE OR REPLACE FUNCTION update_commons_stats() RETURNS TRIGGER AS $$
BEGIN
  -- INSERT: increment new commons
  IF TG_OP = 'INSERT' THEN
    IF NEW.commons_id IS NOT NULL THEN
      UPDATE entities
      SET entity_count = entity_count + 1,
          last_activity_at = NOW()
      WHERE id = NEW.commons_id;
    END IF;
    RETURN NEW;

  -- DELETE: decrement old commons
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.commons_id IS NOT NULL THEN
      UPDATE entities
      SET entity_count = GREATEST(entity_count - 1, 0),
          last_activity_at = NOW()
      WHERE id = OLD.commons_id;
    END IF;
    RETURN OLD;

  -- UPDATE: handle moves and activity
  ELSIF TG_OP = 'UPDATE' THEN
    -- commons_id changed → entity moved between commons
    IF OLD.commons_id IS DISTINCT FROM NEW.commons_id THEN
      IF OLD.commons_id IS NOT NULL THEN
        UPDATE entities
        SET entity_count = GREATEST(entity_count - 1, 0),
            last_activity_at = NOW()
        WHERE id = OLD.commons_id;
      END IF;
      IF NEW.commons_id IS NOT NULL THEN
        UPDATE entities
        SET entity_count = entity_count + 1,
            last_activity_at = NOW()
        WHERE id = NEW.commons_id;
      END IF;
    ELSE
      -- Same commons, just bump activity timestamp
      IF NEW.commons_id IS NOT NULL THEN
        UPDATE entities
        SET last_activity_at = NOW()
        WHERE id = NEW.commons_id;
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_commons_stats
  AFTER INSERT OR UPDATE OR DELETE ON entities
  FOR EACH ROW
  EXECUTE FUNCTION update_commons_stats();

-- =============================================================================
-- Backfill existing data
-- =============================================================================
--
-- Run once after migration to populate stats for existing commons.
-- =============================================================================

UPDATE entities c
SET entity_count = sub.cnt,
    last_activity_at = sub.last_active
FROM (
  SELECT commons_id,
         COUNT(*) AS cnt,
         MAX(updated_at) AS last_active
  FROM entities
  WHERE commons_id IS NOT NULL
  GROUP BY commons_id
) sub
WHERE c.id = sub.commons_id;
