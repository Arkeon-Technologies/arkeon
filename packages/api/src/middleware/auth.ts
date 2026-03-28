import type { MiddlewareHandler } from "hono";

import { parseApiKeyHeader, sha256Hex } from "../lib/auth";
import { backgroundTask } from "../lib/background";
import { createSql } from "../lib/sql";
import type { Actor, AppBindings } from "../types";

export const authMiddleware: MiddlewareHandler<AppBindings> = async (c, next) => {
  c.set("actor", null);

  const path = new URL(c.req.url).pathname;
  if (path === "/llms.txt" || path.startsWith("/help")) {
    await next();
    return;
  }

  const apiKey = parseApiKeyHeader(c.req.header("authorization"));
  if (!apiKey) {
    await next();
    return;
  }

  const keyHash = await sha256Hex(apiKey);
  const sql = createSql();

  const [setActorResult, keyRows] = await sql.transaction([
    sql`SELECT set_config('app.actor_id', '', true)`,
    sql`
      SELECT id, actor_id, key_prefix
      FROM api_keys
      WHERE key_hash = ${keyHash}
        AND revoked_at IS NULL
      LIMIT 1
    `,
  ]);

  void setActorResult;

  const key = (keyRows as Array<{ id: string; actor_id: string; key_prefix: string }>)[0];
  if (!key) {
    await next();
    return;
  }

  // Compute effective groups (direct + inherited + "everyone")
  let groups: string[] = [];
  try {
    const [, groupRows, everyoneRows] = await sql.transaction([
      sql`SELECT set_config('app.actor_id', '', true)`,
      sql`SELECT group_id FROM actor_effective_groups(${key.actor_id})`,
      sql`SELECT id FROM groups WHERE network_id = ${process.env.ROOT_COMMONS_ID ?? ''} AND name = 'everyone' LIMIT 1`,
    ]);
    groups = (groupRows as Array<{ group_id: string }>).map((r) => r.group_id);
    const everyoneId = (everyoneRows as Array<{ id: string }>)[0]?.id;
    if (everyoneId && !groups.includes(everyoneId)) {
      groups.push(everyoneId);
    }
  } catch {
    // groups table or function may not exist yet (pre-migration)
  }

  const actor: Actor = {
    id: key.actor_id,
    apiKeyId: key.id,
    keyPrefix: key.key_prefix,
    groups,
  };

  c.set("actor", actor);

  backgroundTask(
    sql.transaction([
      sql`SELECT set_config('app.actor_id', ${actor.id}, true)`,
      sql`
        UPDATE api_keys
        SET last_used_at = NOW()
        WHERE id = ${actor.apiKeyId}
      `,
    ]).then(() => undefined),
  );

  await next();
};
