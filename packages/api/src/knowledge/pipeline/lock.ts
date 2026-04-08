/**
 * Mutex for the write section of the pipeline.
 * Serializes graph writes so each job sees entities written by prior jobs.
 *
 * NOTE: This lock is process-local (in-memory promise chain). It does NOT
 * protect across multiple API instances. The knowledge extraction pipeline
 * must run on a single instance, or be upgraded to use pg_advisory_lock
 * for cross-process safety.
 */

let resolveWriteLock: Promise<void> = Promise.resolve();

export function withResolveWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = resolveWriteLock;
  let release: () => void;
  resolveWriteLock = new Promise<void>((r) => { release = r; });
  return prev.then(fn).finally(() => release!());
}
