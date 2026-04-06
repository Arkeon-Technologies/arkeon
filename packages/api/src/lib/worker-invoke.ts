/**
 * Shared worker invocation logic used by both the HTTP endpoint
 * and the BullMQ scheduler.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Agent, type LogEntry, type UsageStats } from "../../../runtime/src/agent.js";
import { decrypt } from "./crypto.js";
import { createSql } from "./sql.js";
import { buildWorkerSystemPrompt } from "./worker-prompt.js";

export type LogLevel = "full" | "errors_only" | "none";

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
  log_level?: LogLevel;
  resource_limits?: {
    memory_mb?: number;
    cpu_percent?: number;
    max_pids?: number;
    timeout_ms?: number;
  };
};

export interface InvokeResult {
  success: boolean;
  result: Record<string, unknown> | null;
  iterations: number;
  log: LogEntry[];
  usage: UsageStats;
  logLevel: LogLevel;
  startedAt: Date;
  completedAt: Date;
  errorMessage?: string;
}

/**
 * Invoke a worker by ID with a prompt.
 * Fetches the worker from DB, decrypts keys, spawns sandbox, runs agent loop.
 */
export interface InvocationContext {
  invocationId: number;
  depth: number;
}

export async function invokeWorker(
  workerId: string,
  prompt: string,
  context?: InvocationContext,
  signal?: AbortSignal,
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

  const fullSystemPrompt = buildWorkerSystemPrompt(props.system_prompt, context);

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
        // Allow pip install --target to work; packages land in workspace/pip-pkgs
        PYTHONPATH: `${workspace}/pip-pkgs`,
        PIP_TARGET: `${workspace}/pip-pkgs`,
        PIP_BREAK_SYSTEM_PACKAGES: "1",
        ...(context ? {
          ARKE_INVOCATION_ID: String(context.invocationId),
          ARKE_INVOCATION_DEPTH: String(context.depth),
        } : {}),
      },
    },
    maxIterations: props.max_iterations ?? 50,
  });

  const timeoutMs = props.resource_limits?.timeout_ms ?? 600_000;
  const logLevel = props.log_level ?? "full";
  const startedAt = new Date();

  // Combine external abort signal and timeout into a single signal.
  // This ensures agent.run() stops cooperatively on EITHER condition,
  // preventing orphaned agent loops that keep spawning bwrap processes.
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combinedSignal = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal;

  try {
    const result = await agent.run(prompt, combinedSignal);

    return {
      success: result.success,
      result: result.result,
      iterations: result.iterations,
      log: result.log,
      usage: result.usage,
      logLevel,
      startedAt,
      completedAt: new Date(),
      errorMessage: result.success ? undefined : (result.result as Record<string, unknown>)?.error as string | undefined,
    };
  } finally {
    try {
      rmSync(workspace, { recursive: true, force: true });
    } catch {
      // Best effort cleanup
    }
  }
}
