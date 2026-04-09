/**
 * Creates a SQL client with admin RLS context pre-set.
 * All knowledge service DB operations need admin context because
 * the knowledge tables have RLS policies that check current_actor_is_admin().
 */

import { createSql } from "../../lib/sql";

export async function createAdminSql() {
  const sql = createSql();
  await sql`SELECT set_config('app.actor_is_admin', 'true', false)`;
  return sql;
}
