/**
 * Records worker invocations to the worker_invocations table.
 * Provides lifecycle functions: create → markRunning → complete/cancel.
 *
 * All writes go through transactions that set RLS context (app.actor_id)
 * so the UPDATE policy is satisfied.
 */

import type { InvokeResult, LogLevel } from "./worker-invoke.js";
import type { LogEntry } from "../../../runtime/src/agent.js";
import { createSql } from "./sql.js";

function filterLogs(log: LogEntry[], level: LogLevel): LogEntry[] {
  if (level === "none") return [];
  if (level === "errors_only") return log.filter((e) => e.type === "error" || e.type === "done");
  return log; // "full"
}

/**
 * Create a queued invocation record. Returns the row ID.
 * This is awaited (we need the ID for the queue and 202 response).
 */
export async function createInvocationRecord(
  workerId: string,
  invokerId: string,
  source: "http" | "scheduler",
  prompt: string,
  parentInvocationId?: number | null,
  depth = 0,
): Promise<number> {
  const sql = createSql();
  const results = await sql.transaction([
    sql.query(`SELECT set_config('app.actor_id', $1, true)`, [invokerId]),
    sql.query(`SELECT set_config('app.actor_is_admin', 'false', true)`, []),
    sql.query(
      `INSERT INTO worker_invocations
        (worker_id, invoker_id, source, prompt, status, parent_invocation_id, depth)
       VALUES ($1, $2, $3, $4, 'queued', $5, $6)
       RETURNING id`,
      [workerId, invokerId, source, prompt, parentInvocationId ?? null, depth],
    ),
  ]);
  const row = (results.at(-1) as Array<{ id: number }>)[0];
  if (!row) throw new Error("Failed to create invocation record");
  return row.id;
}

/**
 * Mark an invocation as running. Fire-and-forget.
 */
export function markInvocationRunning(id: number, invokerId: string): void {
  const sql = createSql();
  sql.transaction([
    sql.query(`SELECT set_config('app.actor_id', $1, true)`, [invokerId]),
    sql.query(`SELECT set_config('app.actor_is_admin', 'false', true)`, []),
    sql.query(
      `UPDATE worker_invocations SET status = 'running', started_at = NOW() WHERE id = $1`,
      [id],
    ),
  ]).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[invocation-recorder] failed to mark running (${id}): ${msg}`);
  });
}

/**
 * Complete an invocation with its result. Fire-and-forget.
 */
export function completeInvocation(
  id: number,
  invokerId: string,
  result: InvokeResult,
  storeLogs?: boolean,
): void {
  const status = result.success ? "completed" : "failed";
  const completedAt = result.completedAt;
  const startedAt = result.startedAt;
  const durationMs = completedAt.getTime() - startedAt.getTime();
  const sql = createSql();

  // Use worker's log_level config; storeLogs param acts as override (false = none)
  const effectiveLevel: LogLevel = storeLogs === false ? "none" : result.logLevel;
  const filtered = filterLogs(result.log, effectiveLevel);

  sql.transaction([
    sql.query(`SELECT set_config('app.actor_id', $1, true)`, [invokerId]),
    sql.query(`SELECT set_config('app.actor_is_admin', 'false', true)`, []),
    sql.query(
      `UPDATE worker_invocations
       SET status = $1, success = $2, result = $3::jsonb, iterations = $4,
           error_message = $5, log = $6::jsonb,
           started_at = $7::timestamptz, completed_at = $8::timestamptz, duration_ms = $9,
           input_tokens = $11, output_tokens = $12, total_tokens = $13,
           llm_calls_count = $14, tool_calls_count = $15
       WHERE id = $10`,
      [
        status,
        result.success,
        result.result ? JSON.stringify(result.result) : null,
        result.iterations,
        result.errorMessage ?? null,
        filtered.length > 0 ? JSON.stringify(filtered) : null,
        startedAt.toISOString(),
        completedAt.toISOString(),
        durationMs,
        id,
        result.usage.inputTokens || null,
        result.usage.outputTokens || null,
        result.usage.totalTokens || null,
        result.usage.llmCalls,
        result.usage.toolCalls,
      ],
    ),
  ]).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[invocation-recorder] failed to complete (${id}): ${msg}`);
  });
}

/**
 * Reset an interrupted invocation back to 'queued' for retry.
 * Increments retry_count and clears partial execution state.
 * Uses admin context since the original invoker isn't around at startup.
 */
export async function resetInvocationForRetry(id: number): Promise<void> {
  const sql = createSql();
  await sql.transaction([
    sql.query(`SELECT set_config('app.actor_is_admin', 'true', true)`, []),
    sql.query(
      `UPDATE worker_invocations
       SET status = 'queued',
           started_at = NULL,
           completed_at = NULL,
           duration_ms = NULL,
           success = NULL,
           result = NULL,
           error_message = NULL,
           log = NULL,
           retry_count = retry_count + 1,
           input_tokens = NULL,
           output_tokens = NULL,
           total_tokens = NULL,
           llm_calls_count = NULL,
           tool_calls_count = NULL
       WHERE id = $1`,
      [id],
    ),
  ]);
}

/**
 * Create all invocation records for a batch in a single transaction.
 * Returns the invocation IDs in order (matching the input array).
 */
export async function createBatchInvocationRecords(
  items: Array<{ workerId: string; prompt: string; storeLogs?: boolean }>,
  invokerId: string,
  source: "http" | "scheduler",
  batchId: string,
  onFail: "continue" | "cancel",
): Promise<number[]> {
  const sql = createSql();
  const queries = [
    sql.query(`SELECT set_config('app.actor_id', $1, true)`, [invokerId]),
    sql.query(`SELECT set_config('app.actor_is_admin', 'false', true)`, []),
    ...items.map((item, seq) =>
      sql.query(
        `INSERT INTO worker_invocations
          (worker_id, invoker_id, source, prompt, status, depth, batch_id, batch_seq, batch_on_fail)
         VALUES ($1, $2, $3, $4, 'queued', 0, $5, $6, $7)
         RETURNING id`,
        [item.workerId, invokerId, source, item.prompt, batchId, seq, onFail],
      ),
    ),
  ];
  const results = await sql.transaction(queries);
  // First 2 results are set_config calls; the rest are INSERT RETURNING rows
  return results.slice(2).map((rows) => {
    const row = (rows as Array<{ id: number }>)[0];
    if (!row) throw new Error("Failed to create batch invocation record");
    return row.id;
  });
}

/**
 * Cancel all remaining batch items after a failure.
 * Awaited by advanceBatch() to ensure cancellation completes before proceeding.
 */
export async function cancelBatchRemaining(
  batchId: string,
  afterSeq: number,
  invokerId: string,
): Promise<void> {
  const sql = createSql();
  await sql.transaction([
    sql.query(`SELECT set_config('app.actor_id', $1, true)`, [invokerId]),
    sql.query(`SELECT set_config('app.actor_is_admin', 'false', true)`, []),
    sql.query(
      `UPDATE worker_invocations
       SET status = 'cancelled', error_message = 'Batch cancelled due to prior failure'
       WHERE batch_id = $1 AND batch_seq > $2 AND status = 'queued'`,
      [batchId, afterSeq],
    ),
  ]);
}

/**
 * Cancel a queued invocation. Fire-and-forget.
 */
export function cancelInvocation(id: number, invokerId: string): void {
  const sql = createSql();
  sql.transaction([
    sql.query(`SELECT set_config('app.actor_id', $1, true)`, [invokerId]),
    sql.query(`SELECT set_config('app.actor_is_admin', 'false', true)`, []),
    sql.query(
      `UPDATE worker_invocations SET status = 'cancelled' WHERE id = $1`,
      [id],
    ),
  ]).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[invocation-recorder] failed to cancel (${id}): ${msg}`);
  });
}
