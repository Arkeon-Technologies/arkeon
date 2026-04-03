/**
 * Records worker invocations to the worker_invocations table.
 * Provides lifecycle functions: create → markRunning → complete/cancel.
 *
 * All writes go through transactions that set RLS context (app.actor_id)
 * so the UPDATE policy is satisfied.
 */

import type { InvokeResult } from "./worker-invoke.js";
import { createSql } from "./sql.js";

/**
 * Create a queued invocation record. Returns the row ID.
 * This is awaited (we need the ID for the queue and 202 response).
 */
export async function createInvocationRecord(
  workerId: string,
  invokerId: string,
  source: "http" | "scheduler",
  prompt: string,
): Promise<number> {
  const sql = createSql();
  const [,, rows] = await sql.transaction([
    sql.query(`SELECT set_config('app.actor_id', $1, true)`, [invokerId]),
    sql.query(`SELECT set_config('app.actor_is_admin', 'false', true)`, []),
    sql.query(
      `INSERT INTO worker_invocations
        (worker_id, invoker_id, source, prompt, status)
       VALUES ($1, $2, $3, $4, 'queued')
       RETURNING id`,
      [workerId, invokerId, source, prompt],
    ),
  ]);
  const row = (rows as Array<{ id: number }>)[0];
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

  sql.transaction([
    sql.query(`SELECT set_config('app.actor_id', $1, true)`, [invokerId]),
    sql.query(`SELECT set_config('app.actor_is_admin', 'false', true)`, []),
    sql.query(
      `UPDATE worker_invocations
       SET status = $1, success = $2, summary = $3, iterations = $4,
           error_message = $5, log = $6::jsonb,
           started_at = $7::timestamptz, completed_at = $8::timestamptz, duration_ms = $9
       WHERE id = $10`,
      [
        status,
        result.success,
        result.summary,
        result.iterations,
        result.errorMessage ?? null,
        storeLogs && result.log.length > 0 ? JSON.stringify(result.log) : null,
        startedAt.toISOString(),
        completedAt.toISOString(),
        durationMs,
        id,
      ],
    ),
  ]).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[invocation-recorder] failed to complete (${id}): ${msg}`);
  });
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
