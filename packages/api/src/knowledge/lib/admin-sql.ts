/**
 * Admin RLS context helper for the knowledge service.
 *
 * withAdminSql() — runs `fn` inside a single Postgres transaction with
 * `app.actor_is_admin = 'true'` set transaction-locally. Guarantees the
 * set_config and every query inside `fn` execute on the same pooled
 * connection, so RLS policies that read the GUC always see admin = true.
 *
 * Why this is the only helper: an earlier `createAdminSql()` returned a
 * shared sql client after running set_config on it, then expected later
 * `sql.query(...)` calls to inherit the admin context. That works in
 * isolation but fails under pool contention — postgres.js hands out a
 * fresh connection per await, so the follow-up query lands on a connection
 * with no GUC set and RLS denies the write with PG 42501 (mapped to a
 * 403 forbidden by lib/pg-errors.ts).
 */

import { withTransaction } from "../../lib/sql";
import type { SqlClient } from "../../lib/sql";

export async function withAdminSql<T>(fn: (sql: SqlClient) => Promise<T>): Promise<T> {
  return withTransaction(async (sql) => {
    await sql`SELECT set_config('app.actor_is_admin', 'true', true)`;
    return fn(sql);
  });
}
