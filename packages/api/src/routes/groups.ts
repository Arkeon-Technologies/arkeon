import { createRoute, z } from "@hono/zod-openapi";

import { ApiError } from "../lib/errors";
import { requireActor, parseJsonBody } from "../lib/http";
import { generateUlid } from "../lib/ids";
import { createRouter } from "../lib/openapi";
import { setActorContext, isNetworkAdmin } from "../lib/permissions";
import {
  DateTimeSchema,
  EntityIdParam,
  errorResponses,
  jsonContent,
  pathParam,
} from "../lib/schemas";
import { createSql } from "../lib/sql";

const GroupSchema = z.object({
  id: EntityIdParam,
  network_id: EntityIdParam,
  name: z.string(),
  description: z.string().nullable(),
  parent_group_id: EntityIdParam.nullable(),
  system_group: z.boolean(),
  can_invite: z.boolean(),
  created_at: DateTimeSchema,
});

const GroupMembershipSchema = z.object({
  group_id: EntityIdParam,
  actor_id: EntityIdParam,
  granted_by: EntityIdParam,
  created_at: DateTimeSchema,
});

// --- Route definitions ---

const createGroupRoute = createRoute({
  method: "post",
  path: "/",
  operationId: "createGroup",
  tags: ["Groups"],
  summary: "Create a group (admin only)",
  "x-arke-auth": "required",
  "x-arke-related": ["GET /groups", "GET /groups/{id}"],
  request: {
    body: {
      required: true,
      content: jsonContent(
        z.object({
          name: z.string().min(1).max(255).describe("Group name"),
          description: z.string().max(4096).optional().describe("Group description"),
          parent_group_id: EntityIdParam.optional().describe("Parent group ULID"),
          can_invite: z.boolean().optional().describe("Whether members can generate invites"),
        }),
      ),
    },
  },
  responses: {
    201: {
      description: "Group created",
      content: jsonContent(z.object({ group: GroupSchema })),
    },
    ...errorResponses([400, 401, 403, 404, 409]),
  },
});

const listGroupsRoute = createRoute({
  method: "get",
  path: "/",
  operationId: "listGroups",
  tags: ["Groups"],
  summary: "List all groups in the network",
  "x-arke-auth": "required",
  "x-arke-related": ["GET /groups/{id}", "POST /groups"],
  responses: {
    200: {
      description: "List of groups",
      content: jsonContent(z.object({ groups: z.array(GroupSchema) })),
    },
    ...errorResponses([401]),
  },
});

const getGroupRoute = createRoute({
  method: "get",
  path: "/{id}",
  operationId: "getGroup",
  tags: ["Groups"],
  summary: "Get a group by ID",
  "x-arke-auth": "required",
  "x-arke-related": ["GET /groups", "GET /groups/{id}/members"],
  request: {
    params: z.object({
      id: pathParam("id", EntityIdParam, "Group ULID"),
    }),
  },
  responses: {
    200: {
      description: "Group details",
      content: jsonContent(z.object({ group: GroupSchema })),
    },
    ...errorResponses([401, 404]),
  },
});

const updateGroupRoute = createRoute({
  method: "put",
  path: "/{id}",
  operationId: "updateGroup",
  tags: ["Groups"],
  summary: "Update a group (admin only)",
  "x-arke-auth": "required",
  "x-arke-related": ["GET /groups/{id}"],
  request: {
    params: z.object({
      id: pathParam("id", EntityIdParam, "Group ULID"),
    }),
    body: {
      required: true,
      content: jsonContent(
        z.object({
          name: z.string().min(1).max(255).optional().describe("Group name"),
          description: z.string().max(4096).nullable().optional().describe("Group description"),
          parent_group_id: EntityIdParam.nullable().optional().describe("Parent group ULID or null"),
          can_invite: z.boolean().optional().describe("Whether members can generate invites"),
        }),
      ),
    },
  },
  responses: {
    200: {
      description: "Group updated",
      content: jsonContent(z.object({ group: GroupSchema })),
    },
    ...errorResponses([400, 401, 403, 404, 409]),
  },
});

const deleteGroupRoute = createRoute({
  method: "delete",
  path: "/{id}",
  operationId: "deleteGroup",
  tags: ["Groups"],
  summary: "Delete a group (admin only)",
  "x-arke-auth": "required",
  "x-arke-related": ["GET /groups"],
  request: {
    params: z.object({
      id: pathParam("id", EntityIdParam, "Group ULID"),
    }),
  },
  responses: {
    204: {
      description: "Group deleted",
    },
    ...errorResponses([401, 403, 404, 409]),
  },
});

const addMemberRoute = createRoute({
  method: "post",
  path: "/{id}/members",
  operationId: "addGroupMember",
  tags: ["Groups"],
  summary: "Add a member to a group (admin only)",
  "x-arke-auth": "required",
  "x-arke-related": ["GET /groups/{id}/members", "DELETE /groups/{id}/members/{actorId}"],
  request: {
    params: z.object({
      id: pathParam("id", EntityIdParam, "Group ULID"),
    }),
    body: {
      required: true,
      content: jsonContent(
        z.object({
          actor_id: EntityIdParam.describe("Actor ULID to add"),
        }),
      ),
    },
  },
  responses: {
    201: {
      description: "Member added",
      content: jsonContent(GroupMembershipSchema),
    },
    ...errorResponses([400, 401, 403, 404]),
  },
});

const listMembersRoute = createRoute({
  method: "get",
  path: "/{id}/members",
  operationId: "listGroupMembers",
  tags: ["Groups"],
  summary: "List members of a group",
  "x-arke-auth": "required",
  "x-arke-related": ["GET /groups/{id}", "POST /groups/{id}/members"],
  request: {
    params: z.object({
      id: pathParam("id", EntityIdParam, "Group ULID"),
    }),
  },
  responses: {
    200: {
      description: "Group members",
      content: jsonContent(z.object({ members: z.array(GroupMembershipSchema) })),
    },
    ...errorResponses([401, 404]),
  },
});

const removeMemberRoute = createRoute({
  method: "delete",
  path: "/{id}/members/{actorId}",
  operationId: "removeGroupMember",
  tags: ["Groups"],
  summary: "Remove a member from a group (admin only)",
  "x-arke-auth": "required",
  "x-arke-related": ["GET /groups/{id}/members", "POST /groups/{id}/members"],
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
    ...errorResponses([401, 403, 404, 409]),
  },
});

// --- Helpers ---

async function requireNetworkAdmin(actorId: string): Promise<void> {
  if (!(await isNetworkAdmin(actorId))) {
    throw new ApiError(403, "forbidden", "Network admin required");
  }
}

async function detectCycle(
  sql: ReturnType<typeof createSql>,
  actor: { id: string; groups: string[] },
  groupId: string,
  parentGroupId: string,
): Promise<void> {
  const networkId = process.env.ROOT_COMMONS_ID!;
  let current: string | null = parentGroupId;
  while (current) {
    if (current === groupId) {
      throw new ApiError(409, "conflict", "Circular group hierarchy");
    }
    const [,, rows] = await sql.transaction([
      ...setActorContext(sql, actor),
      sql.query(
        `SELECT parent_group_id FROM groups WHERE id = $1 AND network_id = $2 LIMIT 1`,
        [current, networkId],
      ),
    ]);
    const row = (rows as Array<{ parent_group_id: string | null }>)[0];
    current = row?.parent_group_id ?? null;
  }
}

// --- Router ---

export const groupsRouter = createRouter();

// POST / — Create group
groupsRouter.openapi(createGroupRoute, async (c) => {
  const actor = requireActor(c);
  await requireNetworkAdmin(actor.id);

  const body = await parseJsonBody<Record<string, unknown>>(c);
  const name = body.name;
  const description = body.description ?? null;
  const parentGroupId = body.parent_group_id ?? null;
  const canInvite = body.can_invite ?? false;

  if (typeof name !== "string" || name.length < 1 || name.length > 255) {
    throw new ApiError(400, "invalid_body", "Invalid group name");
  }

  const networkId = process.env.ROOT_COMMONS_ID!;
  const sql = createSql();

  // Validate parent exists in same network
  if (parentGroupId) {
    const [,, parentRows] = await sql.transaction([
      ...setActorContext(sql, actor),
      sql.query(
        `SELECT id FROM groups WHERE id = $1 AND network_id = $2 LIMIT 1`,
        [parentGroupId, networkId],
      ),
    ]);
    if ((parentRows as Array<Record<string, unknown>>).length === 0) {
      throw new ApiError(404, "not_found", "Parent group not found");
    }
  }

  const id = generateUlid();
  const now = new Date().toISOString();

  const [,, rows] = await sql.transaction([
    ...setActorContext(sql, actor),
    sql.query(
      `INSERT INTO groups (id, network_id, name, description, parent_group_id, system_group, can_invite, created_at)
       VALUES ($1, $2, $3, $4, $5, false, $6, $7::timestamptz)
       RETURNING *`,
      [id, networkId, name, description, parentGroupId, canInvite, now],
    ),
  ]);

  return c.json({ group: (rows as Array<Record<string, unknown>>)[0] }, 201);
});

// GET / — List groups
groupsRouter.openapi(listGroupsRoute, async (c) => {
  const actor = requireActor(c);
  const networkId = process.env.ROOT_COMMONS_ID!;
  const sql = createSql();

  const [,, rows] = await sql.transaction([
    ...setActorContext(sql, actor),
    sql.query(
      `SELECT * FROM groups WHERE network_id = $1 ORDER BY created_at ASC`,
      [networkId],
    ),
  ]);

  return c.json({ groups: rows as Array<Record<string, unknown>> }, 200);
});

// GET /:id — Get group
groupsRouter.openapi(getGroupRoute, async (c) => {
  const actor = requireActor(c);
  const groupId = c.req.param("id");
  const networkId = process.env.ROOT_COMMONS_ID!;
  const sql = createSql();

  const [,, rows] = await sql.transaction([
    ...setActorContext(sql, actor),
    sql.query(
      `SELECT * FROM groups WHERE id = $1 AND network_id = $2 LIMIT 1`,
      [groupId, networkId],
    ),
  ]);

  const group = (rows as Array<Record<string, unknown>>)[0];
  if (!group) {
    throw new ApiError(404, "not_found", "Group not found");
  }

  return c.json({ group }, 200);
});

// PUT /:id — Update group
groupsRouter.openapi(updateGroupRoute, async (c) => {
  const actor = requireActor(c);
  await requireNetworkAdmin(actor.id);

  const groupId = c.req.param("id");
  const networkId = process.env.ROOT_COMMONS_ID!;
  const sql = createSql();

  // Fetch existing group
  const [,, existingRows] = await sql.transaction([
    ...setActorContext(sql, actor),
    sql.query(
      `SELECT * FROM groups WHERE id = $1 AND network_id = $2 LIMIT 1`,
      [groupId, networkId],
    ),
  ]);
  const existing = (existingRows as Array<Record<string, unknown>>)[0];
  if (!existing) {
    throw new ApiError(404, "not_found", "Group not found");
  }

  const body = await parseJsonBody<Record<string, unknown>>(c);
  const name = body.name !== undefined ? body.name : existing.name;
  const description = body.description !== undefined ? body.description : existing.description;
  const parentGroupId = body.parent_group_id !== undefined ? body.parent_group_id : existing.parent_group_id;
  const canInvite = body.can_invite !== undefined ? body.can_invite : existing.can_invite;

  // Cannot modify system_group via update
  if (body.system_group !== undefined) {
    throw new ApiError(400, "invalid_body", "Cannot modify system_group flag");
  }

  // Validate parent exists
  if (parentGroupId) {
    const [,, parentRows] = await sql.transaction([
      ...setActorContext(sql, actor),
      sql.query(
        `SELECT id FROM groups WHERE id = $1 AND network_id = $2 LIMIT 1`,
        [parentGroupId, networkId],
      ),
    ]);
    if ((parentRows as Array<Record<string, unknown>>).length === 0) {
      throw new ApiError(404, "not_found", "Parent group not found");
    }

    // Detect cycles
    await detectCycle(sql, actor, groupId, parentGroupId as string);
  }

  const now = new Date().toISOString();
  const [,, rows] = await sql.transaction([
    ...setActorContext(sql, actor),
    sql.query(
      `UPDATE groups
       SET name = $1, description = $2, parent_group_id = $3, can_invite = $4
       WHERE id = $5 AND network_id = $6
       RETURNING *`,
      [name, description, parentGroupId, canInvite, groupId, networkId],
    ),
  ]);

  return c.json({ group: (rows as Array<Record<string, unknown>>)[0] }, 200);
});

// DELETE /:id — Delete group
groupsRouter.openapi(deleteGroupRoute, async (c) => {
  const actor = requireActor(c);
  await requireNetworkAdmin(actor.id);

  const groupId = c.req.param("id");
  const networkId = process.env.ROOT_COMMONS_ID!;
  const sql = createSql();

  // Fetch group
  const [,, existingRows] = await sql.transaction([
    ...setActorContext(sql, actor),
    sql.query(
      `SELECT * FROM groups WHERE id = $1 AND network_id = $2 LIMIT 1`,
      [groupId, networkId],
    ),
  ]);
  const existing = (existingRows as Array<Record<string, unknown>>)[0];
  if (!existing) {
    throw new ApiError(404, "not_found", "Group not found");
  }

  if (existing.system_group) {
    throw new ApiError(403, "forbidden", "Cannot delete a system group");
  }

  // Check for child groups
  const [,, childRows] = await sql.transaction([
    ...setActorContext(sql, actor),
    sql.query(
      `SELECT id FROM groups WHERE parent_group_id = $1 AND network_id = $2 LIMIT 1`,
      [groupId, networkId],
    ),
  ]);
  if ((childRows as Array<Record<string, unknown>>).length > 0) {
    throw new ApiError(409, "conflict", "Cannot delete group with child groups");
  }

  await sql.transaction([
    ...setActorContext(sql, actor),
    sql`DELETE FROM group_memberships WHERE group_id = ${groupId}`,
    sql`DELETE FROM groups WHERE id = ${groupId} AND network_id = ${networkId}`,
  ]);

  return new Response(null, { status: 204 });
});

// POST /:id/members — Add member
groupsRouter.openapi(addMemberRoute, async (c) => {
  const actor = requireActor(c);
  await requireNetworkAdmin(actor.id);

  const groupId = c.req.param("id");
  const networkId = process.env.ROOT_COMMONS_ID!;
  const sql = createSql();

  // Verify group exists
  const [,, groupRows] = await sql.transaction([
    ...setActorContext(sql, actor),
    sql.query(
      `SELECT id FROM groups WHERE id = $1 AND network_id = $2 LIMIT 1`,
      [groupId, networkId],
    ),
  ]);
  if ((groupRows as Array<Record<string, unknown>>).length === 0) {
    throw new ApiError(404, "not_found", "Group not found");
  }

  const body = await parseJsonBody<Record<string, unknown>>(c);
  const actorId = body.actor_id;
  if (typeof actorId !== "string") {
    throw new ApiError(400, "invalid_body", "actor_id is required");
  }

  const now = new Date().toISOString();
  const [,, rows] = await sql.transaction([
    ...setActorContext(sql, actor),
    sql.query(
      `INSERT INTO group_memberships (group_id, actor_id, granted_by, created_at)
       VALUES ($1, $2, $3, $4::timestamptz)
       ON CONFLICT (group_id, actor_id) DO NOTHING
       RETURNING *`,
      [groupId, actorId, actor.id, now],
    ),
  ]);

  const membership = (rows as Array<Record<string, unknown>>)[0];
  // If ON CONFLICT hit, fetch existing
  if (!membership) {
    const [,, existingRows] = await sql.transaction([
      ...setActorContext(sql, actor),
      sql.query(
        `SELECT * FROM group_memberships WHERE group_id = $1 AND actor_id = $2 LIMIT 1`,
        [groupId, actorId],
      ),
    ]);
    return c.json((existingRows as Array<Record<string, unknown>>)[0]!, 201);
  }

  return c.json(membership, 201);
});

// GET /:id/members — List members
groupsRouter.openapi(listMembersRoute, async (c) => {
  const actor = requireActor(c);
  const groupId = c.req.param("id");
  const networkId = process.env.ROOT_COMMONS_ID!;
  const sql = createSql();

  // Verify group exists
  const [,, groupRows] = await sql.transaction([
    ...setActorContext(sql, actor),
    sql.query(
      `SELECT id FROM groups WHERE id = $1 AND network_id = $2 LIMIT 1`,
      [groupId, networkId],
    ),
  ]);
  if ((groupRows as Array<Record<string, unknown>>).length === 0) {
    throw new ApiError(404, "not_found", "Group not found");
  }

  const [,, rows] = await sql.transaction([
    ...setActorContext(sql, actor),
    sql.query(
      `SELECT * FROM group_memberships WHERE group_id = $1 ORDER BY created_at ASC`,
      [groupId],
    ),
  ]);

  return c.json({ members: rows as Array<Record<string, unknown>> }, 200);
});

// DELETE /:id/members/:actorId — Remove member
groupsRouter.openapi(removeMemberRoute, async (c) => {
  const actor = requireActor(c);
  await requireNetworkAdmin(actor.id);

  const groupId = c.req.param("id");
  const actorId = c.req.param("actorId");
  const networkId = process.env.ROOT_COMMONS_ID!;
  const sql = createSql();

  // Verify group exists and check if it's the admins group
  const [,, groupRows] = await sql.transaction([
    ...setActorContext(sql, actor),
    sql.query(
      `SELECT id, name, system_group FROM groups WHERE id = $1 AND network_id = $2 LIMIT 1`,
      [groupId, networkId],
    ),
  ]);
  const group = (groupRows as Array<{ id: string; name: string; system_group: boolean }>)[0];
  if (!group) {
    throw new ApiError(404, "not_found", "Group not found");
  }

  // Guard: cannot remove last member of "admins" group
  if (group.name === "admins") {
    const [,, countRows] = await sql.transaction([
      ...setActorContext(sql, actor),
      sql.query(
        `SELECT COUNT(*)::int AS count FROM group_memberships WHERE group_id = $1`,
        [groupId],
      ),
    ]);
    const count = (countRows as Array<{ count: number }>)[0]?.count ?? 0;
    if (count <= 1) {
      throw new ApiError(409, "conflict", "Cannot remove the last member of the admins group");
    }
  }

  // Verify membership exists
  const [,, memberRows] = await sql.transaction([
    ...setActorContext(sql, actor),
    sql.query(
      `SELECT 1 FROM group_memberships WHERE group_id = $1 AND actor_id = $2 LIMIT 1`,
      [groupId, actorId],
    ),
  ]);
  if ((memberRows as Array<Record<string, unknown>>).length === 0) {
    throw new ApiError(404, "not_found", "Membership not found");
  }

  await sql.transaction([
    ...setActorContext(sql, actor),
    sql.query(
      `DELETE FROM group_memberships WHERE group_id = $1 AND actor_id = $2`,
      [groupId, actorId],
    ),
  ]);

  return new Response(null, { status: 204 });
});
