// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Persistent dedup sweeper.
 *
 * Replaces the old time-windowed `consolidate` job with a background worker
 * that reads `knowledge_dedup_queue` in FIFO order, searches each entity for
 * candidate duplicates already in its space, and — when the LLM judges them
 * the same real-world thing — merges the new entity INTO the existing one.
 *
 * Design invariants:
 *   - "New → existing" only. The LLM picks which existing candidate (if any)
 *     the new entity matches. The new entity is always the merge source, the
 *     existing candidate is always the target. Entity ULIDs never change on
 *     dedup, so relationships stay valid.
 *   - No candidates → no LLM call. The cheap fast path.
 *   - Zero-to-one LLM call per entity. Bounded cost.
 *   - Rate-limited globally so bursty ingestion cannot outrun the model.
 *
 * The loop is a single in-process worker. Per-space parallelism is a
 * follow-up — day-one this is one worker processing FIFO across all spaces.
 */

import { withAdminSql } from "./lib/admin-sql";
import { LlmClient } from "./lib/llm";
import { resolveLlmConfig } from "./lib/config";
import { search, submitOpsEnvelope, type OpsEnvelopeInput } from "./lib/arke-client";
import { normalizeLabel } from "./lib/normalize";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const IDLE_SLEEP_MS = 30_000; // back off when queue is empty
const CANDIDATE_LIMIT = 5;
const DESC_SNIPPET_CHARS = 160;
const MAX_ATTEMPTS = 3;
const SKIP_TYPES = new Set(["document", "text_chunk"]);

// Global rate limit — max LLM calls per minute across all workers.
const RATE_PER_MIN = Number(process.env.DEDUP_LLM_RATE_PER_MIN) || 60;

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let running = false;
let shuttingDown = false;
let workerPromise: Promise<void> | null = null;

// ---------------------------------------------------------------------------
// Rate limiter — minimal token bucket: allow N calls per minute.
// ---------------------------------------------------------------------------

const rateLimiter = (() => {
  const windowMs = 60_000;
  const calls: number[] = []; // timestamps (ms)
  return {
    async wait(): Promise<void> {
      while (true) {
        const now = Date.now();
        while (calls.length > 0 && calls[0]! < now - windowMs) calls.shift();
        if (calls.length < RATE_PER_MIN) {
          calls.push(now);
          return;
        }
        const oldest = calls[0]!;
        const sleep = Math.max(50, oldest + windowMs - now);
        await new Promise((r) => setTimeout(r, sleep));
      }
    },
  };
})();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface QueueRow {
  entity_id: string;
  space_id: string;
  attempts: number;
}

interface EntitySnapshot {
  id: string;
  type: string;
  label: string;
  description: string;
  space_id: string;
}

interface Candidate {
  id: string;
  type: string;
  label: string;
  description: string;
}

// ---------------------------------------------------------------------------
// Queue access
// ---------------------------------------------------------------------------

/** Claim the oldest pending row atomically; returns null if the queue is empty. */
async function claimNext(): Promise<QueueRow | null> {
  return withAdminSql(async (sql) => {
    const rows = (await sql.query(
      `UPDATE knowledge_dedup_queue
       SET status = 'processing',
           started_at = NOW(),
           attempts = attempts + 1
       WHERE entity_id = (
         SELECT entity_id FROM knowledge_dedup_queue
         WHERE status = 'pending'
         ORDER BY enqueued_at ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING entity_id, space_id, attempts`,
      [],
    )) as Array<Record<string, unknown>>;
    const row = rows[0];
    if (!row) return null;
    return {
      entity_id: row.entity_id as string,
      space_id: row.space_id as string,
      attempts: row.attempts as number,
    };
  });
}

async function markDone(entityId: string, result: Record<string, unknown>): Promise<void> {
  await withAdminSql(async (sql) => {
    await sql.query(
      `UPDATE knowledge_dedup_queue
       SET status = 'done', completed_at = NOW(), result = $2::jsonb, last_error = NULL
       WHERE entity_id = $1`,
      [entityId, JSON.stringify(result)],
    );
  });
}

async function markSkipped(entityId: string, reason: string): Promise<void> {
  await withAdminSql(async (sql) => {
    await sql.query(
      `UPDATE knowledge_dedup_queue
       SET status = 'skipped', completed_at = NOW(), result = $2::jsonb
       WHERE entity_id = $1`,
      [entityId, JSON.stringify({ reason })],
    );
  });
}

async function markFailed(entityId: string, error: string, attempts: number): Promise<void> {
  // If we've exhausted retries, park as 'failed'. Otherwise kick back to
  // 'pending' so a later iteration can try again.
  const status = attempts >= MAX_ATTEMPTS ? "failed" : "pending";
  await withAdminSql(async (sql) => {
    await sql.query(
      `UPDATE knowledge_dedup_queue
       SET status = $2, last_error = $3, completed_at = CASE WHEN $2 = 'failed' THEN NOW() ELSE completed_at END
       WHERE entity_id = $1`,
      [entityId, status, error.slice(0, 500)],
    );
  });
}

// ---------------------------------------------------------------------------
// Entity snapshot
// ---------------------------------------------------------------------------

async function loadEntity(entityId: string): Promise<EntitySnapshot | null> {
  return withAdminSql(async (sql) => {
    // Full admin context — RLS on entities otherwise silently filters rows
    // out even though withAdminSql sets is_admin. Policies check actor_id
    // and read_level; we need both.
    await sql`SELECT set_config('app.actor_id', 'SYSTEM', true)`;
    await sql`SELECT set_config('app.actor_read_level', '4', true)`;
    const rows = (await sql.query(
      `SELECT e.id,
              e.type,
              e.properties->>'label' AS label,
              left(e.properties->>'description', ${DESC_SNIPPET_CHARS}) AS description,
              (SELECT se.space_id
                 FROM space_entities se
                 WHERE se.entity_id = e.id
                 LIMIT 1) AS space_id
       FROM entities e
       WHERE e.id = $1 AND e.kind = 'entity'`,
      [entityId],
    )) as Array<Record<string, unknown>>;
    if (rows.length === 0) return null;
    const r = rows[0]!;
    return {
      id: r.id as string,
      type: (r.type as string) ?? "unknown",
      label: (r.label as string) ?? "",
      description: (r.description as string) ?? "",
      space_id: (r.space_id as string) ?? "",
    };
  });
}

// ---------------------------------------------------------------------------
// LLM judge
// ---------------------------------------------------------------------------

const JUDGE_SYSTEM_PROMPT = `You are deciding whether a new entity in a knowledge graph is the same real-world thing as any of the candidate entities already in the graph.

Reply with JSON:
  { "same_as": "<ULID of one candidate>" }      if the new entity refers to the same real-world thing as one candidate
  { "same_as": null }                           if the new entity is distinct from all candidates

Rules:
- Different types do NOT preclude a match. The same book may appear once as "work" and again as "literary_work"; the same person as "person" and "philosopher_or_author". Use label + description to judge identity, not type.
- Accent, case, punctuation, and word-order variants of the same name are matches ("René Girard" = "Rene Girard"; "Gospel of Matthew" = "Matthew (Gospel)").
- Morphological variants for the same concept are matches ("Scapegoat Mechanism" = "Scapegoating Mechanism").
- A thing and an event about it are NOT the same ("Einstein" ≠ "Einstein wins Nobel Prize").
- A thing and a thing that shares some words but is distinct are NOT the same ("United States" ≠ "United Nations").
- When genuinely uncertain, prefer { "same_as": null }. A duplicate surviving is cheap; a wrong merge is costly.`;

interface JudgeDecision {
  same_as: string | null;
}

async function llmJudge(
  llm: LlmClient,
  entity: EntitySnapshot,
  candidates: Candidate[],
): Promise<{ decision: JudgeDecision; tokensIn: number; tokensOut: number; model: string }> {
  const userPayload = {
    new_entity: {
      id: entity.id,
      label: entity.label,
      type: entity.type,
      description: entity.description,
    },
    candidates: candidates.map((c) => ({
      id: c.id,
      label: c.label,
      type: c.type,
      description: c.description,
    })),
  };

  const result = await llm.chatJson<{ same_as: string | null }>(
    JUDGE_SYSTEM_PROMPT,
    JSON.stringify(userPayload),
    { maxTokens: 100 },
  );

  // Validate: if the LLM returned a value, it must match one of the candidate IDs.
  let sameAs = result.data?.same_as;
  if (sameAs && typeof sameAs === "string") {
    const candidateIds = new Set(candidates.map((c) => c.id));
    if (!candidateIds.has(sameAs)) sameAs = null; // LLM hallucinated an ID
  } else {
    sameAs = null;
  }

  return {
    decision: { same_as: sameAs },
    tokensIn: result.usage.tokensIn,
    tokensOut: result.usage.tokensOut,
    model: result.usage.model,
  };
}

// ---------------------------------------------------------------------------
// Merge submission
// ---------------------------------------------------------------------------

async function submitMerge(targetId: string, sourceId: string): Promise<void> {
  const envelope: OpsEnvelopeInput = {
    format: "arke.ops/v1",
    ops: [
      { op: "merge", target: targetId, sources: [sourceId] },
    ],
  };
  await submitOpsEnvelope(envelope);
}

// ---------------------------------------------------------------------------
// Core: process one queued entity
// ---------------------------------------------------------------------------

async function processEntity(row: QueueRow, llm: LlmClient): Promise<void> {
  const entity = await loadEntity(row.entity_id);

  if (!entity) {
    await markSkipped(row.entity_id, "entity no longer exists (likely merged away)");
    return;
  }
  if (SKIP_TYPES.has(entity.type)) {
    await markSkipped(row.entity_id, `type=${entity.type}`);
    return;
  }
  if (!entity.label || entity.label.length === 0) {
    await markSkipped(row.entity_id, "no label");
    return;
  }
  if (!entity.space_id) {
    await markSkipped(row.entity_id, "no space membership");
    return;
  }

  // Search Meilisearch for label-matching candidates in the same space.
  const rawHits = await search(normalizeLabel(entity.label), {
    space_id: entity.space_id,
    limit: CANDIDATE_LIMIT + 1, // +1 in case one of the hits is the entity itself
    search_on: "label",
  });

  const candidates: Candidate[] = [];
  for (const hit of rawHits) {
    const hitId = hit.id as string | undefined;
    if (!hitId || hitId === entity.id) continue;
    if (hit.kind === "relationship") continue;
    const hitType = (hit.type as string) ?? "unknown";
    if (SKIP_TYPES.has(hitType)) continue;
    const label = (hit.properties?.label as string) ?? "";
    if (!label) continue;
    candidates.push({
      id: hitId,
      type: hitType,
      label,
      description: ((hit.properties?.description as string) ?? "").slice(0, DESC_SNIPPET_CHARS),
    });
    if (candidates.length >= CANDIDATE_LIMIT) break;
  }

  if (candidates.length === 0) {
    console.log(`[knowledge:dedup] entity=${entity.id} "${entity.label}" space=${entity.space_id} no candidates`);
    await markDone(entity.id, { same_as: null, candidates_considered: 0 });
    return;
  }

  // LLM judge — rate-limited.
  await rateLimiter.wait();
  let judge;
  try {
    judge = await llmJudge(llm, entity, candidates);
  } catch (err) {
    throw new Error(`llmJudge failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (judge.decision.same_as) {
    const targetId = judge.decision.same_as;
    try {
      await submitMerge(targetId, entity.id);
      console.log(
        `[knowledge:dedup] entity=${entity.id} "${entity.label}" space=${entity.space_id} MERGED into ${targetId} (${candidates.length} candidate(s))`,
      );
      await markDone(entity.id, {
        same_as: targetId,
        candidates_considered: candidates.length,
        tokens_in: judge.tokensIn,
        tokens_out: judge.tokensOut,
        model: judge.model,
      });
    } catch (mergeErr) {
      // If the entity was already merged/deleted between loadEntity and now,
      // skip rather than retry — it's not coming back.
      const msg = mergeErr instanceof Error ? mergeErr.message : String(mergeErr);
      if (msg.includes("not_found") || msg.includes("not found") || msg.includes("already_merged")) {
        await markSkipped(entity.id, `entity gone during merge: ${msg.slice(0, 200)}`);
        return;
      }
      throw new Error(`merge failed: ${msg}`);
    }
  } else {
    console.log(
      `[knowledge:dedup] entity=${entity.id} "${entity.label}" space=${entity.space_id} distinct from ${candidates.length} candidate(s)`,
    );
    await markDone(entity.id, {
      same_as: null,
      candidates_considered: candidates.length,
      tokens_in: judge.tokensIn,
      tokens_out: judge.tokensOut,
      model: judge.model,
    });
  }
}

// ---------------------------------------------------------------------------
// Worker loop
// ---------------------------------------------------------------------------

async function workerLoop(): Promise<void> {
  // Resolve the LLM config once. If this throws (e.g. no LLM configured),
  // the sweeper will idle-loop logging the error until the operator sets
  // one up, rather than crashing the server.
  let llm: LlmClient | null = null;
  let lastConfigError = "";

  while (!shuttingDown) {
    if (!llm) {
      try {
        const config = await resolveLlmConfig("resolver");
        llm = new LlmClient(config);
        lastConfigError = "";
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg !== lastConfigError) {
          console.warn(`[knowledge:dedup] LLM config unavailable, idling: ${msg}`);
          lastConfigError = msg;
        }
        await sleep(IDLE_SLEEP_MS);
        continue;
      }
    }

    let row: QueueRow | null = null;
    try {
      row = await claimNext();
    } catch (err) {
      console.warn(`[knowledge:dedup] claim failed: ${err instanceof Error ? err.message : err}`);
      await sleep(IDLE_SLEEP_MS);
      continue;
    }

    if (!row) {
      await sleep(IDLE_SLEEP_MS);
      continue;
    }

    try {
      await processEntity(row, llm);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[knowledge:dedup] entity=${row.entity_id} failed (attempt ${row.attempts}/${MAX_ATTEMPTS}): ${msg}`,
      );
      try {
        await markFailed(row.entity_id, msg, row.attempts);
      } catch (markErr) {
        console.error(`[knowledge:dedup] markFailed also failed for ${row.entity_id}:`, markErr);
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export function startDedupSweeper(): void {
  if (running) return;
  running = true;
  shuttingDown = false;
  console.log(`[knowledge:dedup] sweeper started, rate=${RATE_PER_MIN}/min`);
  workerPromise = workerLoop().catch((err) => {
    console.error(`[knowledge:dedup] worker loop crashed:`, err);
    running = false;
  });
}

export async function stopDedupSweeper(): Promise<void> {
  if (!running) return;
  shuttingDown = true;
  if (workerPromise) {
    try {
      await workerPromise;
    } catch {
      // already logged
    }
  }
  running = false;
  console.log(`[knowledge:dedup] sweeper stopped`);
}

// ---------------------------------------------------------------------------
// Enqueue helper (called from ops-execute after entity creation)
// ---------------------------------------------------------------------------

export async function enqueueForDedup(
  entityIds: Array<{ entity_id: string; space_id: string; type: string }>,
): Promise<void> {
  const candidates = entityIds.filter(
    (e) => e.space_id && e.entity_id && !SKIP_TYPES.has(e.type),
  );
  if (candidates.length === 0) return;

  await withAdminSql(async (sql) => {
    // Bulk insert with ON CONFLICT DO NOTHING — re-enqueue is a no-op.
    const values = candidates
      .map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`)
      .join(", ");
    const params: unknown[] = [];
    for (const e of candidates) {
      params.push(e.entity_id, e.space_id);
    }
    await sql.query(
      `INSERT INTO knowledge_dedup_queue (entity_id, space_id)
       VALUES ${values}
       ON CONFLICT (entity_id) DO NOTHING`,
      params,
    );
  });
}
