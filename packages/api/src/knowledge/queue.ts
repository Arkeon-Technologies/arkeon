/**
 * Postgres-backed knowledge extraction job queue.
 * Dispatches jobs to typed handlers based on job_type.
 *
 * Job types use dot-namespaced convention:
 *   "ingest"             — router, inspects entity and fans out
 *   "text.extract"       — extract from small text
 *   "text.chunk_extract" — extract from one chunk of a large text
 *   "pdf.extract"        — parse PDF, create page entities, fan out
 *   "pdf.page_group"     — extract from a group of PDF pages
 *   "pptx.extract"       — parse PPTX, create slide entities, fan out
 *   "pptx.slide_group"   — extract from a group of PPTX slides
 *
 * Adding new content types (image, etc.) = registering new handlers.
 */

import { createSql, type SqlClient } from "../lib/sql";
import { createAdminSql } from "./lib/admin-sql";
import { generateUlid } from "../lib/ids";
import { getExtractionConfig } from "./lib/config";
import { clearJobSeq } from "./lib/logger";
import { handleIngest } from "./pipeline/ingest";
import { handleTextExtract } from "./pipeline/text-extract";
import { handleTextChunkExtract } from "./pipeline/text-chunk-extract";
import { handlePdfExtract } from "./pipeline/pdf-extract";
import { handlePdfPageGroup } from "./pipeline/pdf-page-group";
import { handlePptxExtract } from "./pipeline/pptx-extract";
import { handlePptxSlideGroup } from "./pipeline/pptx-slide-group";

const POLL_INTERVAL_MS = 2_000;
const JOB_TIMEOUT_MS = 300_000; // 5 minutes
let maxConcurrency = Number(process.env.MAX_KNOWLEDGE_CONCURRENCY) || 10;

let running = 0;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let drainResolve: (() => void) | null = null;
let stopped = false;

// ---------------------------------------------------------------------------
// Handler registry
// ---------------------------------------------------------------------------

export type JobRecord = Record<string, unknown>;

export type JobHandler = (job: JobRecord, sql: SqlClient) => Promise<void>;

const handlers: Record<string, JobHandler> = {
  "ingest":             handleIngest,
  "text.extract":       handleTextExtract,
  "text.chunk_extract": handleTextChunkExtract,
  "pdf.extract":        handlePdfExtract,
  "pdf.page_group":     handlePdfPageGroup,
  "pptx.extract":       handlePptxExtract,
  "pptx.slide_group":   handlePptxSlideGroup,
};

// ---------------------------------------------------------------------------
// Job creation
// ---------------------------------------------------------------------------

export async function createJob(opts: {
  entityId: string;
  entityVer: number;
  trigger: "manual" | "poller" | "system";
  triggeredBy?: string;
  jobType?: string;
  parentJobId?: string;
  metadata?: Record<string, unknown>;
}): Promise<string | null> {
  const sql = await createAdminSql();
  const id = generateUlid();

  try {
    await sql.query(
      `INSERT INTO knowledge_jobs (id, entity_id, entity_ver, status, trigger, triggered_by, job_type, parent_job_id, metadata, created_at)
       VALUES ($1, $2, $3, 'pending', $4, $5, $6, $7, $8, NOW())`,
      [
        id,
        opts.entityId,
        opts.entityVer,
        opts.trigger,
        opts.triggeredBy ?? null,
        opts.jobType ?? "ingest",
        opts.parentJobId ?? null,
        opts.metadata ? JSON.stringify(opts.metadata) : null,
      ],
    );
    return id;
  } catch (err: any) {
    if (err?.code === "23505") return null; // duplicate
    throw err;
  }
}

/**
 * Set a job's status (used by handlers to mark parent as "waiting", etc.)
 */
export async function setJobStatus(
  jobId: string,
  status: string,
  extra?: { result?: unknown; error?: string; model?: string; tokens_in?: number; tokens_out?: number; llm_calls?: number },
): Promise<void> {
  const sql = await createAdminSql();
  const sets = [`status = $2`];
  const params: unknown[] = [jobId, status];

  if (status === "completed" || status === "failed") {
    params.push(new Date().toISOString());
    sets.push(`completed_at = $${params.length}::timestamptz`);
  }
  if (extra?.result !== undefined) {
    params.push(JSON.stringify(extra.result));
    sets.push(`result = $${params.length}`);
  }
  if (extra?.error !== undefined) {
    params.push(extra.error);
    sets.push(`error = $${params.length}`);
  }
  if (extra?.model !== undefined) {
    params.push(extra.model);
    sets.push(`model = $${params.length}`);
  }
  if (extra?.tokens_in !== undefined) {
    params.push(extra.tokens_in);
    sets.push(`tokens_in = $${params.length}`);
  }
  if (extra?.tokens_out !== undefined) {
    params.push(extra.tokens_out);
    sets.push(`tokens_out = $${params.length}`);
  }
  if (extra?.llm_calls !== undefined) {
    params.push(extra.llm_calls);
    sets.push(`llm_calls = $${params.length}`);
  }

  await sql.query(`UPDATE knowledge_jobs SET ${sets.join(", ")} WHERE id = $1`, params);
}

/**
 * Try to finalize a parent job. Called by child handlers when they complete.
 * If all children are done, aggregates results onto the parent.
 */
export async function tryFinalizeParent(parentJobId: string): Promise<void> {
  const sql = await createAdminSql();

  const [parent] = await sql.query(
    `SELECT id, status, job_type, metadata, parent_job_id FROM knowledge_jobs WHERE id = $1`,
    [parentJobId],
  );
  if (!parent || parent.status !== "waiting") return;

  // Count children
  const [counts] = await sql.query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
       COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
       COUNT(*)::int AS total
     FROM knowledge_jobs WHERE parent_job_id = $1`,
    [parentJobId],
  );

  const completed = counts.completed as number;
  const failed = counts.failed as number;
  const total = counts.total as number;

  if (completed + failed < total) return; // still pending/processing children

  if (failed > 0 && completed === 0) {
    // All children failed
    await setJobStatus(parentJobId, "failed", { error: `All ${failed} child jobs failed` });
    return;
  }

  // Aggregate child results onto parent
  const children = await sql.query(
    `SELECT result, model, tokens_in, tokens_out, llm_calls
     FROM knowledge_jobs WHERE parent_job_id = $1 AND status = 'completed'
     ORDER BY created_at`,
    [parentJobId],
  );

  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let totalLlmCalls = 0;
  let model = "";
  let totalCreatedEntities = 0;
  let totalCreatedRels = 0;

  for (const child of children) {
    totalTokensIn += (child.tokens_in as number) ?? 0;
    totalTokensOut += (child.tokens_out as number) ?? 0;
    totalLlmCalls += (child.llm_calls as number) ?? 0;
    if (!model && child.model) model = child.model as string;
    const r = child.result as Record<string, unknown> | null;
    if (r) {
      totalCreatedEntities += (r.createdEntities as number) ?? 0;
      totalCreatedRels += (r.createdRelationships as number) ?? 0;
    }
  }

  await setJobStatus(parentJobId, "completed", {
    result: {
      createdEntities: totalCreatedEntities,
      createdRelationships: totalCreatedRels,
      childJobs: total,
      childJobsFailed: failed,
    },
    model,
    tokens_in: totalTokensIn,
    tokens_out: totalTokensOut,
    llm_calls: totalLlmCalls,
  });

  // Propagate up the parent chain for 3-level hierarchies
  if (parent.parent_job_id) {
    await tryFinalizeParent(parent.parent_job_id as string);
  }
}

// ---------------------------------------------------------------------------
// Poll loop
// ---------------------------------------------------------------------------

async function pollAndProcess(): Promise<void> {
  try {
    const config = await getExtractionConfig();
    maxConcurrency = config.max_concurrency;
  } catch {}

  const available = maxConcurrency - running;
  if (stopped || available <= 0) return;

  const sql = await createAdminSql();

  // Claim pending jobs (exclude 'waiting' — those are parent jobs awaiting children)
  const jobs = await sql.query(
    `UPDATE knowledge_jobs
     SET status = 'processing', started_at = NOW(), attempts = attempts + 1
     WHERE id IN (
       SELECT id FROM knowledge_jobs
       WHERE status = 'pending'
       ORDER BY created_at
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, entity_id, entity_ver, trigger, job_type, parent_job_id, metadata, attempts, max_attempts`,
    [available],
  );

  for (const job of jobs) {
    running++;
    processJob(sql, job);
  }
}

function processJob(sql: SqlClient, job: JobRecord): void {
  const jobId = job.id as string;
  const jobType = job.job_type as string;

  const handler = handlers[jobType];
  if (!handler) {
    console.error(`[knowledge:queue] Unknown job type: ${jobType}`);
    setJobStatus(jobId, "failed", { error: `Unknown job type: ${jobType}` })
      .finally(() => { running--; });
    return;
  }

  console.log(`[knowledge:queue] Processing ${jobType} job ${jobId}`);

  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("Job processing timeout (5 minutes)")), JOB_TIMEOUT_MS),
  );

  Promise.race([handler(job, sql), timeoutPromise]).then(async () => {
    // Handler is responsible for setting its own status
  }).catch(async (err) => {
    const message = err instanceof Error ? err.message : String(err);
    const attempts = job.attempts as number;
    const maxAttempts = job.max_attempts as number;

    if (attempts < maxAttempts) {
      await setJobStatus(jobId, "pending", { error: message });
      console.warn(`[knowledge:queue] Job ${jobId} failed (attempt ${attempts}/${maxAttempts}), will retry: ${message}`);
    } else {
      await setJobStatus(jobId, "failed", { error: message });
      console.error(`[knowledge:queue] Job ${jobId} failed permanently: ${message}`);
    }
  }).finally(() => {
    clearJobSeq(jobId);
    running--;
    if (running === 0 && drainResolve) {
      drainResolve();
      drainResolve = null;
    }
  });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export function initKnowledgeQueue(): void {
  if (pollTimer) return;
  stopped = false;

  createAdminSql().then((sql) =>
    sql.query(
      `UPDATE knowledge_jobs
       SET status = 'pending'
       WHERE status = 'processing'
         AND attempts < max_attempts`,
      [],
    ),
  ).then((rows) => {
    if (rows.length > 0) {
      console.log(`[knowledge:queue] Recovered ${rows.length} stuck jobs`);
    }
  }).catch((err: unknown) => {
    console.error(`[knowledge:queue] Failed to recover stuck jobs:`, err);
  });

  pollTimer = setInterval(() => {
    pollAndProcess().catch((err) => {
      console.error(`[knowledge:queue] Poll error:`, err);
    });
  }, POLL_INTERVAL_MS);

  console.log(`[knowledge:queue] Started (concurrency: ${maxConcurrency}, poll: ${POLL_INTERVAL_MS}ms)`);
}

export async function drainKnowledgeQueue(): Promise<void> {
  stopped = true;
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  if (running > 0) {
    console.log(`[knowledge:queue] Draining ${running} in-flight jobs...`);
    await new Promise<void>((resolve) => {
      drainResolve = resolve;
    });
  }

  console.log("[knowledge:queue] Drained");
}
