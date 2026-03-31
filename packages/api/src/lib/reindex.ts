/**
 * Bulk reindex all entities from Postgres into Meilisearch.
 *
 * Usage: MEILI_URL=http://localhost:7700 npx tsx packages/api/src/lib/reindex.ts
 */
import "dotenv/config";
import { createSql } from "./sql";
import { bulkIndexEntities, ensureMeiliIndex, isMeilisearchConfigured } from "./meilisearch";

const BATCH_SIZE = 1000;

async function reindex() {
  if (!isMeilisearchConfigured()) {
    console.error("MEILI_URL not set — cannot reindex");
    process.exit(1);
  }

  console.log("Ensuring Meilisearch index settings...");
  await ensureMeiliIndex();

  const sql = createSql();

  // Pre-fetch all space memberships into a map
  console.log("Loading space memberships...");
  const spaceRows = await sql`SELECT entity_id, space_id FROM space_entities`;
  const spaceIdMap = new Map<string, string[]>();
  for (const row of spaceRows as Array<{ entity_id: string; space_id: string }>) {
    const existing = spaceIdMap.get(row.entity_id);
    if (existing) {
      existing.push(row.space_id);
    } else {
      spaceIdMap.set(row.entity_id, [row.space_id]);
    }
  }
  console.log(`  ${spaceIdMap.size} entities have space memberships`);

  let cursor: string | null = null;
  let total = 0;

  console.log("Starting reindex...");

  while (true) {
    const rows = cursor
      ? await sql`SELECT * FROM entities WHERE id > ${cursor} ORDER BY id LIMIT ${BATCH_SIZE}`
      : await sql`SELECT * FROM entities ORDER BY id LIMIT ${BATCH_SIZE}`;

    if ((rows as unknown[]).length === 0) break;

    const entities = rows as Record<string, unknown>[];
    await bulkIndexEntities(entities, spaceIdMap);
    total += entities.length;
    cursor = String(entities[entities.length - 1].id);
    console.log(`  indexed ${total} entities...`);
  }

  console.log(`Reindex complete: ${total} entities indexed.`);
  process.exit(0);
}

reindex().catch((err) => {
  console.error("Reindex failed:", err);
  process.exit(1);
});
