// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * RequestPool — concurrency limiter + in-flight deduplication for API requests.
 *
 * Prevents the browser from being flooded with hundreds of concurrent requests
 * by queueing them behind a semaphore, and deduplicates identical in-flight
 * requests so the same entity/tip isn't fetched twice simultaneously.
 */
export class RequestPool {
  private inflight = 0;
  private readonly maxConcurrent: number;
  private readonly queue: Array<() => void> = [];
  private readonly dedupMap = new Map<string, Promise<unknown>>();

  constructor(maxConcurrent: number = 8) {
    this.maxConcurrent = maxConcurrent;
  }

  /**
   * Execute an async function with concurrency limiting.
   * If dedupKey is provided and a request with the same key is already in-flight,
   * returns the existing promise instead of starting a new request.
   */
  async execute<T>(fn: () => Promise<T>, dedupKey?: string): Promise<T> {
    if (dedupKey) {
      const existing = this.dedupMap.get(dedupKey);
      if (existing) {
        return existing as Promise<T>;
      }
    }

    const promise = this.acquireAndRun(fn);

    if (dedupKey) {
      this.dedupMap.set(dedupKey, promise);
      promise.finally(() => {
        this.dedupMap.delete(dedupKey);
      });
    }

    return promise;
  }

  private async acquireAndRun<T>(fn: () => Promise<T>): Promise<T> {
    if (this.inflight >= this.maxConcurrent) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.inflight++;
    try {
      return await fn();
    } finally {
      this.inflight--;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}
