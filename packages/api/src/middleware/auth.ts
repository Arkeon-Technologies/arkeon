import type { MiddlewareHandler } from "hono";

import { parseApiKeyHeader, sha256Hex } from "../lib/auth";
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
  const sql = createSql(c.env);

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

  const actor: Actor = {
    id: key.actor_id,
    apiKeyId: key.id,
    keyPrefix: key.key_prefix,
  };

  c.set("actor", actor);

  c.executionCtx.waitUntil(
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
