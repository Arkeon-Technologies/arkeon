-- Add typed handler pipeline to knowledge jobs.
-- job_type uses dot-namespaced convention: "ingest", "text.extract", "text.chunk_extract", etc.

ALTER TABLE knowledge_jobs ADD COLUMN job_type TEXT NOT NULL DEFAULT 'ingest';
ALTER TABLE knowledge_jobs ADD COLUMN parent_job_id TEXT REFERENCES knowledge_jobs(id);
ALTER TABLE knowledge_jobs ADD COLUMN metadata JSONB;

-- Drop old unique constraint (chunk jobs share entity+ver with parent)
ALTER TABLE knowledge_jobs DROP CONSTRAINT IF EXISTS knowledge_jobs_entity_id_entity_ver_key;

-- Only ingest jobs deduplicate per entity+ver
CREATE UNIQUE INDEX idx_knowledge_jobs_entity_ver_dedup
  ON knowledge_jobs(entity_id, entity_ver)
  WHERE job_type = 'ingest';

CREATE INDEX idx_knowledge_jobs_parent ON knowledge_jobs(parent_job_id);
CREATE INDEX idx_knowledge_jobs_type ON knowledge_jobs(job_type, status);
