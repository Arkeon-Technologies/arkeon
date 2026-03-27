-- =============================================================================
-- Auth Tables
-- =============================================================================
--
-- Agent-only authentication via Ed25519 key pairs and API keys.
-- No Supabase JWT or human user auth for MVP.
--
-- Flow:
--   1. Agent generates Ed25519 key pair locally
--   2. POST /auth/challenge with public_key → nonce + difficulty
--   3. Solve PoW: find counter where SHA-256(nonce + public_key + counter) has N leading zero bits
--   4. POST /auth/register with public_key + nonce + solution + signature → entity_id + first API key
--   5. Day-to-day: Authorization: ApiKey ak_xxx
--   6. Lost keys: POST /auth/recover with signed challenge → new API key
--
-- =============================================================================

-- Ed25519 public key → entity ID mapping (one per agent)
CREATE TABLE agent_keys (
  entity_id TEXT PRIMARY KEY REFERENCES entities(id),
  public_key TEXT NOT NULL UNIQUE,        -- base64-encoded Ed25519 public key (32 bytes)
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_agent_keys_pubkey ON agent_keys(public_key);

-- Proof-of-work challenges (ephemeral, cleaned up by pg_cron)
CREATE TABLE pow_challenges (
  nonce TEXT PRIMARY KEY,                 -- 64-char hex (32 random bytes)
  public_key TEXT NOT NULL,               -- base64 Ed25519 key that requested the challenge
  difficulty INTEGER NOT NULL DEFAULT 22, -- leading zero bits required (~5-10s solve time)
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL         -- 5 minutes after creation
);

CREATE INDEX idx_pow_challenges_expires ON pow_challenges(expires_at);

-- Cleanup expired challenges every minute
-- SELECT cron.schedule('cleanup_pow_challenges', '* * * * *',
--   $$DELETE FROM pow_challenges WHERE expires_at < NOW()$$
-- );

-- API keys (ak_ prefix only for MVP)
CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,                    -- ULID
  key_prefix TEXT NOT NULL,               -- first 8 chars for display (e.g. "ak_1a4f")
  key_hash TEXT NOT NULL UNIQUE,          -- SHA-256 hash of the full key
  actor_id TEXT NOT NULL REFERENCES entities(id),
  label TEXT,                             -- optional human-readable label
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ                  -- NULL = active, set when revoked
);

CREATE INDEX idx_api_keys_hash ON api_keys(key_hash);
CREATE INDEX idx_api_keys_actor ON api_keys(actor_id);

-- RLS: agents can only read/revoke their own keys
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;

CREATE POLICY api_keys_select ON api_keys
  FOR SELECT USING (actor_id = current_setting('app.actor_id', true));

CREATE POLICY api_keys_insert ON api_keys
  FOR INSERT WITH CHECK (actor_id = current_setting('app.actor_id', true));

CREATE POLICY api_keys_update ON api_keys
  FOR UPDATE USING (actor_id = current_setting('app.actor_id', true));

-- agent_keys: public keys are readable by anyone, writes restricted to system
ALTER TABLE agent_keys ENABLE ROW LEVEL SECURITY;

CREATE POLICY agent_keys_select ON agent_keys
  FOR SELECT USING (true);

-- Insert/update handled by system role (during registration), not by RLS
