// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { withTransaction, type SqlClient, type createSql } from "./sql";
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

/**
 * Run a callback in a transaction with RLS session variables set to a
 * synthetic "system" actor: max read/write levels, is_admin=true.
 *
 * This is for internal, non-user-facing operations that must read or
 * write across the entire classification range regardless of who
 * triggered them — e.g., the background search-index sync and the
 * admin reindex loop. Those operations need to see *every* entity in
 * order to keep the index consistent; RLS (which is designed to
 * filter user reads) would otherwise silently drop rows and produce a
 * corrupt or partial index.
 *
 * Do NOT use this to bypass RLS on behalf of an authenticated caller.
 * If you find yourself reaching for it on a request path, the right
 * answer is almost always to thread the real actor through instead.
 */
export async function withSystemActorContext<T>(
  fn: (sql: SqlClient) => Promise<T>,
): Promise<T> {
  return withTransaction(async (tx) => {
    await tx`SELECT
      set_config('app.actor_id', 'system', true),
      set_config('app.actor_read_level', '4', true),
      set_config('app.actor_write_level', '4', true),
      set_config('app.actor_is_admin', 'true', true)`;
    return fn(tx);
  });
}
