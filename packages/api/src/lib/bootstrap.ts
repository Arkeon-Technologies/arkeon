import { randomBytes } from "node:crypto";
import { sha256Hex } from "./auth";
import { generateUlid } from "./ids";
import { createSql } from "./sql";

let bootstrapPromise: Promise<void> | null = null;

export function ensureBootstrap(): Promise<void> {
  if (bootstrapPromise) {
    return bootstrapPromise;
  }

  bootstrapPromise = (async () => {
    const sql = createSql();
    const now = new Date().toISOString();

    // Ensure ENCRYPTION_KEY is available — auto-generate and persist if missing
    await ensureEncryptionKey(sql);

    // Generate ARKE_ID if not provided
    if (!process.env.ARKE_ID) {
      process.env.ARKE_ID = generateUlid();
    }
    const arkeId = process.env.ARKE_ID;

    // Bootstrap admin from ADMIN_BOOTSTRAP_KEY (must exist for first startup)
    if (process.env.ADMIN_BOOTSTRAP_KEY) {
      try {
        await bootstrapAdmin(sql, arkeId, now);
      } catch (err) {
        console.error("[bootstrap] admin setup failed:", err);
      }
    }

    // Resolve admin actor ID for arke ownership
    const adminKey = process.env.ADMIN_BOOTSTRAP_KEY;
    let adminId = "SYSTEM";
    if (adminKey) {
      const keyHash = await sha256Hex(adminKey);
      const [rows] = await sql.transaction([
        sql`SELECT actor_id FROM api_keys WHERE key_hash = ${keyHash} LIMIT 1`,
      ]);
      const found = (rows as Array<{ actor_id: string }>)[0];
      if (found) {
        adminId = found.actor_id;
      }
    }

    // Ensure the owner actor exists (create SYSTEM actor if no bootstrap key)
    if (adminId === "SYSTEM") {
      await sql.transaction([
        sql`SELECT set_config('app.actor_id', 'SYSTEM', true)`,
        sql`SELECT set_config('app.actor_read_level', '4', true)`,
        sql`SELECT set_config('app.actor_write_level', '4', true)`,
        sql`SELECT set_config('app.actor_is_admin', 'true', true)`,
        sql`
          INSERT INTO actors (id, kind, max_read_level, max_write_level, is_admin, can_publish_public, properties, created_at, updated_at)
          VALUES (
            'SYSTEM', 'agent', 4, 4, true, false,
            ${JSON.stringify({ label: "System" })}::jsonb,
            ${now}::timestamptz, ${now}::timestamptz
          )
          ON CONFLICT (id) DO NOTHING
        `,
      ]);
    }

    // Create arke with admin as owner (or SYSTEM if no admin)
    await sql.transaction([
      sql`SELECT set_config('app.actor_id', ${adminId}, true)`,
      sql`SELECT set_config('app.actor_read_level', '4', true)`,
      sql`SELECT set_config('app.actor_write_level', '4', true)`,
      sql`SELECT set_config('app.actor_is_admin', 'true', true)`,
      sql`
        INSERT INTO arkes (id, name, owner_id, default_read_level, default_write_level, properties)
        VALUES (
          ${arkeId}, 'The Arke', ${adminId}, 1, 1,
          ${JSON.stringify({ label: "The Arke" })}::jsonb
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

async function bootstrapAdmin(
  sql: ReturnType<typeof createSql>,
  arkeId: string,
  now: string,
) {
  const adminKey = process.env.ADMIN_BOOTSTRAP_KEY!;
  const keyHash = await sha256Hex(adminKey);

  // Check if this key already exists
  const [existingRows] = await sql.transaction([
    sql`SELECT id FROM api_keys WHERE key_hash = ${keyHash} LIMIT 1`,
  ]);
  if ((existingRows as Array<{ id: string }>).length > 0) {
    return; // already bootstrapped
  }

  const adminId = generateUlid();
  const keyId = generateUlid();
  const keyPrefix = adminKey.substring(0, 7);

  // Create admin actor + API key
  // Use permissive context (no actor_id check needed for bootstrap)
  await sql.transaction([
    sql`SELECT set_config('app.actor_id', ${adminId}, true)`,
    sql`SELECT set_config('app.actor_read_level', '4', true)`,
    sql`SELECT set_config('app.actor_write_level', '4', true)`,
    sql`SELECT set_config('app.actor_is_admin', 'true', true)`,
    sql`
      INSERT INTO actors (id, kind, max_read_level, max_write_level, is_admin, can_publish_public, properties, created_at, updated_at)
      VALUES (
        ${adminId}, 'agent', 4, 4, true, true,
        ${JSON.stringify({ label: "Bootstrap Admin" })}::jsonb,
        ${now}::timestamptz, ${now}::timestamptz
      )
      ON CONFLICT (id) DO NOTHING
    `,
    sql`
      INSERT INTO api_keys (id, key_prefix, key_hash, actor_id)
      VALUES (${keyId}, ${keyPrefix}, ${keyHash}, ${adminId})
      ON CONFLICT DO NOTHING
    `,
  ]);

  console.log(`[bootstrap] Admin actor created: ${adminId}`);
  console.log(`[bootstrap] Admin API key: ${adminKey}`);
}

async function ensureEncryptionKey(sql: ReturnType<typeof createSql>): Promise<void> {
  if (process.env.ENCRYPTION_KEY) return;

  // Check if we previously generated and stored one
  try {
    const [rows] = await sql.transaction([
      sql`SELECT value FROM system_config WHERE key = 'encryption_key' LIMIT 1`,
    ]);
    const found = (rows as Array<{ value: string }>)[0];
    if (found) {
      process.env.ENCRYPTION_KEY = found.value;
      console.log("[bootstrap] Loaded ENCRYPTION_KEY from database");
      return;
    }
  } catch {
    // Table may not exist yet (pre-018 migration) — fall through to generate
  }

  // Generate a new key and persist it
  const key = randomBytes(32).toString("hex");
  try {
    await sql.transaction([
      sql`INSERT INTO system_config (key, value) VALUES ('encryption_key', ${key}) ON CONFLICT (key) DO NOTHING`,
    ]);
    process.env.ENCRYPTION_KEY = key;
    console.log("[bootstrap] Generated and stored new ENCRYPTION_KEY");
  } catch {
    // If system_config table doesn't exist, set it in-memory only
    process.env.ENCRYPTION_KEY = key;
    console.warn("[bootstrap] Generated ENCRYPTION_KEY (in-memory only — system_config table missing)");
  }
}
