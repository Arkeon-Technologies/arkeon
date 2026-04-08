-- Add configurable concurrency to extraction config
ALTER TABLE extraction_config ADD COLUMN max_concurrency INTEGER NOT NULL DEFAULT 10;

-- Update existing row
UPDATE extraction_config SET max_concurrency = 10 WHERE id = 'default';
