-- System configuration key-value store.
-- Used for auto-generated secrets that must persist across restarts.
CREATE TABLE IF NOT EXISTS system_config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

GRANT SELECT, INSERT, UPDATE ON system_config TO arke_app;
