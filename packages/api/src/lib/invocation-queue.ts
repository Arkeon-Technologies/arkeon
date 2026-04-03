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
  markInvocationRunning,
  completeInvocation,
  cancelInvocation,
} from "./invocation-recorder.js";
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
}

// Memory budget constants
const SYSTEM_RESERVE_MB = 512;    // Reserve for OS, Postgres, Node runtime
const WORKER_RESERVE_MB = 200;    // Conservative per-worker reservation (sandbox + overhead)
const MIN_FREE_MB = 256;          // Dynamic check: don't start a worker if free memory is below this
const MIN_CONCURRENT = 2;         // Always allow at least 2 concurrent workers
const MAX_CONCURRENT_CAP = 50;    // Absolute ceiling regardless of memory

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
 * Cleans up any orphaned queued/running invocations from a prior crash.
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

  const sql = createSql();
  try {
    await sql.transaction([
      sql.query(`SELECT set_config('app.actor_is_admin', 'true', true)`, []),
      sql.query(
        `UPDATE worker_invocations
         SET status = 'failed', error_message = 'Server restarted'
         WHERE status IN ('queued', 'running')`,
      ),
    ]);
  } catch (err) {
    console.error("[queue] orphan cleanup failed:", err instanceof Error ? err.message : err);
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

  // Cancel all pending items
  while (pending.length > 0) {
    const item = pending.shift()!;
    cancelInvocation(item.invocationId, item.invokerId);
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
  try {
    const result = await invokeWorker(item.workerId, item.prompt, {
      invocationId: item.invocationId,
      depth: item.depth,
    });
    completeInvocation(item.invocationId, item.invokerId, result, item.storeLogs);
    item.resolve(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const failResult: InvokeResult = {
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
    completeInvocation(item.invocationId, item.invokerId, failResult, false);
    item.resolve(failResult);
  } finally {
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
