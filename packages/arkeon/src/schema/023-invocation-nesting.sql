-- Track parent-child relationships between invocations and enforce depth limits
ALTER TABLE worker_invocations
  ADD COLUMN parent_invocation_id bigint REFERENCES worker_invocations(id),
  ADD COLUMN depth integer NOT NULL DEFAULT 0;

CREATE INDEX idx_invocations_parent ON worker_invocations(parent_invocation_id)
  WHERE parent_invocation_id IS NOT NULL;
