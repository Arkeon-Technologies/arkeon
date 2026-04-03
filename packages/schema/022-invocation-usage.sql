-- Track token usage and call counts per invocation
ALTER TABLE worker_invocations
  ADD COLUMN input_tokens integer,
  ADD COLUMN output_tokens integer,
  ADD COLUMN total_tokens integer,
  ADD COLUMN llm_calls_count integer DEFAULT 0,
  ADD COLUMN tool_calls_count integer DEFAULT 0;
