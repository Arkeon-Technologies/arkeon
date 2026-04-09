/**
 * Admin RLS context helpers for the knowledge service.
 *
 * createAdminSql() — quick single-query helper. Sets admin context on a
 * pooled connection. Works reliably for single-query operations since
 * postgres.js pipelines sequential queries on the same connection.
 *
 * withAdminSql() — transaction-scoped helper. Guarantees set_config and
 * ALL queries in the callback use the same connection via pg.begin().
 * Use this when a function does multiple queries that all need admin context.
 */

import { createSql, withTransaction } from "../../lib/sql";
import type { SqlClient } from "../../lib/sql";

export async function createAdminSql() {
  const sql = createSql();
  await sql`SELECT set_config('app.actor_is_admin', 'true', false)`;
  return sql;
}

export async function withAdminSql<T>(fn: (sql: SqlClient) => Promise<T>): Promise<T> {
  return withTransaction(async (sql) => {
    await sql`SELECT set_config('app.actor_is_admin', 'true', true)`;
    return fn(sql);
  });
}
