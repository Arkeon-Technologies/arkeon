-- When true, extracted entities are placed into the same space as the source
-- document, and dedupe/resolve searches are scoped to that space.
-- Default false: graph spans all spaces, only read/write levels are inherited.
ALTER TABLE extraction_config ADD COLUMN scope_to_space BOOLEAN NOT NULL DEFAULT false;
