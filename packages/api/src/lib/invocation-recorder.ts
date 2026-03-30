/**
 * Records worker invocations to the worker_invocations table.
 * Fire-and-forget — errors are logged but don't propagate.
 */

import type { LogEntry } from "../../../runtime/src/agent.js";
import { createSql } from "./sql.js";

export interface InvocationRecord {
  workerId: string;
  invokerId: string;
  source: "http" | "scheduler";
  prompt: string;
  success: boolean;
  summary: string | null;
  iterations: number;
  errorMessage?: string;
  log?: LogEntry[] | null;
  startedAt: Date;
  completedAt: Date;
}

export function recordInvocation(params: InvocationRecord): void {
  const durationMs = params.completedAt.getTime() - params.startedAt.getTime();
  const sql = createSql();

  // Fire-and-forget
  sql.transaction([
    sql.query(
      `INSERT INTO worker_invocations
        (worker_id, invoker_id, source, prompt, success, summary, iterations, error_message, log, started_at, completed_at, duration_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::timestamptz, $11::timestamptz, $12)`,
      [
        params.workerId,
        params.invokerId,
        params.source,
        params.prompt,
        params.success,
        params.summary,
        params.iterations,
        params.errorMessage ?? null,
        params.log ? JSON.stringify(params.log) : null,
        params.startedAt.toISOString(),
        params.completedAt.toISOString(),
        durationMs,
      ],
    ),
  ]).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[invocation-recorder] failed to record: ${msg}`);
  });
}
