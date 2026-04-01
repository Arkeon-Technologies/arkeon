/**
 * Shared worker invocation logic used by both the HTTP endpoint
 * and the BullMQ scheduler.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Agent, type LogEntry } from "../../../runtime/src/agent.js";
import { decrypt } from "./crypto.js";
import { createSql } from "./sql.js";

type WorkerProperties = {
  name: string;
  system_prompt: string;
  llm: {
    base_url: string;
    model: string;
    api_key_encrypted: string;
  };
  arke_key_encrypted: string;
  max_iterations?: number;
  resource_limits?: {
    memory_mb?: number;
    cpu_percent?: number;
    max_pids?: number;
    timeout_ms?: number;
  };
};

export interface InvokeResult {
  success: boolean;
  summary: string | null;
  iterations: number;
  log: LogEntry[];
  startedAt: Date;
  completedAt: Date;
  errorMessage?: string;
}

/**
 * Invoke a worker by ID with a prompt.
 * Fetches the worker from DB, decrypts keys, spawns sandbox, runs agent loop.
 */
export async function invokeWorker(
  workerId: string,
  prompt: string,
): Promise<InvokeResult> {
  const sql = createSql();

  const [row] = await sql`
    SELECT * FROM actors
    WHERE id = ${workerId} AND kind = 'worker' AND status = 'active'
    LIMIT 1
  `;

  if (!row) {
    throw new Error(`Worker ${workerId} not found or not active`);
  }

  const props = (row as Record<string, unknown>).properties as unknown as WorkerProperties;

  if (!props.llm?.api_key_encrypted || !props.arke_key_encrypted) {
    throw new Error(`Worker ${workerId} is missing encryption keys`);
  }

  const llmApiKey = await decrypt(props.llm.api_key_encrypted);
  const arkeApiKey = await decrypt(props.arke_key_encrypted);
  const apiBaseUrl =
    process.env.API_BASE_URL ??
    `http://localhost:${process.env.PORT ?? 8000}`;

  const workspace = mkdtempSync(join(tmpdir(), `arke-worker-${workerId}-`));

  const fullSystemPrompt = [
    props.system_prompt,
    "",
    "## Environment",
    "You are running in an isolated sandbox with a writable workspace directory.",
    "Pre-installed tools: curl, jq, python3, arkeon (Arkeon CLI).",
    "Pre-installed SDKs: arkeon-sdk (TypeScript: import * as arkeon from 'arkeon-sdk'), arkeon_sdk (Python: import arkeon_sdk as arkeon).",
    "$ARKE_API_URL and $ARKE_API_KEY are set and pre-configured for the CLI and SDKs.",
    'For API reference: curl -H "X-API-Key: $ARKE_API_KEY" $ARKE_API_URL/llms.txt',
    "When done, call the done tool with a summary.",
  ].join("\n");

  const agent = new Agent({
    name: props.name ?? workerId,
    systemPrompt: fullSystemPrompt,
    llm: {
      baseUrl: props.llm.base_url,
      apiKey: llmApiKey,
      model: props.llm.model,
    },
    sandbox: {
      workspaceDir: workspace,
      memoryMb: props.resource_limits?.memory_mb ?? 256,
      cpuPercent: props.resource_limits?.cpu_percent ?? 50,
      maxPids: props.resource_limits?.max_pids ?? 128,
      env: {
        ARKE_API_URL: apiBaseUrl,
        ARKE_API_KEY: arkeApiKey,
      },
    },
    maxIterations: props.max_iterations ?? 50,
  });

  const timeoutMs = props.resource_limits?.timeout_ms ?? 300_000;
  const startedAt = new Date();

  try {
    const result = await Promise.race([
      agent.run(prompt),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Worker execution timed out")), timeoutMs),
      ),
    ]);

    return {
      success: result.success,
      summary: result.summary,
      iterations: result.iterations,
      log: result.log,
      startedAt,
      completedAt: new Date(),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      summary: null,
      iterations: 0,
      log: [],
      startedAt,
      completedAt: new Date(),
      errorMessage: msg,
    };
  } finally {
    try {
      rmSync(workspace, { recursive: true, force: true });
    } catch {
      // Best effort cleanup
    }
  }
}
