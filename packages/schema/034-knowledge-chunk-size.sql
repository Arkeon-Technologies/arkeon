-- Add configurable chunk size to extraction config
-- Default 8000 chars (~2000 tokens) for detailed extraction
ALTER TABLE extraction_config ADD COLUMN target_chunk_chars INTEGER NOT NULL DEFAULT 8000;
