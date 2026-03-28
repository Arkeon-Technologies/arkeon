import { createApiKey, sha256Hex } from "./auth";
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

    // Generate ROOT_COMMONS_ID if not provided
    if (!process.env.ROOT_COMMONS_ID) {
      process.env.ROOT_COMMONS_ID = generateUlid();
    }
    const rootCommonsId = process.env.ROOT_COMMONS_ID;

    const networkConfig = {
      label: "The Arke",
      registration_mode: "open",
      default_visibility: "public",
      pow_difficulty: 22,
      policy_mutability: true,
    };

    // Create root commons with network config
    await sql.transaction([
      // Set actor to SYSTEM for bootstrap (RLS requires owner_id = current_actor_id())
      sql`SELECT set_config('app.actor_id', 'SYSTEM', true)`,
      sql.query(
        `INSERT INTO entities (
          id, kind, type, ver, properties, owner_id, commons_id,
          edited_by, created_at, updated_at
        )
        VALUES (
          $1, 'commons', 'commons', 1, $2::jsonb,
          'SYSTEM', NULL, 'SYSTEM', $3::timestamptz, $3::timestamptz
        )
        ON CONFLICT (id) DO UPDATE SET
          properties = $2::jsonb || entities.properties`,
        [rootCommonsId, JSON.stringify(networkConfig), now],
      ),
    ]);

    // Create default system groups (skip if groups table doesn't exist yet)
    const everyoneId = generateUlid();
    const adminsId = generateUlid();
    const membersId = generateUlid();

    try {
      await sql.transaction([
        sql`
          INSERT INTO groups (id, network_id, name, system_group, can_invite)
          VALUES (${everyoneId}, ${rootCommonsId}, 'everyone', true, false)
          ON CONFLICT (network_id, name) DO NOTHING
        `,
        sql`
          INSERT INTO groups (id, network_id, name, system_group, can_invite)
          VALUES (${adminsId}, ${rootCommonsId}, 'admins', true, true)
          ON CONFLICT (network_id, name) DO NOTHING
        `,
        sql`
          INSERT INTO groups (id, network_id, name, system_group, can_invite)
          VALUES (${membersId}, ${rootCommonsId}, 'members', true, false)
          ON CONFLICT (network_id, name) DO NOTHING
        `,
      ]);
    } catch {
      // groups table may not exist yet (pre-migration)
    }

    // Bootstrap admin from ADMIN_BOOTSTRAP_KEY
    if (process.env.ADMIN_BOOTSTRAP_KEY) {
      try {
        await bootstrapAdmin(sql, rootCommonsId, now);
      } catch (err) {
        console.error("[bootstrap] admin setup failed:", err);
      }
    }
  })().catch((error) => {
    bootstrapPromise = null;
    throw error;
  });

  return bootstrapPromise;
}

async function bootstrapAdmin(
  sql: ReturnType<typeof createSql>,
  rootCommonsId: string,
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

  await sql.transaction([
    // Set actor to the admin being created (RLS requires owner_id = current_actor_id())
    sql`SELECT set_config('app.actor_id', ${adminId}, true)`,
    // Create admin agent entity
    sql`
      INSERT INTO entities (
        id, kind, type, ver, properties, owner_id, commons_id,
        edited_by, created_at, updated_at
      )
      VALUES (
        ${adminId}, 'agent', 'agent', 1,
        ${JSON.stringify({ label: "Bootstrap Admin" })}::jsonb,
        ${adminId}, NULL, ${adminId},
        ${now}::timestamptz, ${now}::timestamptz
      )
      ON CONFLICT (id) DO NOTHING
    `,
    // Store API key
    sql`
      INSERT INTO api_keys (id, key_prefix, key_hash, actor_id)
      VALUES (${keyId}, ${keyPrefix}, ${keyHash}, ${adminId})
      ON CONFLICT DO NOTHING
    `,
    // Grant admin on root commons (need to be owner of root commons or admin)
    // Use SYSTEM context since root commons is owned by SYSTEM
    sql`SELECT set_config('app.actor_id', 'SYSTEM', true)`,
    sql`
      INSERT INTO entity_access (entity_id, actor_id, access_type)
      VALUES (${rootCommonsId}, ${adminId}, 'admin')
      ON CONFLICT DO NOTHING
    `,
  ]);

  // Add to admins group
  try {
    await sql.transaction([
      sql`
        INSERT INTO group_memberships (group_id, actor_id, granted_by)
        SELECT id, ${adminId}, ${adminId}
        FROM groups
        WHERE network_id = ${rootCommonsId} AND name = 'admins'
        ON CONFLICT DO NOTHING
      `,
    ]);
  } catch {
    // group tables may not exist yet
  }
}
