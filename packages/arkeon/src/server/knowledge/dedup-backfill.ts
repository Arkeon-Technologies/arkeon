// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * One-shot backfill for the dedup queue.
 *
 * On startup, if we've never run the backfill, enumerate every
 * non-document/non-text_chunk entity across every space and enqueue it
 * for the dedup sweeper. The worker will work through it in FIFO order,
 * merging accumulated historical duplicates.
 *
 * Idempotent: the marker in `knowledge_dedup_meta` prevents repeats.
 */

import { withAdminSql } from "./lib/admin-sql";

const MARKER_KEY = "initial_backfill_complete";
const BATCH_SIZE = 500;
const BACKFILL_WARN_THRESHOLD = 50_000;
const BACKFILL_MAX = Number(process.env.DEDUP_BACKFILL_MAX) || 0; // 0 = unlimited

export async function runDedupBackfillIfNeeded(): Promise<void> {
  const alreadyDone = await checkMarker();
  if (alreadyDone) {
    return;
  }

  const started = Date.now();
  let total = 0;
  let spaceCount = 0;

  try {
    await withAdminSql(async (sql) => {
      // Full admin context — bypass RLS on entities/space_entities so we
      // enumerate everything regardless of classification levels.
      await sql`SELECT set_config('app.actor_id', 'SYSTEM', true)`;
      await sql`SELECT set_config('app.actor_read_level', '4', true)`;
      await sql`SELECT set_config('app.actor_write_level', '4', true)`;

      const spaceRows = (await sql.query(
        `SELECT DISTINCT se.space_id
         FROM space_entities se
         JOIN entities e ON e.id = se.entity_id
         WHERE e.kind = 'entity'
           AND e.type NOT IN ('document', 'text_chunk')`,
        [],
      )) as Array<Record<string, unknown>>;

      spaceCount = spaceRows.length;

      for (const row of spaceRows) {
        const space_id = row.space_id as string;
        let cursor: string | null = null;
        while (true) {
          const params: unknown[] = [space_id];
          let cursorClause = "";
          if (cursor) {
            params.push(cursor);
            cursorClause = `AND e.id > $${params.length}`;
          }
          const rows = (await sql.query(
            `SELECT e.id
             FROM entities e
             JOIN space_entities se ON se.entity_id = e.id
             WHERE se.space_id = $1
               AND e.kind = 'entity'
               AND e.type NOT IN ('document', 'text_chunk')
               ${cursorClause}
             ORDER BY e.id
             LIMIT ${BATCH_SIZE}`,
            params,
          )) as Array<Record<string, unknown>>;

          if (rows.length === 0) break;

          const values = rows.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(", ");
          const insertParams: unknown[] = [];
          for (const r of rows) {
            insertParams.push(r.id as string, space_id);
          }
          await sql.query(
            `INSERT INTO knowledge_dedup_queue (entity_id, space_id)
             VALUES ${values}
             ON CONFLICT (entity_id) DO NOTHING`,
            insertParams,
          );

          total += rows.length;
          cursor = rows[rows.length - 1]!.id as string;
          if (rows.length < BATCH_SIZE) break;
          if (BACKFILL_MAX > 0 && total >= BACKFILL_MAX) break;
        }
        if (BACKFILL_MAX > 0 && total >= BACKFILL_MAX) break;
      }
      if (total > BACKFILL_WARN_THRESHOLD) {
        console.warn(
          `[knowledge:dedup:backfill] large backfill: ${total} entities enqueued. ` +
          `Set DEDUP_BACKFILL_MAX to cap if needed.`,
        );
      }

      await setMarker({ at: new Date().toISOString(), entities: total, spaces: spaceCount });
    });

    const elapsedMs = Date.now() - started;
    console.log(
      `[knowledge:dedup:backfill] enqueued ${total} entities across ${spaceCount} space(s) in ${elapsedMs}ms`,
    );
  } catch (err) {
    console.error(
      `[knowledge:dedup:backfill] failed (will retry on next startup):`,
      err instanceof Error ? err.message : err,
    );
  }
}

async function checkMarker(): Promise<boolean> {
  return withAdminSql(async (sql) => {
    const rows = (await sql.query(
      `SELECT value FROM knowledge_dedup_meta WHERE key = $1 LIMIT 1`,
      [MARKER_KEY],
    )) as Array<{ value: unknown }>;
    return rows.length > 0;
  });
}

async function setMarker(value: Record<string, unknown>): Promise<void> {
  await withAdminSql(async (sql) => {
    await sql.query(
      `INSERT INTO knowledge_dedup_meta (key, value, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [MARKER_KEY, JSON.stringify(value)],
    );
  });
}
