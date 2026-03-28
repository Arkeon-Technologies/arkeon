-- =============================================================================
-- RLS fixes for auth tables with non-superuser app role
-- =============================================================================
-- The original api_keys/agent_keys RLS policies assumed a superuser connection
-- that bypasses RLS. With a proper app role (NOSUPERUSER NOBYPASSRLS), the
-- auth middleware needs to read api_keys by hash (before knowing the actor),
-- and registration needs to insert keys for new entities.
-- =============================================================================

-- api_keys: allow reading by hash (auth middleware) and all writes
-- The actual authorization is done at application level.
DROP POLICY IF EXISTS api_keys_select ON api_keys;
CREATE POLICY api_keys_select ON api_keys FOR SELECT USING (true);

DROP POLICY IF EXISTS api_keys_insert ON api_keys;
CREATE POLICY api_keys_insert ON api_keys FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS api_keys_update ON api_keys;
CREATE POLICY api_keys_update ON api_keys FOR UPDATE USING (true);

DROP POLICY IF EXISTS api_keys_delete ON api_keys;
CREATE POLICY api_keys_delete ON api_keys FOR DELETE USING (true);

-- agent_keys: same — registration inserts, recovery reads
DROP POLICY IF EXISTS agent_keys_insert ON agent_keys;
CREATE POLICY agent_keys_insert ON agent_keys FOR INSERT WITH CHECK (true);

-- comments: need INSERT and DELETE policies
DO $$ BEGIN
  CREATE POLICY comments_insert ON comments FOR INSERT WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY comments_delete ON comments FOR DELETE USING (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- pow_challenges: enable RLS with permissive policies
ALTER TABLE pow_challenges ENABLE ROW LEVEL SECURITY;
CREATE POLICY pow_challenges_select ON pow_challenges FOR SELECT USING (true);
CREATE POLICY pow_challenges_insert ON pow_challenges FOR INSERT WITH CHECK (true);
CREATE POLICY pow_challenges_delete ON pow_challenges FOR DELETE USING (true);

-- notifications: need INSERT policy (fan-out is a system write)
DO $$ BEGIN
  CREATE POLICY notifications_insert ON notifications FOR INSERT WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
