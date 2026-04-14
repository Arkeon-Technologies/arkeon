-- Change knowledge_jobs.entity_id FK to CASCADE on delete.
-- Without this, deleting an entity that has pending knowledge jobs
-- fails with a FK violation (23503). This happens when the poller
-- creates an ingest job and the user deletes the entity before the
-- job is processed.

ALTER TABLE knowledge_jobs
  DROP CONSTRAINT IF EXISTS knowledge_jobs_entity_id_fkey;

ALTER TABLE knowledge_jobs
  ADD CONSTRAINT knowledge_jobs_entity_id_fkey
  FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE;
