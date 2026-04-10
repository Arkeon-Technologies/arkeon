import { ApiError } from "./errors";
import type { SqlClient } from "./sql";

export type SpaceRecord = {
  id: string;
  name: string;
  description: string | null;
  owner_id: string;
  read_level: number;
  write_level: number;
  status: string;
  entity_count: number;
  last_activity_at: string | null;
  properties: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

/**
 * Checks whether the actor has the required role on a space (or is owner/admin).
 * Returns the space record or throws.
 */
export async function requireSpaceRole(
  sql: SqlClient,
  actor: { id: string; isAdmin: boolean; maxReadLevel: number },
  spaceId: string,
  requiredRole: "viewer" | "contributor" | "editor" | "admin" | "owner",
): Promise<SpaceRecord> {
  const [space] = await sql`SELECT * FROM spaces WHERE id = ${spaceId} LIMIT 1`;
  if (!space) {
    throw new ApiError(404, "not_found", "Space not found");
  }
  const s = space as SpaceRecord;

  // RLS: read_level check
  if (s.read_level > actor.maxReadLevel && !actor.isAdmin) {
    throw new ApiError(403, "forbidden", "Insufficient read level");
  }

  if (requiredRole === "viewer") return s;
  if (actor.isAdmin) return s;
  if (s.owner_id === actor.id) return s;

  const roleHierarchy = ["viewer", "contributor", "editor", "admin"];
  const requiredIdx = roleHierarchy.indexOf(requiredRole);

  const [perm] = await sql`
    SELECT role FROM space_permissions
    WHERE space_id = ${spaceId} AND grantee_id = ${actor.id}
    LIMIT 1
  `;

  if (!perm) {
    throw new ApiError(403, "forbidden",
      `You have no role on this space. Required: ${requiredRole}. Grant access via POST /spaces/${spaceId}/permissions`);
  }

  const grantedIdx = roleHierarchy.indexOf(perm.role as string);
  if (grantedIdx < requiredIdx) {
    throw new ApiError(403, "forbidden",
      `Your role '${perm.role}' is insufficient, need '${requiredRole}'. Upgrade via POST /spaces/${spaceId}/permissions`);
  }

  return s;
}
