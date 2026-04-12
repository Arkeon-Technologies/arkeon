// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * In-process cron scheduler for workers.
 *
 * Each active worker with a `schedule` property in its actor properties
 * gets a node-cron task that enqueues a run on the in-process invocation
 * queue at the configured cadence. Runs in the same process as the API
 * server — no external broker, no Redis.
 *
 * At startup, every worker with a schedule is synced. When workers are
 * created or updated via the HTTP routes, `syncWorkerSchedule` adds,
 * replaces, or removes the task for that worker.
 */

import cron, { type ScheduledTask } from "node-cron";

import { enqueueInvocation } from "./invocation-queue.js";
import { createSql } from "./sql.js";

/**
 * Tracks the currently-scheduled tasks, keyed by worker id.
 * We replace entries on update and destroy them on removal.
 */
const tasks = new Map<string, ScheduledTask>();

/**
 * Tracks workers whose most recent scheduled run is still in flight,
 * so concurrent ticks skip rather than pile up.
 */
const active = new Set<string>();

let started = false;

export async function startScheduler(): Promise<void> {
  if (started) return;
  started = true;
  await syncAllSchedules();
  console.log(`[scheduler] started — ${tasks.size} active schedule(s)`);
}

/**
 * Returns true iff the scheduler is running. Always true after
 * startScheduler resolves — kept as a function so routes that ask
 * "can I schedule right now?" don't have to care about internal state.
 */
export function isSchedulerAvailable(): boolean {
  return started;
}

/**
 * Sync a single worker's schedule. Pass schedule=null to remove it.
 * Called from the workers/actors routes whenever a worker's schedule
 * or scheduled_prompt changes.
 */
export async function syncWorkerSchedule(
  workerId: string,
  schedule: string | null,
  scheduledPrompt: string | null,
): Promise<void> {
  // Remove any existing task first — even if we're about to install a new
  // one, we want a clean replace rather than leaving the old cron live.
  const existing = tasks.get(workerId);
  if (existing) {
    existing.stop();
    existing.destroy();
    tasks.delete(workerId);
  }

  if (!schedule || !scheduledPrompt) return;

  if (!cron.validate(schedule)) {
    console.warn(`[scheduler] ${workerId}: invalid cron expression '${schedule}', skipping`);
    return;
  }

  const task = cron.schedule(schedule, async () => {
    if (active.has(workerId)) {
      console.log(`[scheduler] skipping ${workerId} — already running`);
      return;
    }
    active.add(workerId);
    try {
      // Re-read owner + storeLogs from the DB each tick — cheaper than
      // keeping it in memory and cache-invalidating on every worker edit,
      // and scheduled ticks are rare enough that the extra query is free.
      const sql = createSql();
      const [row] = await sql`
        SELECT owner_id, properties FROM actors WHERE id = ${workerId} LIMIT 1
      `;
      const workerRow = row as Record<string, unknown> | undefined;
      if (!workerRow) {
        // Worker was deleted between sync and this tick. Drop our task
        // so we don't keep firing.
        const dead = tasks.get(workerId);
        if (dead) {
          dead.stop();
          dead.destroy();
          tasks.delete(workerId);
        }
        return;
      }
      const ownerId = (workerRow.owner_id as string) ?? workerId;
      const storeLogs =
        ((workerRow.properties as Record<string, unknown>)?.store_logs === true);

      console.log(`[scheduler] running worker ${workerId}`);
      const { promise } = await enqueueInvocation(
        workerId,
        ownerId,
        "scheduler",
        scheduledPrompt,
        storeLogs,
      );
      const result = await promise;
      console.log(
        `[scheduler] worker ${workerId} finished: success=${result.success}, iterations=${result.iterations}`,
      );
    } catch (err) {
      console.error(`[scheduler] worker ${workerId} failed:`, err);
    } finally {
      active.delete(workerId);
    }
  });

  tasks.set(workerId, task);
  console.log(`[scheduler] scheduled ${workerId}: ${schedule}`);
}

/**
 * Scan every active worker that has a schedule set and install its task.
 * Called once at startup; the workers/actors routes call
 * syncWorkerSchedule directly for incremental updates.
 */
async function syncAllSchedules(): Promise<void> {
  const sql = createSql();
  const rows = await sql`
    SELECT id, properties FROM actors
    WHERE kind = 'worker' AND status = 'active'
    AND properties->>'schedule' IS NOT NULL
  `;

  for (const row of rows as Array<{ id: string; properties: Record<string, unknown> }>) {
    const schedule = row.properties.schedule as string | undefined;
    const scheduledPrompt = row.properties.scheduled_prompt as string | undefined;
    if (schedule && scheduledPrompt) {
      await syncWorkerSchedule(row.id, schedule, scheduledPrompt);
    }
  }
}

/**
 * Graceful shutdown — stop every cron task and clear state.
 */
export async function stopScheduler(): Promise<void> {
  for (const task of tasks.values()) {
    task.stop();
    task.destroy();
  }
  tasks.clear();
  active.clear();
  started = false;
  console.log("[scheduler] stopped");
}
