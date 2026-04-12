-- Add CHECK constraints for validated columns
ALTER TABLE knowledge_jobs ADD CONSTRAINT knowledge_jobs_status_check
  CHECK (status IN ('pending', 'processing', 'waiting', 'finalizing', 'completed', 'failed'));

ALTER TABLE knowledge_jobs ADD CONSTRAINT knowledge_jobs_trigger_check
  CHECK (trigger IN ('manual', 'poller', 'system'));

-- job_type uses dot-namespaced convention, so just check it's not empty
ALTER TABLE knowledge_jobs ADD CONSTRAINT knowledge_jobs_job_type_check
  CHECK (length(job_type) > 0);

-- Log kind validation
ALTER TABLE knowledge_job_logs ADD CONSTRAINT knowledge_job_logs_kind_check
  CHECK (kind IN ('llm_request', 'llm_response', 'tool_call', 'tool_result', 'error', 'info'));

-- Add created_at to config tables for consistency
ALTER TABLE knowledge_config ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE extraction_config ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
