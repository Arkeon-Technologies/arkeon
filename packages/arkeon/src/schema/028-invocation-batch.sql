-- Sequential batch invocations: group multiple invocations to run in order.
-- Only the first item (batch_seq=0) enters the queue; each completion chains the next.

ALTER TABLE worker_invocations ADD COLUMN batch_id TEXT;
ALTER TABLE worker_invocations ADD COLUMN batch_seq INTEGER;
ALTER TABLE worker_invocations ADD COLUMN batch_on_fail TEXT NOT NULL DEFAULT 'continue';

ALTER TABLE worker_invocations ADD CONSTRAINT valid_batch_on_fail
  CHECK (batch_on_fail IN ('continue', 'cancel'));

-- Partial index for batch lookups — only batch items, ordered by sequence
CREATE INDEX idx_invocations_batch ON worker_invocations(batch_id, batch_seq)
  WHERE batch_id IS NOT NULL;
