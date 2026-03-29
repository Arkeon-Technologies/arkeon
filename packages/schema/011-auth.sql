-- =============================================================================
-- Auth Tables
-- =============================================================================
--
-- Authentication via Ed25519 key pairs and API keys.
-- No PoW challenges — system is invite-only for now.
--
-- Flow:
--   1. Admin creates actor and API key
--   2. Day-to-day: Authorization: ApiKey ak_xxx or uk_xxx
--   3. Lost keys: admin issues new key
--
-- =============================================================================

-- Ed25519 public key → actor ID mapping (one per actor)
CREATE TABLE agent_keys (
  actor_id   TEXT PRIMARY KEY REFERENCES actors(id),
  public_key TEXT NOT NULL UNIQUE,                         -- base64-encoded Ed25519 public key
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_agent_keys_pubkey ON agent_keys(public_key);

-- API keys
CREATE TABLE api_keys (
  id         TEXT PRIMARY KEY,                             -- ULID
  key_prefix TEXT NOT NULL,                                -- first 8 chars for display
  key_hash   TEXT NOT NULL UNIQUE,                         -- SHA-256 hash of full key
  actor_id   TEXT NOT NULL REFERENCES actors(id),
  label      TEXT,                                         -- optional human-readable label
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ                                   -- NULL = active
);

CREATE INDEX idx_api_keys_hash ON api_keys(key_hash);
CREATE INDEX idx_api_keys_actor ON api_keys(actor_id);

-- Grants
GRANT SELECT, INSERT, UPDATE, DELETE ON agent_keys TO arke_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON api_keys TO arke_app;
