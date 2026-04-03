/**
 * Manual test for worker invocation restart resilience.
 *
 * Proves that worker invocations survive a server crash:
 * 1. Starts the API server
 * 2. Creates a worker and invokes it (async)
 * 3. Waits for the invocation to start running
 * 4. Kills the server (SIGKILL — simulates crash)
 * 5. Restarts the server
 * 6. Verifies the invocation was re-queued and completes
 *
 * Usage:
 *   # Requires a running Postgres with migrations applied
 *   OPENAI_API_KEY=sk-... tsx packages/api/test/manual/test-restart-resilience.ts
 *
 * Optional env vars:
 *   DATABASE_URL          — Postgres connection string (default: local)
 *   ADMIN_BOOTSTRAP_KEY   — Admin API key (default: ak_test_restart_resilience)
 *   PORT                  — API port (default: 8042)
 *   ENCRYPTION_KEY        — 64-char hex key (default: test key)
 */

import "dotenv/config";
import dotenv from "dotenv";
import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";

// Load manual test .env (for OPENAI_API_KEY) on top of root .env
dotenv.config({ path: resolve(import.meta.dirname, ".env"), override: true });

const PORT = process.env.PORT ?? "8042";
const BASE_URL = `http://localhost:${PORT}`;
const ADMIN_KEY = process.env.ADMIN_BOOTSTRAP_KEY ?? "ak_test_restart_resilience";
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const ROOT = resolve(import.meta.dirname, "../../../..");

if (!OPENAI_KEY) {
  console.error("OPENAI_API_KEY is required");
  process.exit(1);
}

// ─── Helpers ─────────────────────────────────────────────────────

async function api(path: string, options?: { method?: string; json?: unknown }) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: options?.method ?? "GET",
    headers: {
      "X-API-Key": ADMIN_KEY,
      ...(options?.json ? { "Content-Type": "application/json" } : {}),
    },
    body: options?.json ? JSON.stringify(options.json) : undefined,
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`  FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  PASS: ${msg}`);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForHealth(label: string, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE_URL}/health`);
      if (res.ok) {
        console.log(`  ${label} is healthy`);
        return;
      }
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  throw new Error(`${label} did not become healthy within ${timeoutMs}ms`);
}

function startServer(label: string): ChildProcess {
  const env = {
    ...process.env,
    PORT,
    ADMIN_BOOTSTRAP_KEY: ADMIN_KEY,
    ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ?? "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  };

  const child = spawn("npx", ["tsx", "packages/api/src/index.ts"], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Collect output for debugging
  let output = "";
  child.stdout?.on("data", (d: Buffer) => {
    output += d.toString();
  });
  child.stderr?.on("data", (d: Buffer) => {
    output += d.toString();
  });

  // Attach output getter for later inspection
  (child as any)._output = () => output;

  child.on("error", (err) => {
    console.error(`[${label}] process error:`, err.message);
  });

  return child;
}

function getOutput(child: ChildProcess): string {
  return (child as any)._output?.() ?? "";
}

async function pollInvocation(
  invocationId: number,
  targetStatuses: string[],
  timeoutMs = 120_000,
): Promise<Record<string, unknown>> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const { status, body } = await api(`/workers/invocations/${invocationId}`);
      if (status === 200 && body) {
        const record = body as Record<string, unknown>;
        if (targetStatuses.includes(record.status as string)) {
          return record;
        }
        process.stdout.write(`  status=${record.status} retry_count=${record.retry_count}...\r`);
      }
    } catch {
      // server might be down during restart
    }
    await sleep(2000);
  }
  throw new Error(`Invocation ${invocationId} did not reach ${targetStatuses.join("/")} within ${timeoutMs}ms`);
}

// ─── Main Test ───────────────────────────────────────────────────

async function run() {
  console.log("\n=== Restart Resilience Test ===\n");

  // Step 1: Start the server
  console.log("1. Starting API server...");
  let server = startServer("server-1");
  await waitForHealth("Server (first start)");

  // Step 2: Create a worker with a multi-step prompt that takes time
  console.log("\n2. Creating worker...");
  const { status: createStatus, body: createBody } = await api("/actors", {
    method: "POST",
    json: {
      kind: "worker",
      name: "test-restart-worker",
      system_prompt: [
        "You are a research assistant. When given a topic, you must:",
        "1. Write a draft analysis to a file using write_file",
        "2. Read the file back using read_file to verify",
        "3. Run a shell command to list the workspace files",
        "4. Write a revised version to a second file",
        "5. Read both files and compare them",
        "6. Finally call done with your conclusion",
        "",
        "Take your time and be thorough. Each step must be a separate tool call.",
      ].join("\n"),
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
  const workerId = (createBody as any).actor.id;
  console.log(`  Worker ID: ${workerId}`);

  // Step 3: Invoke async (don't wait)
  console.log("\n3. Invoking worker (async)...");
  const { status: invokeStatus, body: invokeBody } = await api(`/workers/${workerId}/invoke`, {
    method: "POST",
    json: {
      prompt: "Analyze the concept of emergent behavior in complex systems. Write a thorough multi-paragraph analysis covering at least 3 examples from different domains (biology, economics, technology). Be detailed and take your time with each step.",
    },
  });
  assert(invokeStatus === 202, `Invoke returned 202 (got ${invokeStatus})`);
  const invocationId = (invokeBody as any).invocation_id as number;
  console.log(`  Invocation ID: ${invocationId}`);

  // Step 4: Wait for it to start running
  console.log("\n4. Waiting for invocation to start running...");
  const runningRecord = await pollInvocation(invocationId, ["running", "completed"], 30_000);
  console.log();

  if (runningRecord.status === "completed") {
    console.log("  Worker completed before we could kill the server (too fast!)");
    console.log("  Re-invoking with a longer task...");

    // Try again with an even longer prompt
    const { body: body2 } = await api(`/workers/${workerId}/invoke`, {
      method: "POST",
      json: {
        prompt: "Write a comprehensive 10-chapter outline for a textbook on distributed systems. For each chapter, write a file with the chapter summary (chapter-01.txt through chapter-10.txt). Read each file back after writing. Then compile a final summary by reading all files. Be extremely thorough.",
      },
    });
    const invId2 = (body2 as any).invocation_id as number;
    console.log(`  New Invocation ID: ${invId2}`);
    await pollInvocation(invId2, ["running"], 30_000);
    console.log();

    // Now kill with this invocation
    console.log("\n5. Killing server (SIGKILL)...");
    server.kill("SIGKILL");
    await sleep(1000);
    assert(!server.killed || server.exitCode !== null, "Server process killed");

    // Check server logs for queue info
    const output1 = getOutput(server);
    if (output1.includes("orphan recovery")) {
      console.log("  Server logs mention orphan recovery (from a prior run)");
    }

    console.log("\n6. Restarting server...");
    server = startServer("server-2");
    await waitForHealth("Server (second start)");

    // Check server logs for recovery
    const output2 = getOutput(server);
    if (output2.includes("orphan recovery")) {
      console.log("  Server logged orphan recovery!");
    }
    if (output2.includes("picked up")) {
      console.log("  Server picked up queued invocations!");
    }

    console.log("\n7. Polling invocation until completion...");
    const finalRecord = await pollInvocation(invId2, ["completed", "failed"], 120_000);
    console.log();
    console.log(`  Final status: ${finalRecord.status}`);
    console.log(`  retry_count: ${finalRecord.retry_count}`);
    console.log(`  success: ${finalRecord.success}`);
    if (finalRecord.error_message) {
      console.log(`  error: ${finalRecord.error_message}`);
    }

    assert((finalRecord.retry_count as number) >= 1, `retry_count >= 1 (got ${finalRecord.retry_count})`);
    assert(finalRecord.status === "completed", `Invocation completed after retry (got ${finalRecord.status})`);

    // Cleanup
    server.kill("SIGTERM");
    console.log("\n=== All tests passed! ===\n");
    process.exit(0);
  }

  // Normal flow: invocation is running, kill the server
  console.log(`  Invocation is ${runningRecord.status}`);

  // Step 5: Kill the server (SIGKILL — no graceful shutdown)
  console.log("\n5. Killing server (SIGKILL — simulating crash)...");
  server.kill("SIGKILL");
  await sleep(1000);
  console.log(`  Server exit code: ${server.exitCode}`);

  // Step 6: Restart the server
  console.log("\n6. Restarting server...");
  server = startServer("server-2");
  await waitForHealth("Server (second start)");

  // Give it a moment to run initQueue recovery
  await sleep(1000);

  // Check server logs for recovery
  const output2 = getOutput(server);
  if (output2.includes("orphan recovery")) {
    console.log("  Server logged orphan recovery!");
  }
  if (output2.includes("picked up")) {
    console.log("  Server picked up queued invocations!");
  }

  // Step 7: Poll the original invocation until it completes
  console.log("\n7. Polling invocation until completion...");
  const finalRecord = await pollInvocation(invocationId, ["completed", "failed"], 120_000);
  console.log();
  console.log(`  Final status: ${finalRecord.status}`);
  console.log(`  retry_count: ${finalRecord.retry_count}`);
  console.log(`  success: ${finalRecord.success}`);
  console.log(`  iterations: ${finalRecord.iterations}`);
  if (finalRecord.error_message) {
    console.log(`  error: ${finalRecord.error_message}`);
  }
  if (finalRecord.result) {
    console.log(`  result: ${JSON.stringify(finalRecord.result, null, 2).slice(0, 200)}`);
  }

  // Assertions
  assert((finalRecord.retry_count as number) >= 1, `retry_count >= 1 (got ${finalRecord.retry_count})`);
  assert(finalRecord.status === "completed", `Invocation completed after retry (got ${finalRecord.status})`);
  assert(finalRecord.success === true, `Invocation succeeded`);

  // Step 8: Verify via invocation list that this is the same record (not a new one)
  console.log("\n8. Verifying invocation record integrity...");
  const { body: listBody } = await api(`/workers/${workerId}/invocations`);
  const invocations = (listBody as any).invocations as Array<Record<string, unknown>>;
  const thisInvocation = invocations.find((i) => i.id === invocationId);
  assert(thisInvocation != null, "Original invocation ID still exists (not a new record)");
  assert(thisInvocation!.retry_count === finalRecord.retry_count, "retry_count matches in list view");

  // Cleanup
  console.log("\n9. Shutting down...");
  server.kill("SIGTERM");
  await sleep(2000);

  console.log("\n=== All tests passed! ===\n");
  process.exit(0);
}

run().catch((err) => {
  console.error("\nTest failed:", err);
  process.exit(1);
});
