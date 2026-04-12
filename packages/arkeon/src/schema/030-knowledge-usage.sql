-- Add per-job token usage tracking to knowledge_jobs
ALTER TABLE knowledge_jobs ADD COLUMN model TEXT;
ALTER TABLE knowledge_jobs ADD COLUMN tokens_in INTEGER NOT NULL DEFAULT 0;
ALTER TABLE knowledge_jobs ADD COLUMN tokens_out INTEGER NOT NULL DEFAULT 0;
ALTER TABLE knowledge_jobs ADD COLUMN llm_calls INTEGER NOT NULL DEFAULT 0;
