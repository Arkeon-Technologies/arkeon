-- Grant arke_app access to all knowledge tables.
-- Required for RLS enforcement — arke_app is the non-superuser
-- role that the API connects as in production.

GRANT SELECT, INSERT, UPDATE, DELETE ON knowledge_config TO arke_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON extraction_config TO arke_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON knowledge_jobs TO arke_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON knowledge_job_logs TO arke_app;
GRANT USAGE, SELECT ON SEQUENCE knowledge_job_logs_id_seq TO arke_app;
GRANT SELECT, INSERT, UPDATE ON knowledge_token_usage TO arke_app;
GRANT SELECT, INSERT, UPDATE ON knowledge_poller_state TO arke_app;

-- Enable RLS on knowledge tables
ALTER TABLE knowledge_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE extraction_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_job_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_token_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_poller_state ENABLE ROW LEVEL SECURITY;

-- Admin-only access to config tables
CREATE POLICY knowledge_config_admin ON knowledge_config
  FOR ALL TO arke_app
  USING (current_actor_is_admin());

CREATE POLICY extraction_config_admin ON extraction_config
  FOR ALL TO arke_app
  USING (current_actor_is_admin());

-- Jobs: admin sees all, others see own triggered_by
CREATE POLICY knowledge_jobs_access ON knowledge_jobs
  FOR ALL TO arke_app
  USING (current_actor_is_admin() OR triggered_by = current_actor_id() OR triggered_by IS NULL);

-- Job logs: follow parent job access
CREATE POLICY knowledge_job_logs_access ON knowledge_job_logs
  FOR ALL TO arke_app
  USING (EXISTS (
    SELECT 1 FROM knowledge_jobs j
    WHERE j.id = job_id
    AND (current_actor_is_admin() OR j.triggered_by = current_actor_id() OR j.triggered_by IS NULL)
  ));

-- Usage: admin only
CREATE POLICY knowledge_token_usage_admin ON knowledge_token_usage
  FOR ALL TO arke_app
  USING (current_actor_is_admin());

-- Poller state: admin only (system table)
CREATE POLICY knowledge_poller_state_admin ON knowledge_poller_state
  FOR ALL TO arke_app
  USING (current_actor_is_admin());
