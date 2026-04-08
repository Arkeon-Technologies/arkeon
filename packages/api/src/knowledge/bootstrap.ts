/**
 * Bootstrap a dedicated service actor for the knowledge extraction pipeline.
 *
 * Creates a "knowledge-service" agent actor with admin privileges and its own
 * API key. The key is stored encrypted in system_config and used by the SDK
 * to call the Arkeon API for entity operations.
 *
 * Idempotent: skips if the service key already exists and is valid.
 */

import { randomBytes } from "node:crypto";
import { createSql } from "../lib/sql";
import { generateUlid } from "../lib/ids";
import { sha256Hex } from "../lib/auth";
import { encrypt, decrypt } from "../lib/crypto";
import { setServiceKey } from "./lib/arke-client";

const SERVICE_CONFIG_KEY = "knowledge_service_api_key";
const SERVICE_ACTOR_LABEL = "knowledge-service";

/**
 * Ensure the knowledge service has its own actor + API key.
 * Must be called after ensureBootstrap() so the DB and admin actor exist.
 */
export async function bootstrapKnowledgeService(): Promise<void> {
  const sql = createSql();

  // Ensure SDK has the correct base URL (it reads ARKE_API_URL from env)
  if (!process.env.ARKE_API_URL) {
    process.env.ARKE_API_URL = `http://localhost:${process.env.PORT ?? 8000}`;
  }

  // Intentionally do NOT set arkeId on the SDK — the knowledge service
  // operates across all arkes on the instance. Omitting arke_id means
  // search and entity fetches are unfiltered.

  // Check if we already have a stored service key
  try {
    const [row] = await sql.query(
      `SELECT value FROM system_config WHERE key = $1 LIMIT 1`,
      [SERVICE_CONFIG_KEY],
    );

    if (row?.value) {
      const apiKey = await decrypt(row.value as string);

      // Verify the key is still valid
      const keyHash = await sha256Hex(apiKey);
      const [keyRow] = await sql.query(
        `SELECT k.actor_id FROM api_keys k
         JOIN actors a ON a.id = k.actor_id
         WHERE k.key_hash = $1 AND k.revoked_at IS NULL AND a.status = 'active'
         LIMIT 1`,
        [keyHash],
      );

      if (keyRow) {
        setServiceKey(apiKey);
        console.log(`[knowledge:bootstrap] Service actor ready: ${keyRow.actor_id}`);
        return;
      }

      console.warn("[knowledge:bootstrap] Stored service key invalid, re-creating");
    }
  } catch {
    // system_config might not have the row yet — fall through
  }

  // Create the service actor with admin privileges
  const now = new Date().toISOString();
  const actorId = generateUlid();
  const keyId = generateUlid();
  const apiKey = `ak_${randomBytes(32).toString("hex")}`;
  const keyPrefix = apiKey.substring(0, 7);
  const keyHash = await sha256Hex(apiKey);

  // Need to find the arke_id for the network
  let arkeId = process.env.ARKE_ID;
  if (!arkeId) {
    const [arke] = await sql.query(`SELECT id FROM arkes LIMIT 1`, []);
    arkeId = arke?.id as string;
  }

  if (!arkeId) {
    console.warn("[knowledge:bootstrap] No arke found, skipping service actor creation");
    return;
  }

  try {
    await sql.transaction([
      sql`SELECT set_config('app.actor_id', ${actorId}, true)`,
      sql`SELECT set_config('app.actor_read_level', '4', true)`,
      sql`SELECT set_config('app.actor_write_level', '4', true)`,
      sql`SELECT set_config('app.actor_is_admin', 'true', true)`,
      // Create the service actor
      sql`
        INSERT INTO actors (id, kind, max_read_level, max_write_level, is_admin, can_publish_public, properties, created_at, updated_at)
        VALUES (
          ${actorId}, 'agent', 4, 4, true, false,
          ${JSON.stringify({ label: SERVICE_ACTOR_LABEL, description: "Knowledge graph extraction service" })}::jsonb,
          ${now}::timestamptz, ${now}::timestamptz
        )
        ON CONFLICT (id) DO NOTHING
      `,
      // Create the API key
      sql`
        INSERT INTO api_keys (id, key_prefix, key_hash, actor_id)
        VALUES (${keyId}, ${keyPrefix}, ${keyHash}, ${actorId})
        ON CONFLICT DO NOTHING
      `,
      // Service actor keeps arke_id = NULL (admin actors are cross-arke).
      // The RLS pattern "current_actor_arke_id() IS NULL" grants unrestricted access.
    ]);

    // Store the encrypted key in system_config
    const encryptedKey = await encrypt(apiKey);
    await sql.query(
      `INSERT INTO system_config (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [SERVICE_CONFIG_KEY, encryptedKey],
    );

    // Configure the SDK
    setServiceKey(apiKey);

    console.log(`[knowledge:bootstrap] Created service actor: ${actorId}`);
  } catch (err) {
    console.error("[knowledge:bootstrap] Failed to create service actor:", err instanceof Error ? err.message : err);
  }
}
