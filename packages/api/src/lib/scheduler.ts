/**
 * BullMQ-based cron scheduler for workers.
 * Runs in the same process as the API server.
 * Requires Redis (REDIS_URL env var). If Redis is unavailable, scheduling is disabled.
 */

import { Queue, Worker as BullWorker } from "bullmq";

import { getRedis, closeRedis } from "./redis.js";
import { enqueueInvocation } from "./invocation-queue.js";
import { createSql } from "./sql.js";

const QUEUE_NAME = "arke-worker-schedules";

let queue: Queue | null = null;
let processor: BullWorker | null = null;

type JobData = {
  workerId: string;
  scheduledPrompt: string;
};

/**
 * Start the scheduler. Scans DB for workers with schedules and syncs them.
 * If Redis is not configured, logs a message and returns (scheduling disabled).
 */
export async function startScheduler(): Promise<void> {
  const redis = getRedis();
  if (!redis) {
    console.log("[scheduler] REDIS_URL not set — scheduling disabled");
    return;
  }

  queue = new Queue(QUEUE_NAME, { connection: redis });

  // Process scheduled jobs
  processor = new BullWorker<JobData>(
    QUEUE_NAME,
    async (job) => {
      const { workerId, scheduledPrompt } = job.data;
      console.log(`[scheduler] running worker ${workerId}`);

      // Check for overlapping runs — skip if already active
      const active = await queue!.getActive();
      const alreadyRunning = active.some(
        (j) => j.id !== job.id && j.data.workerId === workerId,
      );
      if (alreadyRunning) {
        console.log(`[scheduler] skipping ${workerId} — already running`);
        return { skipped: true };
      }

      // Look up owner_id for the invoker field
      const sql = createSql();
      const [workerRow] = await sql`SELECT owner_id, properties FROM actors WHERE id = ${workerId} LIMIT 1`;
      const ownerId = (workerRow as Record<string, unknown>)?.owner_id as string ?? workerId;
      const storeLogs = ((workerRow as Record<string, unknown>)?.properties as Record<string, unknown>)?.store_logs === true;

      // Route through shared invocation queue (handles DB recording)
      const { promise } = await enqueueInvocation(workerId, ownerId, "scheduler", scheduledPrompt, storeLogs);
      const result = await promise;

      console.log(
        `[scheduler] worker ${workerId} finished: success=${result.success}, iterations=${result.iterations}`,
      );

      return { success: result.success, result: result.result, iterations: result.iterations };
    },
    {
      connection: redis,
      concurrency: 3,
    },
  );

  processor.on("error", (err) => {
    console.error("[scheduler] worker error:", err.message);
  });

  // Sync existing schedules from DB
  await syncAllSchedules();
  console.log("[scheduler] started");
}

/**
 * Returns true if the scheduler is available (Redis connected, queue initialized).
 */
export function isSchedulerAvailable(): boolean {
  return queue !== null;
}

/**
 * Sync a single worker's schedule. Called when a worker is created/updated.
 * Pass schedule=null to remove the schedule.
 */
export async function syncWorkerSchedule(
  workerId: string,
  schedule: string | null,
  scheduledPrompt: string | null,
): Promise<void> {
  if (!queue) return; // Redis not available

  // Remove any existing repeatable for this worker
  const existing = await queue.getRepeatableJobs();
  const found = existing.find((r) => r.id === workerId);
  if (found) {
    await queue.removeRepeatableByKey(found.key);
  }

  // Add new schedule if provided
  if (schedule && scheduledPrompt) {
    await queue.add(
      "run-worker",
      { workerId, scheduledPrompt } satisfies JobData,
      {
        repeat: { pattern: schedule },
        jobId: workerId,
        removeOnComplete: { count: 20 },
        removeOnFail: { count: 10 },
        attempts: 2,
        backoff: { type: "exponential", delay: 30_000 },
      },
    );
    console.log(`[scheduler] scheduled ${workerId}: ${schedule}`);
  }
}

/**
 * Scan all active workers with schedules and sync them into BullMQ.
 */
async function syncAllSchedules(): Promise<void> {
  const sql = createSql();
  const rows = await sql`
    SELECT id, properties FROM actors
    WHERE kind = 'worker' AND status = 'active'
    AND properties->>'schedule' IS NOT NULL
  `;

  let count = 0;
  for (const row of rows as Array<{ id: string; properties: Record<string, unknown> }>) {
    const schedule = row.properties.schedule as string | undefined;
    const scheduledPrompt = row.properties.scheduled_prompt as string | undefined;
    if (schedule && scheduledPrompt) {
      await syncWorkerSchedule(row.id, schedule, scheduledPrompt);
      count++;
    }
  }

  if (count > 0) {
    console.log(`[scheduler] synced ${count} worker schedule(s)`);
  }
}

/**
 * Graceful shutdown.
 */
export async function stopScheduler(): Promise<void> {
  if (processor) {
    await processor.close();
    processor = null;
  }
  if (queue) {
    await queue.close();
    queue = null;
  }
  await closeRedis();
  console.log("[scheduler] stopped");
}
