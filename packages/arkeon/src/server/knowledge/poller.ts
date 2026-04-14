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
import { createJob } from "./queue";

const POLL_INTERVAL_MS = Number(process.env.KNOWLEDGE_POLLER_INTERVAL_MS) || 10_000;
const BATCH_SIZE = 50;

let pollTimer: ReturnType<typeof setInterval> | null = null;
let polling = false;

async function pollForNewContent(): Promise<void> {
  if (polling) return; // Guard against overlapping polls
  polling = true;

  try {
    const sql = createSql();

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

    if (events.length === 0) return;

    let enqueued = 0;
    let lastSuccessActivityId = lastActivityId;

    for (const event of events) {
      const activityId = event.activity_id as number;
      const entityId = event.entity_id as string;
      const action = event.action as string;

      // Check entity exists and has content (run as admin to bypass RLS).
      // For content_uploaded: check entity_content table (file-based content).
      // For entity_created/content_updated: check inline properties.content (arkeon add).
      const entityResults = await sql.transaction([
        sql`SELECT set_config('app.actor_id', 'SYSTEM', true)`,
        sql`SELECT set_config('app.actor_read_level', '4', true)`,
        sql`SELECT set_config('app.actor_is_admin', 'true', true)`,
        sql`SELECT id, ver, type,
                   properties->>'content' AS content_text,
                   properties->'content' AS content_value
            FROM entities
            WHERE id = ${entityId} AND kind = 'entity'`,
      ]);
      const [entity] = entityResults[entityResults.length - 1] as Array<Record<string, unknown>>;

      if (!entity) {
        lastSuccessActivityId = activityId;
        continue;
      }

      // content_uploaded: entity has file content stored in properties.content (JSONB map with keys)
      // entity_created/content_updated: entity has inline text content (string) in properties.content
      const contentValue = entity.content_value;
      const contentText = entity.content_text;

      // properties.content is a JSONB map when files are uploaded (e.g. {"test.txt": {cid, content_type, size}})
      // properties.content is a plain string when arkeon add stores inline text
      const hasFileContent = contentValue != null && typeof contentValue === "object" && !Array.isArray(contentValue);
      const hasInlineContent = typeof contentText === "string" && contentText.trim().length > 0;

      const hasContent = action === "content_uploaded"
        ? (hasFileContent || hasInlineContent)
        : hasInlineContent;

      if (!hasContent) {
        lastSuccessActivityId = activityId;
        continue;
      }

      // Try to create a job (will be skipped if duplicate entity+ver)
      const jobId = await createJob({ entityId, entityVer: entity.ver as number, trigger: "poller" });
      if (jobId) {
        enqueued++;
        console.log(`[knowledge:poller] Enqueued job ${jobId} for entity ${entityId} (ver ${entity.ver})`);
      }
      // Advance checkpoint — job was either created or deduped (intentional skip)
      lastSuccessActivityId = activityId;
    }

    // Update checkpoint only to last successfully processed event.
    // Must run in admin context because knowledge_poller_state has RLS.
    if (lastSuccessActivityId > lastActivityId) {
      await sql.transaction([
        sql`SELECT set_config('app.actor_id', 'SYSTEM', true)`,
        sql`SELECT set_config('app.actor_is_admin', 'true', true)`,
        sql.query(
          `UPDATE knowledge_poller_state SET last_activity_id = $1, updated_at = NOW() WHERE id = 'default'`,
          [lastSuccessActivityId],
        ),
      ]);
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
