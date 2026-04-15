-- Fix: change the default for scope_to_space from false to true.
-- Migration 035 set DEFAULT false, but the application default is true.
-- Existing rows keep their current value (may have been set intentionally).
ALTER TABLE extraction_config ALTER COLUMN scope_to_space SET DEFAULT true;
