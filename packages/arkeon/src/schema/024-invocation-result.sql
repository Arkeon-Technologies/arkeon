-- Replace text summary with structured JSONB result
ALTER TABLE worker_invocations ADD COLUMN result JSONB;
ALTER TABLE worker_invocations DROP COLUMN summary;
