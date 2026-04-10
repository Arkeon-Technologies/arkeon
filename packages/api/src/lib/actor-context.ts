import type { createSql } from "./sql";
import type { Actor } from "../types";

/**
 * Returns a single SQL query that sets the RLS session context for an actor.
 * Use as the first query in a transaction: [...setActorContext(sql, actor), ...queries]
 *
 * Sets: app.actor_id, app.actor_read_level, app.actor_write_level, app.actor_is_admin
 */
export function setActorContext(sql: ReturnType<typeof createSql>, actor: Actor | null) {
  if (!actor) {
    return [
      sql`SELECT
        set_config('app.actor_id', '', true),
        set_config('app.actor_read_level', '-1', true),
        set_config('app.actor_write_level', '-1', true),
        set_config('app.actor_is_admin', 'false', true)`,
    ];
  }

  return [
    sql`SELECT
      set_config('app.actor_id', ${actor.id}, true),
      set_config('app.actor_read_level', ${String(actor.maxReadLevel)}, true),
      set_config('app.actor_write_level', ${String(actor.maxWriteLevel)}, true),
      set_config('app.actor_is_admin', ${String(actor.isAdmin)}, true)`,
  ];
}
