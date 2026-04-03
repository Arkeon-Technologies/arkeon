ALTER TABLE worker_invocations ADD COLUMN retry_count integer NOT NULL DEFAULT 0;
