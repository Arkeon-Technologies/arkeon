-- Fix: change the default for scope_to_space from false to true.
-- Migration 035 set DEFAULT false, but the application default is true.
-- Also flip any existing rows that still have the old default.
ALTER TABLE extraction_config ALTER COLUMN scope_to_space SET DEFAULT true;
UPDATE extraction_config SET scope_to_space = true WHERE scope_to_space = false;
