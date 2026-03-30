/**
 * Shared Redis connection for BullMQ worker scheduling.
 * Returns null if REDIS_URL is not configured (scheduling disabled).
 */

import IORedis from "ioredis";

let _redis: IORedis | null | undefined;

export function getRedis(): IORedis | null {
  if (_redis !== undefined) return _redis;

  const url = process.env.REDIS_URL;
  if (!url) {
    _redis = null;
    return null;
  }

  _redis = new IORedis(url, {
    maxRetriesPerRequest: null, // Required by BullMQ
  });

  _redis.on("error", (err) => {
    console.error("[redis] connection error:", err.message);
  });

  return _redis;
}

export async function closeRedis(): Promise<void> {
  if (_redis) {
    await _redis.quit();
    _redis = undefined;
  }
}
