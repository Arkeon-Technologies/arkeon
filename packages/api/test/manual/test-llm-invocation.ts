/**
 * One-time manual test for live LLM invocation features.
 * Tests: token tracking, structured results, log persistence.
 *
 * Usage: OPENAI_API_KEY=sk-... tsx test/manual/test-llm-invocation.ts
 *
 * Requires a running API server on E2E_BASE_URL (default http://localhost:8042).
 */

import "dotenv/config";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:8042";
const ADMIN_KEY = process.env.ADMIN_BOOTSTRAP_KEY ?? "ak_test_invocation_observability";
const OPENAI_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_KEY) {
  console.error("OPENAI_API_KEY is required");
  process.exit(1);
}

async function api(path: string, options?: { method?: string; json?: unknown }) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: options?.method ?? "GET",
    headers: {
      "X-API-Key": ADMIN_KEY,
      ...(options?.json ? { "Content-Type": "application/json" } : {}),
    },
    body: options?.json ? JSON.stringify(options.json) : undefined,
  });
  const body = await res.json();
  return { status: res.status, body };
}

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`  FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  PASS: ${msg}`);
}

async function run() {
  console.log("\n=== Live LLM Invocation Test ===\n");

  // 1. Create a worker with real OpenAI config (workers are actors with kind=worker)
  console.log("1. Creating worker with OpenAI config...");
  const { status: createStatus, body: createBody } = await api("/actors", {
    method: "POST",
    json: {
      kind: "worker",
      name: "test-llm-worker",
      system_prompt: "You are a helpful assistant. When given a task, complete it and call the done tool with a structured result object.",
      llm: {
        base_url: "https://api.openai.com/v1",
        api_key: OPENAI_KEY,
        model: "gpt-4.1-nano",
      },
      max_read_level: 1,
      max_write_level: 1,
    },
  });
  assert(createStatus === 201, `Worker created (status ${createStatus})`);
  const workerId = (createBody as { actor: { id: string } }).actor.id;
  console.log(`  Worker ID: ${workerId}\n`);

  // 2. Invoke with ?wait=true — test token tracking + structured result
  console.log("2. Invoking worker (wait=true) — classify a sentence...");
  const { status: invokeStatus, body: invokeBody } = await api(
    `/workers/${workerId}/invoke?wait=true`,
    {
      method: "POST",
      json: {
        prompt: 'Classify this sentence: "The server returned a 500 error when processing the payment". Return a result with fields: category (bug/feature/question), severity (low/medium/high/critical), and summary (one line description).',
      },
    },
  );
  assert(invokeStatus === 200, `Invoke returned 200 (got ${invokeStatus})`);

  const invoke = invokeBody as Record<string, unknown>;
  console.log(`  Success: ${invoke.success}`);
  console.log(`  Iterations: ${invoke.iterations}`);
  console.log(`  Result: ${JSON.stringify(invoke.result, null, 2)}`);

  // Check usage stats
  const usage = invoke.usage as Record<string, number> | undefined;
  console.log(`  Usage: ${JSON.stringify(usage)}`);
  assert(usage != null, "Usage object is present");
  assert(usage!.input_tokens > 0, `Input tokens > 0 (got ${usage?.input_tokens})`);
  assert(usage!.output_tokens > 0, `Output tokens > 0 (got ${usage?.output_tokens})`);
  assert(usage!.total_tokens > 0, `Total tokens > 0 (got ${usage?.total_tokens})`);
  assert(usage!.llm_calls >= 1, `LLM calls >= 1 (got ${usage?.llm_calls})`);
  assert(usage!.tool_calls >= 1, `Tool calls >= 1 (got ${usage?.tool_calls})`);

  // Check structured result
  assert(invoke.result != null, "Result is present");
  assert(typeof invoke.result === "object", "Result is an object");
  console.log();

  // 3. Check invocation record in DB via API
  console.log("3. Fetching invocation record...");
  const invocationId = invoke.invocation_id as number;
  const { status: getStatus, body: getBody } = await api(`/workers/invocations/${invocationId}`);
  assert(getStatus === 200, `GET invocation returned 200`);

  const record = getBody as Record<string, unknown>;
  assert(record.result != null, "DB record has result");
  assert(record.input_tokens != null && (record.input_tokens as number) > 0, `DB has input_tokens (${record.input_tokens})`);
  assert(record.output_tokens != null && (record.output_tokens as number) > 0, `DB has output_tokens (${record.output_tokens})`);
  assert(record.log != null, "DB has log (default persistence)");
  assert(record.depth === 0, `Depth is 0 (got ${record.depth})`);
  assert(record.parent_invocation_id === null, "No parent invocation");
  console.log();

  // 4. Invoke with store_log=false — verify result still stored
  console.log("4. Invoking with store_log=false...");
  const { status: noLogStatus, body: noLogBody } = await api(
    `/workers/${workerId}/invoke?wait=true`,
    {
      method: "POST",
      json: {
        prompt: 'Say hello. Return result with field: message.',
        store_log: false,
      },
    },
  );
  assert(noLogStatus === 200, `Invoke returned 200`);
  const noLogInvoke = noLogBody as Record<string, unknown>;
  const noLogId = noLogInvoke.invocation_id as number;

  const { body: noLogRecord } = await api(`/workers/invocations/${noLogId}`);
  const rec2 = noLogRecord as Record<string, unknown>;
  assert(rec2.result != null, "Result stored even with store_log=false");
  assert(rec2.log === null, "Log is null when store_log=false");
  console.log();

  console.log("=== All tests passed! ===\n");
}

run().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
