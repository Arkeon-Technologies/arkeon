// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Content poller: watches entity_activity for content changes and
 * auto-enqueues knowledge extraction jobs.
 *
 * Triggers on:
 *   - content_uploaded: file uploaded via POST /entities/{id}/content
 *   - entity_created:   entity created (e.g. via arkeon add / POST /ops)
 *   - content_updated:  entity updated via upsert (e.g. arkeon add on modified file)
 *
 * For entity_created and content_updated, the entity must be a document
 * with inline content (properties.content IS NOT NULL) to trigger extraction.
 *
 * Uses entity_activity.id (BIGSERIAL) as a monotonic cursor —
 * no gaps, no clock skew, catches everything.
 */

import { createSql } from "../lib/sql";
import { generateUlid } from "../lib/ids";

const POLL_INTERVAL_MS = Number(process.env.KNOWLEDGE_POLLER_INTERVAL_MS) || 10_000;
const BATCH_SIZE = 50;

let pollTimer: ReturnType<typeof setInterval> | null = null;
let polling = false;

async function pollForNewContent(): Promise<void> {
  if (polling) return; // Guard against overlapping polls
  polling = true;

  try {
    const sql = createSql();

    // Process batches in a loop until caught up. Without this, a backlog
    // of activity events (e.g. from a test suite creating hundreds of
    // entities) would take multiple poll intervals to drain, since each
    // poll only processes BATCH_SIZE events.
    let batchesProcessed = 0;
    const MAX_BATCHES_PER_POLL = 20; // Safety cap to avoid runaway loops

    while (batchesProcessed < MAX_BATCHES_PER_POLL) {
      // Run all poller reads in a single transaction with admin context
      // (set_config with true = local to transaction only)
      const pollerResults = await sql.transaction([
        sql`SELECT set_config('app.actor_id', 'SYSTEM', true)`,
        sql`SELECT set_config('app.actor_read_level', '4', true)`,
        sql`SELECT set_config('app.actor_write_level', '4', true)`,
        sql`SELECT set_config('app.actor_is_admin', 'true', true)`,
        sql`SELECT last_activity_id FROM knowledge_poller_state WHERE id = 'default'`,
        sql.query(
          `SELECT ea.id AS activity_id, ea.entity_id, ea.action
           FROM entity_activity ea
           WHERE ea.id > (SELECT last_activity_id FROM knowledge_poller_state WHERE id = 'default')
             AND ea.action IN ('content_uploaded', 'entity_created', 'content_updated')
             AND ea.actor_id NOT IN (
               SELECT id FROM actors WHERE properties->>'label' = 'knowledge-service'
             )
           ORDER BY ea.id ASC
           LIMIT ${BATCH_SIZE}`,
          [],
        ),
      ]);
      const stateRows = pollerResults[4] as Array<Record<string, unknown>>;
      const lastActivityId = (stateRows[0]?.last_activity_id as number) ?? 0;
      const events = pollerResults[5] as Array<Record<string, unknown>>;

      if (events.length === 0) break;

      // Batch-fetch all referenced entities in a single query instead of
      // one transaction per event. This is critical for performance when
      // the poller has a backlog (e.g. hundreds of entity_created events
      // from a test suite).
      const entityIds = [...new Set(events.map((e) => e.entity_id as string))];
      const entityResults = await sql.transaction([
        sql`SELECT set_config('app.actor_id', 'SYSTEM', true)`,
        sql`SELECT set_config('app.actor_read_level', '4', true)`,
        sql`SELECT set_config('app.actor_is_admin', 'true', true)`,
        sql.query(
          `SELECT id, ver, type,
                  properties->>'content' AS content_text,
                  properties->'content' AS content_value
           FROM entities
           WHERE id = ANY($1) AND kind = 'entity'`,
          [entityIds],
        ),
      ]);
      const entityRows = entityResults[entityResults.length - 1] as Array<Record<string, unknown>>;
      const entityMap = new Map(entityRows.map((e) => [e.id as string, e]));

      // Filter events to those whose entities have content worth extracting.
      const jobCandidates: Array<{ entityId: string; entityVer: number }> = [];
      for (const event of events) {
        const entityId = event.entity_id as string;
        const action = event.action as string;
        const entity = entityMap.get(entityId);
        if (!entity) continue;

        const contentValue = entity.content_value;
        const contentText = entity.content_text;
        // properties.content is a JSONB map when files are uploaded (e.g. {"test.txt": {cid, content_type, size}})
        // properties.content is a plain string when arkeon add stores inline text
        const hasFileContent = contentValue != null && typeof contentValue === "object" && !Array.isArray(contentValue);
        const hasInlineContent = typeof contentText === "string" && contentText.trim().length > 0;
        const hasContent = action === "content_uploaded"
          ? (hasFileContent || hasInlineContent)
          : hasInlineContent;

        if (hasContent) {
          jobCandidates.push({ entityId, entityVer: entity.ver as number });
        }
      }

      // Bulk-insert all jobs in a single transaction with ON CONFLICT DO NOTHING.
      // This replaces the previous loop of individual createJob() calls, each of
      // which opened its own BEGIN/set_config/INSERT/COMMIT round trip.
      const lastEventId = events[events.length - 1]!.activity_id as number;

      if (jobCandidates.length > 0) {
        // Deduplicate: only one job per (entity_id, entity_ver) in this batch
        const seen = new Set<string>();
        const unique = jobCandidates.filter((c) => {
          const key = `${c.entityId}:${c.entityVer}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });

        // Build a bulk VALUES clause: ($1,$2,$3,'pending','poller',NULL,'ingest',NULL,NULL,NOW()), ...
        const params: unknown[] = [];
        const rows: string[] = [];
        for (const c of unique) {
          const offset = params.length;
          params.push(generateUlid(), c.entityId, c.entityVer);
          rows.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, 'pending', 'poller', NULL, 'ingest', NULL, NULL, NOW())`);
        }

        await sql.transaction([
          sql`SELECT set_config('app.actor_id', 'SYSTEM', true)`,
          sql`SELECT set_config('app.actor_is_admin', 'true', true)`,
          sql.query(
            `INSERT INTO knowledge_jobs (id, entity_id, entity_ver, status, trigger, triggered_by, job_type, parent_job_id, metadata, created_at)
             VALUES ${rows.join(", ")}
             ON CONFLICT DO NOTHING`,
            params,
          ),
        ]);

        const enqueued = unique.length;
        if (enqueued > 0) {
          console.log(`[knowledge:poller] Enqueued ${enqueued} job(s) from batch of ${events.length} events`);
        }
      }

      // Advance checkpoint to last event in this batch.
      if (lastEventId > lastActivityId) {
        await sql.transaction([
          sql`SELECT set_config('app.actor_id', 'SYSTEM', true)`,
          sql`SELECT set_config('app.actor_is_admin', 'true', true)`,
          sql.query(
            `UPDATE knowledge_poller_state SET last_activity_id = $1, updated_at = NOW() WHERE id = 'default'`,
            [lastEventId],
          ),
        ]);
      }

      batchesProcessed++;

      // If this batch was smaller than BATCH_SIZE, we've caught up
      if (events.length < BATCH_SIZE) break;
    }
  } catch (err) {
    console.error(`[knowledge:poller] Error:`, err);
  } finally {
    polling = false;
  }
}

/**
 * Start the content poller. Call at startup.
 */
export function startKnowledgePoller(): void {
  if (pollTimer) return;

  pollTimer = setInterval(() => {
    pollForNewContent().catch((err) => {
      console.error(`[knowledge:poller] Unhandled error:`, err);
    });
  }, POLL_INTERVAL_MS);

  console.log(`[knowledge:poller] Started (interval: ${POLL_INTERVAL_MS}ms)`);
}

/**
 * Stop the content poller.
 */
export function stopKnowledgePoller(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    console.log("[knowledge:poller] Stopped");
  }
}
