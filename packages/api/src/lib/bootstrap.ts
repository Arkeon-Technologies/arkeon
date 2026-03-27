import { createSql } from "./sql";
import type { Env } from "../types";

let bootstrapPromise: Promise<void> | null = null;

export function ensureBootstrap(env: Env): Promise<void> {
  if (bootstrapPromise) {
    return bootstrapPromise;
  }

  bootstrapPromise = (async () => {
    const sql = createSql(env);
    const now = new Date().toISOString();

    await sql.transaction([
      sql`
        INSERT INTO entities (
          id, kind, type, ver, properties, owner_id, commons_id,
          edited_by, created_at, updated_at
        )
        VALUES (
          ${env.ROOT_COMMONS_ID},
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
