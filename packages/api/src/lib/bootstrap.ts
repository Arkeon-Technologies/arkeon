import { createSql } from "./sql";

let bootstrapPromise: Promise<void> | null = null;

export function ensureBootstrap(): Promise<void> {
  if (bootstrapPromise) {
    return bootstrapPromise;
  }

  bootstrapPromise = (async () => {
    const sql = createSql();
    const now = new Date().toISOString();
    const rootCommonsId = process.env.ROOT_COMMONS_ID!;

    await sql.transaction([
      sql`
        INSERT INTO entities (
          id, kind, type, ver, properties, owner_id, commons_id,
          edited_by, created_at, updated_at
        )
        VALUES (
          ${rootCommonsId},
          'commons',
          'commons',
          1,
          ${JSON.stringify({ label: "The Arke" })}::jsonb,
          'SYSTEM',
          NULL,
          'SYSTEM',
          ${now}::timestamptz,
          ${now}::timestamptz
        )
        ON CONFLICT (id) DO NOTHING
      `,
    ]);
  })().catch((error) => {
    bootstrapPromise = null;
    throw error;
  });

  return bootstrapPromise;
}
