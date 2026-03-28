import type { EntityRecord } from "./entities";
import { ApiError } from "./errors";
import { createSql, type SqlClient } from "./sql";

export type AccessLevel = "view" | "edit" | "contribute" | "admin" | "owner";

interface AccessCheckResult {
  entity: EntityRecord | null;
  exists: boolean;
}

/**
 * Returns the SET LOCAL queries to set actor context for a transaction.
 * Use with spread: `...setActorContext(sql, actor)`
 */
export function setActorContext(
  sql: SqlClient,
  actor: { id: string; groups: string[] },
) {
  return [
    sql`SELECT set_config('app.actor_id', ${actor.id}, true)`,
    sql`SELECT set_config('app.actor_groups', ${actor.groups.join(",")}, true)`,
  ];
}

/**
 * Unified permission check. Replaces loadVisibleEntity(), ensureEditAccess(),
 * ensureManageAccess(), and inline contribute/admin checks.
 */
export async function checkEntityAccess(
  actorId: string,
  actorGroups: string[],
  entityId: string,
  level: AccessLevel,
): Promise<AccessCheckResult> {
  const sql = createSql();
  const accessQuery = buildAccessQuery(level);

  const [, , rows, existsRows] = await sql.transaction([
    sql`SELECT set_config('app.actor_id', ${actorId}, true)`,
    sql`SELECT set_config('app.actor_groups', ${actorGroups.join(",")}, true)`,
    sql.query(accessQuery, [entityId]),
    sql`SELECT entity_exists(${entityId}) AS exists`,
  ]);

  return {
    entity: (rows as EntityRecord[])[0] ?? null,
    exists: Boolean((existsRows as Array<{ exists: boolean }>)[0]?.exists),
  };
}

/**
 * Throws 403 or 404 based on the access check result.
 */
export function requireEntity(
  result: AccessCheckResult,
  label = "Entity",
): EntityRecord {
  if (result.entity) {
    return result.entity;
  }
  if (result.exists) {
    throw new ApiError(403, "forbidden", "Forbidden");
  }
  throw new ApiError(404, "not_found", `${label} not found`);
}

/**
 * Check if an actor has admin on the root commons (network admin).
 */
export async function isNetworkAdmin(actorId: string): Promise<boolean> {
  const rootCommonsId = process.env.ROOT_COMMONS_ID;
  if (!rootCommonsId) return false;

  const sql = createSql();
  const [, rows] = await sql.transaction([
    sql`SELECT set_config('app.actor_id', ${actorId}, true)`,
    sql.query(
      `SELECT 1 FROM entity_access
       WHERE entity_id = $1 AND actor_id = $2 AND access_type = 'admin'
       LIMIT 1`,
      [rootCommonsId, actorId],
    ),
  ]);
  return (rows as Array<Record<string, unknown>>).length > 0;
}

/**
 * Check if an actor can generate invitation codes (admin or in can_invite group).
 */
export async function canInvite(actorId: string): Promise<boolean> {
  const rootCommonsId = process.env.ROOT_COMMONS_ID;
  if (!rootCommonsId) return false;

  const sql = createSql();
  const [, rows] = await sql.transaction([
    sql`SELECT set_config('app.actor_id', ${actorId}, true)`,
    sql.query(
      `SELECT 1 WHERE EXISTS(
         SELECT 1 FROM entity_access
         WHERE entity_id = $1 AND actor_id = $2 AND access_type = 'admin'
       ) OR EXISTS(
         SELECT 1 FROM group_memberships gm
         JOIN groups g ON g.id = gm.group_id
         WHERE gm.actor_id = $2 AND g.can_invite = true
       )
       LIMIT 1`,
      [rootCommonsId, actorId],
    ),
  ]);
  return (rows as Array<Record<string, unknown>>).length > 0;
}

function buildAccessQuery(level: AccessLevel): string {
  switch (level) {
    case "view":
      return `
        SELECT e.*
        FROM entities e
        WHERE e.id = $1
          AND (
            e.view_access = 'public'
            OR e.owner_id = current_actor_id()
            OR EXISTS(
              SELECT 1 FROM entity_access ea
              WHERE ea.entity_id = e.id
                AND (
                  ea.actor_id = current_actor_id()
                  OR ea.group_id = ANY(current_actor_groups())
                )
            )
          )
        LIMIT 1
      `;

    case "edit":
      return `
        SELECT e.*
        FROM entities e
        WHERE e.id = $1
          AND (
            e.owner_id = current_actor_id()
            OR e.edit_access = 'public'
            OR (
              e.edit_access = 'collaborators'
              AND EXISTS (
                SELECT 1 FROM entity_access ea
                WHERE ea.entity_id = e.id
                  AND ea.access_type IN ('edit', 'admin')
                  AND (
                    ea.actor_id = current_actor_id()
                    OR ea.group_id = ANY(current_actor_groups())
                  )
              )
            )
            OR EXISTS(
              SELECT 1 FROM entity_access ea
              WHERE ea.entity_id = e.id
                AND ea.access_type = 'edit'
                AND ea.group_id = ANY(current_actor_groups())
                AND ea.rule_id IS NOT NULL
            )
          )
        LIMIT 1
      `;

    case "contribute":
      return `
        SELECT e.*
        FROM entities e
        WHERE e.id = $1
          AND (
            e.owner_id = current_actor_id()
            OR e.contribute_access = 'public'
            OR (
              e.contribute_access = 'contributors'
              AND EXISTS (
                SELECT 1 FROM entity_access ea
                WHERE ea.entity_id = e.id
                  AND ea.access_type IN ('contribute', 'admin')
                  AND (
                    ea.actor_id = current_actor_id()
                    OR ea.group_id = ANY(current_actor_groups())
                  )
              )
            )
            OR EXISTS(
              SELECT 1 FROM entity_access ea
              WHERE ea.entity_id = e.id
                AND ea.access_type = 'contribute'
                AND ea.group_id = ANY(current_actor_groups())
                AND ea.rule_id IS NOT NULL
            )
          )
        LIMIT 1
      `;

    case "admin":
      return `
        SELECT e.*
        FROM entities e
        WHERE e.id = $1
          AND (
            e.owner_id = current_actor_id()
            OR EXISTS (
              SELECT 1 FROM entity_access ea
              WHERE ea.entity_id = e.id
                AND ea.actor_id = current_actor_id()
                AND ea.access_type = 'admin'
            )
          )
        LIMIT 1
      `;

    case "owner":
      return `
        SELECT e.*
        FROM entities e
        WHERE e.id = $1
          AND e.owner_id = current_actor_id()
        LIMIT 1
      `;
  }
}
