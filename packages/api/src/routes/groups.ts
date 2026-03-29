import { createRoute, z } from "@hono/zod-openapi";

import { ApiError } from "../lib/errors";
import { requireActor, parseJsonBody, parseLimit, parseCursorParam } from "../lib/http";
import { generateUlid } from "../lib/ids";
import { createRouter } from "../lib/openapi";
import { encodeCursor } from "../lib/cursor";
import {
  ActorSchema,
  DateTimeSchema,
  EntityIdParam,
  GroupSchema,
  cursorResponseSchema,
  entityIdParams,
  errorResponses,
  jsonContent,
  paginationQuerySchema,
  pathParam,
  queryParam,
} from "../lib/schemas";
import { setActorContext } from "../lib/actor-context";
import { createSql } from "../lib/sql";

type GroupRecord = {
  id: string;
  name: string;
  type: string;
  network_id: string;
  created_by: string;
  created_at: string;
};

type GroupMemberRecord = {
  group_id: string;
  actor_id: string;
  role_in_group: string;

};

const GroupMemberSchema = z.object({
  group_id: EntityIdParam,
  actor_id: EntityIdParam,
  role_in_group: z.enum(["member", "admin"]),

});

const GroupWithMembersSchema = GroupSchema.extend({
  members: z.array(GroupMemberSchema),
});

const createGroupRoute = createRoute({
  method: "post",
  path: "/",
  operationId: "createGroup",
  tags: ["Groups"],
  summary: "Create a new group (admin only via RLS)",
  "x-arke-auth": "required",
  "x-arke-related": ["GET /groups/{id}", "GET /groups"],
  request: {
    body: {
      required: true,
      content: jsonContent(
        z.object({
          name: z.string().min(1).describe("Group name"),
          type: z.enum(["org", "project", "editorial", "admin"]).optional().describe("Group type (default: project)"),
          network_id: EntityIdParam.describe("Network (arke) ULID"),
        }),
      ),
    },
  },
  responses: {
    201: {
      description: "Group created",
      content: jsonContent(z.object({ group: GroupSchema })),
    },
    ...errorResponses([400, 401, 403]),
  },
});

const listGroupsRoute = createRoute({
  method: "get",
  path: "/",
  operationId: "listGroups",
  tags: ["Groups"],
  summary: "List groups",
  "x-arke-auth": "optional",
  "x-arke-related": ["POST /groups", "GET /groups/{id}"],
  request: {
    query: paginationQuerySchema(50, 200).extend({
      network_id: queryParam("network_id", EntityIdParam.optional(), "Filter by network"),
      type: queryParam(
        "type",
        z.enum(["org", "project", "editorial", "admin"]).optional(),
        "Filter by type",
      ),
    }),
  },
  responses: {
    200: {
      description: "Group listing",
      content: jsonContent(cursorResponseSchema("groups", GroupSchema)),
    },
    ...errorResponses([400]),
  },
});

const getGroupRoute = createRoute({
  method: "get",
  path: "/{id}",
  operationId: "getGroup",
  tags: ["Groups"],
  summary: "Fetch a group with its members",
  "x-arke-auth": "optional",
  "x-arke-related": ["PUT /groups/{id}", "POST /groups/{id}/members"],
  request: {
    params: entityIdParams("Group ULID"),
  },
  responses: {
    200: {
      description: "Group with members",
      content: jsonContent(z.object({ group: GroupWithMembersSchema })),
    },
    ...errorResponses([404]),
  },
});

const updateGroupRoute = createRoute({
  method: "put",
  path: "/{id}",
  operationId: "updateGroup",
  tags: ["Groups"],
  summary: "Update a group (admin or group admin)",
  "x-arke-auth": "required",
  "x-arke-related": ["GET /groups/{id}"],
  request: {
    params: entityIdParams("Group ULID"),
    body: {
      required: true,
      content: jsonContent(
        z.object({
          name: z.string().min(1).optional().describe("New group name"),
          type: z.enum(["org", "project", "editorial", "admin"]).optional().describe("New group type"),
        }),
      ),
    },
  },
  responses: {
    200: {
      description: "Group updated",
      content: jsonContent(z.object({ group: GroupSchema })),
    },
    ...errorResponses([400, 401, 403, 404]),
  },
});

const deleteGroupRoute = createRoute({
  method: "delete",
  path: "/{id}",
  operationId: "deleteGroup",
  tags: ["Groups"],
  summary: "Delete a group (admin or group admin)",
  "x-arke-auth": "required",
  request: {
    params: entityIdParams("Group ULID"),
  },
  responses: {
    204: {
      description: "Group deleted",
    },
    ...errorResponses([401, 403, 404]),
  },
});

const addMemberRoute = createRoute({
  method: "post",
  path: "/{id}/members",
  operationId: "addGroupMember",
  tags: ["Groups"],
  summary: "Add a member to a group (admin or group admin)",
  "x-arke-auth": "required",
  "x-arke-related": ["DELETE /groups/{id}/members/{actorId}"],
  request: {
    params: entityIdParams("Group ULID"),
    body: {
      required: true,
      content: jsonContent(
        z.object({
          actor_id: EntityIdParam.describe("Actor ULID to add"),
          role: z.enum(["member", "admin"]).optional().describe("Role (default: member)"),
        }),
      ),
    },
  },
  responses: {
    201: {
      description: "Member added",
      content: jsonContent(z.object({ member: GroupMemberSchema })),
    },
    ...errorResponses([400, 401, 403, 404]),
  },
});

const removeMemberRoute = createRoute({
  method: "delete",
  path: "/{id}/members/{actorId}",
  operationId: "removeGroupMember",
  tags: ["Groups"],
  summary: "Remove a member from a group (admin or group admin)",
  "x-arke-auth": "required",
  request: {
    params: z.object({
      id: pathParam("id", EntityIdParam, "Group ULID"),
      actorId: pathParam("actorId", EntityIdParam, "Actor ULID to remove"),
    }),
  },
  responses: {
    204: {
      description: "Member removed",
    },
    ...errorResponses([401, 403, 404]),
  },
});

/**
 * Checks whether the caller is a platform admin or an admin of the specified group.
 */
async function requireGroupAdmin(
  sql: ReturnType<typeof createSql>,
  actor: { id: string; isAdmin: boolean },
  groupId: string,
): Promise<void> {
  if (actor.isAdmin) return;

  const [membership] = await sql`
    SELECT role FROM group_memberships
    WHERE group_id = ${groupId} AND actor_id = ${actor.id} AND role_in_group = 'admin'
    LIMIT 1
  `;
  if (!membership) {
    throw new ApiError(403, "forbidden", "Admin or group admin access required");
  }
}

export const groupsRouter = createRouter();

groupsRouter.openapi(createGroupRoute, async (c) => {
  const actor = requireActor(c);
  const body = await parseJsonBody<Record<string, unknown>>(c);

  if (typeof body.name !== "string" || body.name.length === 0) {
    throw new ApiError(400, "missing_required_field", "Missing name");
  }
  const groupType = typeof body.type === "string" ? body.type : "project";
  if (!["org", "project", "editorial", "admin"].includes(groupType)) {
    throw new ApiError(400, "invalid_body", "Invalid type");
  }
  if (typeof body.network_id !== "string") {
    throw new ApiError(400, "missing_required_field", "Missing network_id");
  }

  if (!actor.isAdmin) {
    throw new ApiError(403, "forbidden", "Admin access required");
  }

  const id = generateUlid();
  const now = new Date().toISOString();
  const sql = createSql();

  const [,,,, rows] = await sql.transaction([
    ...setActorContext(sql, actor),
    sql.query(
      `
        INSERT INTO groups (id, name, type, network_id, created_by, created_at)
        VALUES ($1, $2, $3, $4, $5, $6::timestamptz)
        RETURNING *
      `,
      [id, body.name, groupType, body.network_id, actor.id, now],
    ),
  ]);

  const group = (rows as GroupRecord[])[0];
  if (!group) {
    throw new ApiError(500, "internal_error", "Failed to create group");
  }

  return c.json({ group }, 201);
});

groupsRouter.openapi(listGroupsRoute, async (c) => {
  const sql = createSql();
  const limit = parseLimit(c, { defaultValue: 50, maxValue: 200 });
  const cursor = parseCursorParam(c);
  const networkId = c.req.query("network_id");
  const type = c.req.query("type");

  const rows = await sql.query(
    `
      SELECT *
      FROM groups
      WHERE ($1::text IS NULL OR network_id = $1)
        AND ($2::text IS NULL OR type = $2)
        AND ($3::timestamptz IS NULL OR created_at < $3::timestamptz)
      ORDER BY created_at DESC
      LIMIT $4
    `,
    [networkId ?? null, type ?? null, cursor?.t ?? null, limit + 1],
  );

  const groups = (rows as GroupRecord[]).slice(0, limit);
  const next = (rows as GroupRecord[]).length > limit ? groups[groups.length - 1] : null;

  return c.json({
    groups,
    cursor: next ? encodeCursor({ t: next.created_at, i: next.id }) : null,
  }, 200);
});

groupsRouter.openapi(getGroupRoute, async (c) => {
  const sql = createSql();
  const groupId = c.req.param("id");

  const [group] = await sql`SELECT * FROM groups WHERE id = ${groupId} LIMIT 1`;
  if (!group) {
    throw new ApiError(404, "not_found", "Group not found");
  }

  const members = await sql`
    SELECT actor_id, group_id, role_in_group
    FROM group_memberships
    WHERE group_id = ${groupId}
    ORDER BY actor_id ASC
  `;

  return c.json({
    group: { ...group, members } as unknown as GroupRecord & { members: GroupMemberRecord[] },
  }, 200);
});

groupsRouter.openapi(updateGroupRoute, async (c) => {
  const actor = requireActor(c);
  const groupId = c.req.param("id");
  const body = await parseJsonBody<Record<string, unknown>>(c);
  const sql = createSql();

  await requireGroupAdmin(sql, actor, groupId);

  const sets: string[] = [];
  const params: unknown[] = [];
  let paramIdx = 1;

  if (typeof body.name === "string") {
    sets.push(`name = $${paramIdx++}`);
    params.push(body.name);
  }
  if (typeof body.type === "string") {
    if (!["org", "project", "editorial", "admin"].includes(body.type)) {
      throw new ApiError(400, "invalid_body", "Invalid type");
    }
    sets.push(`type = $${paramIdx++}`);
    params.push(body.type);
  }

  if (sets.length === 0) {
    throw new ApiError(400, "invalid_body", "No changes requested");
  }

  const idParamIdx = paramIdx++;
  params.push(groupId);

  const rows = await sql.query(
    `
      UPDATE groups
      SET ${sets.join(", ")}
      WHERE id = $${idParamIdx}
      RETURNING *
    `,
    params,
  );

  const updated = (rows as GroupRecord[])[0];
  if (!updated) {
    throw new ApiError(404, "not_found", "Group not found");
  }

  return c.json({ group: updated }, 200);
});

groupsRouter.openapi(deleteGroupRoute, async (c) => {
  const actor = requireActor(c);
  const groupId = c.req.param("id");
  const sql = createSql();

  await requireGroupAdmin(sql, actor, groupId);

  const results = await sql.transaction([
    ...setActorContext(sql, actor),
    sql`DELETE FROM groups WHERE id = ${groupId} RETURNING id`,
  ]);
  if ((results[results.length - 1] as Array<{ id: string }>).length === 0) {
    throw new ApiError(404, "not_found", "Group not found");
  }

  return new Response(null, { status: 204 });
});

groupsRouter.openapi(addMemberRoute, async (c) => {
  const actor = requireActor(c);
  const groupId = c.req.param("id");
  const body = await parseJsonBody<Record<string, unknown>>(c);
  const sql = createSql();

  if (typeof body.actor_id !== "string") {
    throw new ApiError(400, "missing_required_field", "Missing actor_id");
  }

  const roleValue = body.role_in_group ?? body.role;
  const role = typeof roleValue === "string" && ["member", "admin"].includes(roleValue)
    ? roleValue
    : "member";

  await requireGroupAdmin(sql, actor, groupId);

  // Verify group exists
  const [group] = await sql`SELECT id FROM groups WHERE id = ${groupId} LIMIT 1`;
  if (!group) {
    throw new ApiError(404, "not_found", "Group not found");
  }

  const results = await sql.transaction([
    ...setActorContext(sql, actor),
    sql.query(
      `INSERT INTO group_memberships (actor_id, group_id, role_in_group)
       VALUES ($2, $1, $3)
       ON CONFLICT (actor_id, group_id) DO UPDATE SET role_in_group = $3
       RETURNING actor_id, group_id, role_in_group`,
      [groupId, body.actor_id, role],
    ),
  ]);

  const member = (results[results.length - 1] as GroupMemberRecord[])[0];
  return c.json({ member }, 201);
});

groupsRouter.openapi(removeMemberRoute, async (c) => {
  const actor = requireActor(c);
  const groupId = c.req.param("id");
  const targetActorId = c.req.param("actorId");
  const sql = createSql();

  await requireGroupAdmin(sql, actor, groupId);

  const results = await sql.transaction([
    ...setActorContext(sql, actor),
    sql`
      DELETE FROM group_memberships
      WHERE group_id = ${groupId} AND actor_id = ${targetActorId}
      RETURNING group_id
    `,
  ]);

  if ((results[results.length - 1] as Array<{ group_id: string }>).length === 0) {
    // Distinguish group not found vs member not found
    const [group] = await sql`SELECT id FROM groups WHERE id = ${groupId} LIMIT 1`;
    if (!group) {
      throw new ApiError(404, "not_found", "Group not found");
    }
    throw new ApiError(404, "not_found", "Member not found in group");
  }

  return new Response(null, { status: 204 });
});
