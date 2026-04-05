/**
 * In-process concurrency-limited invocation queue.
 * All worker invocations (HTTP, scheduler, nested) flow through this module.
 * No external dependencies — works without Redis.
 *
 * Concurrency is determined by:
 * 1. MAX_CONCURRENT_WORKERS env var (explicit override, always wins)
 * 2. Auto-sized from available system memory if not set
 * 3. Dynamic memory pressure check before starting each worker
 */

import { cpus, totalmem, freemem, platform } from "node:os";
import { invokeWorker, type InvokeResult } from "./worker-invoke.js";
import {
  createInvocationRecord,
  createBatchInvocationRecords,
  markInvocationRunning,
  completeInvocation,
  cancelInvocation,
  cancelBatchRemaining,
  resetInvocationForRetry,
} from "./invocation-recorder.js";
import { generateUlid } from "./ids.js";
import { ApiError } from "./errors.js";
import { createSql } from "./sql.js";

interface QueueItem {
  invocationId: number;
  workerId: string;
  invokerId: string;
  prompt: string;
  storeLogs: boolean;
  depth: number;
  resolve: (result: InvokeResult) => void;
  reject: (err: Error) => void;
  batchId?: string;
  batchSeq?: number;
}

// Memory budget constants
const SYSTEM_RESERVE_MB = 512;    // Reserve for OS, Postgres, Node runtime
const WORKER_RESERVE_MB = 200;    // Conservative per-worker reservation (sandbox + overhead)
const MIN_FREE_MB = 256;          // Dynamic check: don't start a worker if free memory is below this
const MIN_CONCURRENT = 2;         // Always allow at least 2 concurrent workers
const MAX_CONCURRENT_CAP = 50;    // Absolute ceiling regardless of memory
const DEFAULT_MAX_RETRIES = 2;    // Allow up to 2 retries (3 total attempts)

let maxConcurrent = 5;
let maxQueueDepth = 50;
let running = 0;
let draining = false;
const pending: QueueItem[] = [];
const activePromises = new Set<Promise<void>>();

/**
 * Calculate max concurrent workers from system memory.
 * Formula: (totalMemory - systemReserve) / workerReserve, clamped to [MIN, MAX].
 */
function calculateMaxConcurrent(): number {
  const totalMb = totalmem() / (1024 * 1024);
  const available = totalMb - SYSTEM_RESERVE_MB;
  const calculated = Math.floor(available / WORKER_RESERVE_MB);
  return Math.min(MAX_CONCURRENT_CAP, Math.max(MIN_CONCURRENT, calculated));
}

/**
 * Check if there's enough free memory to start another worker.
 * Acts as a dynamic safety valve — even if we're under maxConcurrent,
 * we won't start a worker if the system is under memory pressure.
 *
 * On macOS, os.freemem() only reports "truly free" pages and ignores
 * purgeable/cached memory that's available under pressure, so the number
 * is misleadingly low. We skip the dynamic check there and rely on
 * the static maxConcurrent limit instead.
 */
function hasMemoryHeadroom(): boolean {
  if (platform() !== "linux") return true;
  const freeMb = freemem() / (1024 * 1024);
  return freeMb >= MIN_FREE_MB;
}

/**
 * Initialize the queue. Call once at startup after DB is ready.
 * Recovers orphaned queued/running invocations from a prior crash:
 * - Root invocations are retried (up to MAX_INVOCATION_RETRIES times)
 * - Child invocations are cancelled (the parent retry will re-create them)
 */
export async function initQueue(): Promise<void> {
  const envMax = Number(process.env.MAX_CONCURRENT_WORKERS);
  if (envMax > 0) {
    maxConcurrent = envMax;
  } else {
    maxConcurrent = calculateMaxConcurrent();
  }
  maxQueueDepth = Math.max(1, Number(process.env.MAX_QUEUE_DEPTH) || 50);
  draining = false;

  const maxRetries = Number(process.env.MAX_INVOCATION_RETRIES) || DEFAULT_MAX_RETRIES;
  const sql = createSql();

  try {
    // Find all orphaned invocations from prior crash
    const [, rows] = await sql.transaction([
      sql.query(`SELECT set_config('app.actor_is_admin', 'true', true)`, []),
      sql.query(
        `SELECT id, retry_count, parent_invocation_id
         FROM worker_invocations
         WHERE status IN ('queued', 'running')
         ORDER BY id`,
      ),
    ]);

    const orphans = rows as Array<{
      id: number;
      retry_count: number;
      parent_invocation_id: number | null;
    }>;

    let requeued = 0;
    let failed = 0;
    let cancelledChildren = 0;

    for (const row of orphans) {
      if (row.parent_invocation_id != null) {
        // Child invocations: cancel — the parent retry will re-create them
        await sql.transaction([
          sql.query(`SELECT set_config('app.actor_is_admin', 'true', true)`, []),
          sql.query(
            `UPDATE worker_invocations
             SET status = 'cancelled',
                 error_message = 'Parent invocation retried after server restart'
             WHERE id = $1`,
            [row.id],
          ),
        ]);
        cancelledChildren++;
      } else if (row.retry_count < maxRetries) {
        // Root invocations under retry limit: reset to queued
        await resetInvocationForRetry(row.id);
        requeued++;
      } else {
        // Root invocations over retry limit: mark as permanently failed
        await sql.transaction([
          sql.query(`SELECT set_config('app.actor_is_admin', 'true', true)`, []),
          sql.query(
            `UPDATE worker_invocations
             SET status = 'failed',
                 error_message = $1
             WHERE id = $2`,
            [`Server restarted — retry limit reached (${maxRetries} retries)`, row.id],
          ),
        ]);
        failed++;
      }
    }

    if (requeued > 0 || failed > 0 || cancelledChildren > 0) {
      console.log(
        `[queue] orphan recovery: ${requeued} requeued, ${failed} exceeded retry limit, ${cancelledChildren} children cancelled`,
      );
    }

    // Pick up all queued invocations (including just-reset ones) into the in-memory queue.
    // For batch items, only pick up items that are ready to run:
    //   - Non-batch items (batch_id IS NULL) are always ready
    //   - batch_seq=0 items are always ready (they start the chain)
    //   - batch_seq>0 items are ready only if their predecessor completed/failed
    const [, queuedRows] = await sql.transaction([
      sql.query(`SELECT set_config('app.actor_is_admin', 'true', true)`, []),
      sql.query(
        `SELECT w.id, w.worker_id, w.invoker_id, w.prompt, w.depth,
                w.batch_id, w.batch_seq
         FROM worker_invocations w
         WHERE w.status = 'queued'
           AND (
             w.batch_id IS NULL
             OR w.batch_seq = 0
             OR EXISTS (
               SELECT 1 FROM worker_invocations prev
               WHERE prev.batch_id = w.batch_id
                 AND prev.batch_seq = w.batch_seq - 1
                 AND prev.status IN ('completed', 'failed')
             )
           )
         ORDER BY w.id`,
      ),
    ]);

    const queued = queuedRows as Array<{
      id: number;
      worker_id: string;
      invoker_id: string;
      prompt: string;
      depth: number;
      batch_id: string | null;
      batch_seq: number | null;
    }>;

    for (const row of queued) {
      requeueInvocation(
        row.id, row.worker_id, row.invoker_id, row.prompt, row.depth,
        row.batch_id ?? undefined, row.batch_seq ?? undefined,
      );
    }

    if (queued.length > 0) {
      console.log(`[queue] picked up ${queued.length} queued invocations`);
    }
  } catch (err) {
    console.error("[queue] orphan recovery failed:", err instanceof Error ? err.message : err);
  }

  const totalMb = Math.round(totalmem() / (1024 * 1024));
  const freeMb = Math.round(freemem() / (1024 * 1024));
  console.log(
    `[queue] initialized (max_concurrent=${maxConcurrent}, max_queue_depth=${maxQueueDepth}, ` +
    `system_memory=${totalMb}MB, free=${freeMb}MB` +
    `${envMax > 0 ? ", explicit override" : ", auto-sized"})`,
  );
}

export interface EnqueueResult {
  invocationId: number;
  promise: Promise<InvokeResult>;
}

/**
 * Enqueue a worker invocation. Creates a DB record and either starts
 * immediately or queues for later execution.
 *
 * Returns the invocation ID (for 202 response) and a promise that
 * resolves when execution completes (for ?wait=true or scheduler use).
 *
 * Throws if the queue is full (503) or draining.
 */
export async function enqueueInvocation(
  workerId: string,
  invokerId: string,
  source: "http" | "scheduler",
  prompt: string,
  storeLogs = true,
  parentInvocationId?: number | null,
  depth = 0,
): Promise<EnqueueResult> {
  if (draining) {
    throw new ApiError(503, "server_shutting_down", "Server is shutting down");
  }

  if (pending.length >= maxQueueDepth) {
    throw new ApiError(503, "queue_full", "Invocation queue is full — try again later");
  }

  const maxDepth = Number(process.env.MAX_INVOCATION_DEPTH) || 5;
  if (depth > maxDepth) {
    throw new ApiError(
      400,
      "max_depth_exceeded",
      `Invocation depth ${depth} exceeds maximum of ${maxDepth}`,
    );
  }

  const invocationId = await createInvocationRecord(
    workerId, invokerId, source, prompt, parentInvocationId, depth,
  );

  const { promise, resolve, reject } = createDeferred<InvokeResult>();

  const item: QueueItem = {
    invocationId,
    workerId,
    invokerId,
    prompt,
    storeLogs,
    depth,
    resolve,
    reject,
  };

  if (canStartNow()) {
    startItem(item);
  } else {
    pending.push(item);
  }

  return { invocationId, promise };
}

export interface EnqueueBatchResult {
  batchId: string;
  invocations: Array<{ invocationId: number; batchSeq: number }>;
}

/**
 * Enqueue a sequential batch. Creates all DB records in one transaction,
 * then enqueues only the first item (batch_seq=0). Each completion chains the next.
 */
export async function enqueueBatch(
  items: Array<{ workerId: string; prompt: string; storeLogs?: boolean }>,
  invokerId: string,
  source: "http" | "scheduler",
  onFail: "continue" | "cancel",
): Promise<EnqueueBatchResult> {
  if (draining) {
    throw new ApiError(503, "server_shutting_down", "Server is shutting down");
  }
  if (pending.length >= maxQueueDepth) {
    throw new ApiError(503, "queue_full", "Invocation queue is full — try again later");
  }

  const batchId = generateUlid();
  const ids = await createBatchInvocationRecords(items, invokerId, source, batchId, onFail);

  // Only enqueue the first item into the in-memory queue
  const first = items[0];
  const { resolve, reject } = createDeferred<InvokeResult>();
  const item: QueueItem = {
    invocationId: ids[0],
    workerId: first.workerId,
    invokerId,
    prompt: first.prompt,
    storeLogs: first.storeLogs !== false,
    depth: 0,
    resolve,
    reject,
    batchId,
    batchSeq: 0,
  };

  if (canStartNow()) {
    startItem(item);
  } else {
    pending.push(item);
  }

  return {
    batchId,
    invocations: ids.map((id, seq) => ({ invocationId: id, batchSeq: seq })),
  };
}

/**
 * Get the queue position for a given invocation ID.
 * Returns null if not in the pending queue.
 */
export function getQueuePosition(invocationId: number): number | null {
  const idx = pending.findIndex((item) => item.invocationId === invocationId);
  return idx >= 0 ? idx + 1 : null;
}

/**
 * Get current queue statistics.
 */
export function getQueueStats(): {
  running: number;
  queued: number;
  maxConcurrent: number;
  maxQueueDepth: number;
  freeMemoryMb: number;
} {
  return {
    running,
    queued: pending.length,
    maxConcurrent,
    maxQueueDepth,
    freeMemoryMb: Math.round(freemem() / (1024 * 1024)),
  };
}

/**
 * Drain the queue for graceful shutdown.
 * Cancels all pending items and waits for running invocations to finish.
 */
export async function drainQueue(): Promise<void> {
  draining = true;
  console.log(`[queue] draining (${running} running, ${pending.length} pending)`);

  // Reject in-memory promises but leave DB status as 'queued'.
  // On next startup, initQueue() will pick them up without burning a retry.
  while (pending.length > 0) {
    const item = pending.shift()!;
    item.reject(new Error("Server shutting down"));
  }

  // Wait for all running invocations to finish
  if (activePromises.size > 0) {
    await Promise.allSettled([...activePromises]);
  }

  console.log("[queue] drained");
}

// --- Internal ---

/**
 * Check if we can start a new worker right now.
 * Two conditions: under concurrent limit AND enough free memory.
 */
function canStartNow(): boolean {
  if (running >= maxConcurrent) return false;
  if (!hasMemoryHeadroom()) {
    console.warn(
      `[queue] memory pressure — ${Math.round(freemem() / (1024 * 1024))}MB free, ` +
      `need ${MIN_FREE_MB}MB. Deferring worker start.`,
    );
    return false;
  }
  return true;
}

function startItem(item: QueueItem): void {
  running++;
  markInvocationRunning(item.invocationId, item.invokerId);

  const p = executeItem(item);
  activePromises.add(p);
  p.finally(() => {
    activePromises.delete(p);
  });
}

async function executeItem(item: QueueItem): Promise<void> {
  let result: InvokeResult | undefined;
  try {
    result = await invokeWorker(item.workerId, item.prompt, {
      invocationId: item.invocationId,
      depth: item.depth,
    });
    completeInvocation(item.invocationId, item.invokerId, result, item.storeLogs);
    item.resolve(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result = {
      success: false,
      result: { error: msg },
      iterations: 0,
      log: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, llmCalls: 0, toolCalls: 0 },
      logLevel: "full",
      startedAt: new Date(),
      completedAt: new Date(),
      errorMessage: msg,
    };
    completeInvocation(item.invocationId, item.invokerId, result, false);
    item.resolve(result);
  } finally {
    // Chain next batch item before decrementing — advanceBatch enqueues
    // into pending[], so tryRunNext() will pick it up below.
    if (item.batchId != null && item.batchSeq != null) {
      await advanceBatch(item.batchId, item.batchSeq, item.invokerId, result!);
    }
    running--;
    tryRunNext();
  }
}

function tryRunNext(): void {
  if (draining || pending.length === 0) return;
  if (!canStartNow()) return;
  const next = pending.shift()!;
  startItem(next);
}

/**
 * Advance a sequential batch after an item completes.
 * If on_fail='cancel' and the item failed, cancels all remaining items.
 * Otherwise, enqueues the next item (batch_seq + 1) into the in-memory queue.
 */
async function advanceBatch(
  batchId: string,
  completedSeq: number,
  invokerId: string,
  result: InvokeResult,
): Promise<void> {
  const sql = createSql();

  // Check on_fail policy from the completed item
  const [, policyRows] = await sql.transaction([
    sql.query(`SELECT set_config('app.actor_is_admin', 'true', true)`, []),
    sql.query(
      `SELECT batch_on_fail FROM worker_invocations
       WHERE batch_id = $1 AND batch_seq = $2`,
      [batchId, completedSeq],
    ),
  ]);
  const onFail = (policyRows as Array<{ batch_on_fail: string }>)[0]?.batch_on_fail ?? "continue";

  if (!result.success && onFail === "cancel") {
    cancelBatchRemaining(batchId, completedSeq, invokerId);
    console.log(`[queue] batch ${batchId}: cancelled remaining after seq ${completedSeq} failed`);
    return;
  }

  // Find and enqueue the next item
  const [, nextRows] = await sql.transaction([
    sql.query(`SELECT set_config('app.actor_is_admin', 'true', true)`, []),
    sql.query(
      `SELECT id, worker_id, invoker_id, prompt, batch_seq
       FROM worker_invocations
       WHERE batch_id = $1 AND batch_seq = $2 AND status = 'queued'`,
      [batchId, completedSeq + 1],
    ),
  ]);

  const next = (nextRows as Array<{
    id: number;
    worker_id: string;
    invoker_id: string;
    prompt: string;
    batch_seq: number;
  }>)[0];

  if (!next) return; // No more items in batch

  const { resolve, reject } = createDeferred<InvokeResult>();
  const item: QueueItem = {
    invocationId: next.id,
    workerId: next.worker_id,
    invokerId: next.invoker_id,
    prompt: next.prompt,
    storeLogs: true,
    depth: 0,
    resolve,
    reject,
    batchId,
    batchSeq: next.batch_seq,
  };

  // Push to pending — tryRunNext() in the caller's finally block will start it
  pending.push(item);
  console.log(`[queue] batch ${batchId}: enqueued seq ${next.batch_seq}`);
}

/**
 * Re-queue an existing invocation from DB into the in-memory queue.
 * Used at startup to pick up orphaned invocations.
 * Does NOT create a new DB record — reuses the existing one.
 */
function requeueInvocation(
  invocationId: number,
  workerId: string,
  invokerId: string,
  prompt: string,
  depth: number,
  batchId?: string,
  batchSeq?: number,
): void {
  const { resolve, reject } = createDeferred<InvokeResult>();

  const item: QueueItem = {
    invocationId,
    workerId,
    invokerId,
    prompt,
    storeLogs: true,
    depth,
    resolve,
    reject,
    batchId,
    batchSeq,
  };

  if (canStartNow()) {
    startItem(item);
  } else {
    pending.push(item);
  }
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
