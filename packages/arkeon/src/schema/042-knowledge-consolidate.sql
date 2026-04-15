-- Allow NULL entity_id for consolidate jobs (they operate on spaces, not entities)
-- Must use DO block since ALTER COLUMN ... DROP NOT NULL has no IF NOT EXISTS
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'knowledge_jobs' AND column_name = 'entity_id' AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE knowledge_jobs ALTER COLUMN entity_id DROP NOT NULL;
  END IF;
END $$;

-- Also need to drop the old UNIQUE constraint on (entity_id, entity_ver) since entity_id can now be NULL
-- The constraint was replaced by a partial index in 033 anyway
-- (The original UNIQUE(entity_id, entity_ver) from 029 may still exist)
ALTER TABLE knowledge_jobs DROP CONSTRAINT IF EXISTS knowledge_jobs_entity_id_entity_ver_key;

-- Prevent duplicate active consolidate jobs per space (pending or processing)
DROP INDEX IF EXISTS idx_knowledge_jobs_consolidate_pending;
CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_jobs_consolidate_active
  ON knowledge_jobs ((metadata->>'space_id'))
  WHERE job_type = 'consolidate' AND status IN ('pending', 'processing');
