/**
 * Content poller: watches entity_activity for 'content_uploaded' events
 * and auto-enqueues knowledge extraction jobs for new content.
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
        `SELECT ea.id AS activity_id, ea.entity_id
         FROM entity_activity ea
         WHERE ea.id > (SELECT last_activity_id FROM knowledge_poller_state WHERE id = 'default')
           AND ea.action = 'content_uploaded'
           AND ea.edited_by NOT IN (
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

      // Check entity exists and has content (run as admin to bypass RLS)
      const entityResults = await sql.transaction([
        sql`SELECT set_config('app.actor_id', 'SYSTEM', true)`,
        sql`SELECT set_config('app.actor_read_level', '4', true)`,
        sql`SELECT set_config('app.actor_is_admin', 'true', true)`,
        sql`SELECT id, ver, properties->'content' AS content
            FROM entities
            WHERE id = ${entityId} AND kind = 'entity'`,
      ]);
      const [entity] = entityResults[entityResults.length - 1] as Array<Record<string, unknown>>;

      if (!entity || !entity.content) {
        // Intentional skip — entity doesn't exist or has no content, advance past it
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

    // Update checkpoint only to last successfully processed event
    if (lastSuccessActivityId > lastActivityId) {
      await sql.query(
        `UPDATE knowledge_poller_state SET last_activity_id = $1, updated_at = NOW() WHERE id = 'default'`,
        [lastSuccessActivityId],
      );
    }

    if (enqueued > 0) {
      console.log(`[knowledge:poller] Processed ${events.length} events, enqueued ${enqueued} jobs`);
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
