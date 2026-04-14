-- Knowledge extraction service tables
-- Stores LLM configuration, extraction rules, job queue, logs, and usage tracking.

-- LLM configuration per extraction role (extractor, resolver, default)
CREATE TABLE knowledge_config (
  id                TEXT PRIMARY KEY,
  provider          TEXT NOT NULL DEFAULT 'openai',
  base_url          TEXT,
  api_key_encrypted TEXT,
  api_key_hint      TEXT,
  model             TEXT NOT NULL,
  max_tokens        INTEGER DEFAULT 4096,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Extraction rules: entity types, predicates, custom instructions
CREATE TABLE extraction_config (
  id                    TEXT PRIMARY KEY DEFAULT 'default',
  entity_types          JSONB NOT NULL DEFAULT '[]'::jsonb,
  strict_entity_types   BOOLEAN NOT NULL DEFAULT false,
  predicates            JSONB NOT NULL DEFAULT '[]'::jsonb,
  strict_predicates     BOOLEAN NOT NULL DEFAULT false,
  custom_instructions   TEXT,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Job queue + execution history
CREATE TABLE knowledge_jobs (
  id              TEXT PRIMARY KEY,
  entity_id       TEXT NOT NULL REFERENCES entities(id),
  entity_ver      INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  trigger         TEXT NOT NULL DEFAULT 'manual',
  attempts        INTEGER NOT NULL DEFAULT 0,
  max_attempts    INTEGER NOT NULL DEFAULT 3,
  result          JSONB,
  error           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  UNIQUE(entity_id, entity_ver)
);
CREATE INDEX idx_knowledge_jobs_status ON knowledge_jobs(status, created_at);
CREATE INDEX idx_knowledge_jobs_entity ON knowledge_jobs(entity_id);

-- Per-step execution logs for each job
CREATE TABLE knowledge_job_logs (
  id              BIGSERIAL PRIMARY KEY,
  job_id          TEXT NOT NULL REFERENCES knowledge_jobs(id) ON DELETE CASCADE,
  seq             INTEGER NOT NULL,
  ts              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  kind            TEXT NOT NULL,
  content         JSONB,
  model           TEXT,
  tokens_in       INTEGER,
  tokens_out      INTEGER
);
CREATE INDEX idx_knowledge_job_logs_job ON knowledge_job_logs(job_id, seq);

-- Daily token usage rollup per model
CREATE TABLE knowledge_token_usage (
  date                  DATE NOT NULL,
  model                 TEXT NOT NULL,
  calls                 INTEGER NOT NULL DEFAULT 0,
  tokens_in             INTEGER NOT NULL DEFAULT 0,
  tokens_out            INTEGER NOT NULL DEFAULT 0,
  estimated_cost_cents  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date, model)
);

-- Content poller checkpoint (cursor into entity_activity)
CREATE TABLE knowledge_poller_state (
  id                    TEXT PRIMARY KEY DEFAULT 'default',
  last_activity_id      BIGINT NOT NULL DEFAULT 0,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed default extraction config
INSERT INTO extraction_config (id, entity_types, predicates, updated_at) VALUES (
  'default',
  '["person","organization","location","event","concept","document","product","technology"]'::jsonb,
  '["relates_to","part_of","leads","works_at","located_in","participated_in","created","references","depends_on","preceded_by"]'::jsonb,
  NOW()
) ON CONFLICT (id) DO NOTHING;

-- Seed poller state: start from current tip so the poller only watches
-- for new events, not the entire history. Prevents a flood of extraction
-- jobs when knowledge is enabled on an instance with existing data.
INSERT INTO knowledge_poller_state (id, last_activity_id, updated_at)
VALUES ('default', COALESCE((SELECT MAX(id) FROM entity_activity), 0), NOW())
ON CONFLICT (id) DO NOTHING;
