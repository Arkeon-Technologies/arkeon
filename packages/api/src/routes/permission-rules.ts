import { createRoute, z } from "@hono/zod-openapi";

import { ApiError } from "../lib/errors";
import { requireActor, parseJsonBody } from "../lib/http";
import { setActorContext, isNetworkAdmin } from "../lib/permissions";
import { generateUlid } from "../lib/ids";
import { createRouter } from "../lib/openapi";
import { createSql } from "../lib/sql";
import {
  DateTimeSchema,
  EntityIdParam,
  errorResponses,
  jsonContent,
  pathParam,
} from "../lib/schemas";

const GrantAccess = z.enum(["view", "edit", "contribute"]);

const PermissionRuleSchema = z.object({
  id: EntityIdParam,
  match_kind: z.string().nullable(),
  match_type: z.string().nullable(),
  match_commons: EntityIdParam.nullable(),
  match_property: z.string().nullable(),
  grant_group_id: EntityIdParam.nullable(),
  grant_access: GrantAccess,
  created_at: DateTimeSchema,
});

const createRuleRoute = createRoute({
  method: "post",
  path: "/",
  operationId: "createPermissionRule",
  tags: ["Permission Rules"],
  summary: "Create a permission rule and materialize access grants",
  "x-arke-auth": "required",
  "x-arke-related": [
    "GET /permission-rules",
    "DELETE /permission-rules/{id}",
  ],
  request: {
    body: {
      required: true,
      content: jsonContent(
        z.object({
          match_kind: z.string().optional().describe("Match entities with this kind"),
          match_type: z.string().optional().describe("Match entities with this type"),
          match_commons: z.string().optional().describe("Match entities in this commons"),
          match_property: z.string().optional().describe("Match entities with this property key present"),
          grant_group_id: z.string().optional().describe("Group to grant access to"),
          grant_access: GrantAccess.describe("Access level to grant: view, edit, or contribute"),
        }),
      ),
    },
  },
  responses: {
    201: {
      description: "Rule created and materialized",
      content: jsonContent(
        z.object({
          rule: PermissionRuleSchema,
          materialized_count: z.number().int().describe("Number of entity_access rows materialized"),
        }),
      ),
    },
    ...errorResponses([400, 401, 403]),
  },
});

const listRulesRoute = createRoute({
  method: "get",
  path: "/",
  operationId: "listPermissionRules",
  tags: ["Permission Rules"],
  summary: "List all permission rules",
  "x-arke-auth": "required",
  "x-arke-related": [
    "POST /permission-rules",
    "DELETE /permission-rules/{id}",
  ],
  request: {},
  responses: {
    200: {
      description: "List of permission rules",
      content: jsonContent(
        z.object({
          rules: z.array(PermissionRuleSchema),
        }),
      ),
    },
    ...errorResponses([401]),
  },
});

const deleteRuleRoute = createRoute({
  method: "delete",
  path: "/{id}",
  operationId: "deletePermissionRule",
  tags: ["Permission Rules"],
  summary: "Delete a permission rule (CASCADE cleans up entity_access)",
  "x-arke-auth": "required",
  "x-arke-related": [
    "POST /permission-rules",
    "GET /permission-rules",
  ],
  request: {
    params: z.object({
      id: pathParam("id", EntityIdParam, "Permission rule ULID"),
    }),
  },
  responses: {
    204: {
      description: "Rule deleted",
    },
    ...errorResponses([401, 403, 404]),
  },
});

export const permissionRulesRouter = createRouter();

permissionRulesRouter.openapi(createRuleRoute, async (c) => {
  const actor = requireActor(c);

  const admin = await isNetworkAdmin(actor.id);
  if (!admin) {
    throw new ApiError(403, "forbidden", "Only network admins can create permission rules");
  }

  const body = await parseJsonBody<Record<string, unknown>>(c);
  const matchKind = typeof body.match_kind === "string" ? body.match_kind : null;
  const matchType = typeof body.match_type === "string" ? body.match_type : null;
  const matchCommons = typeof body.match_commons === "string" ? body.match_commons : null;
  const matchProperty = typeof body.match_property === "string" ? body.match_property : null;
  const grantGroupId = typeof body.grant_group_id === "string" ? body.grant_group_id : null;
  const grantAccess = body.grant_access;

  if (typeof grantAccess !== "string" || !["view", "edit", "contribute"].includes(grantAccess)) {
    throw new ApiError(400, "invalid_body", "grant_access must be one of: view, edit, contribute");
  }

  const ruleId = generateUlid();
  const now = new Date().toISOString();
  const sql = createSql();

  const [, , rows] = await sql.transaction([
    ...setActorContext(sql, actor),
    sql`
      INSERT INTO permission_rules (id, network_id, match_kind, match_type, match_commons, match_property, grant_group_id, grant_access, created_at)
      VALUES (${ruleId}, ${process.env.ROOT_COMMONS_ID!}, ${matchKind}, ${matchType}, ${matchCommons}, ${matchProperty}, ${grantGroupId}, ${grantAccess}, ${now}::timestamptz)
      RETURNING *
    `,
  ]);

  const rule = (rows as Array<Record<string, unknown>>)[0];

  // Materialize the rule in a separate transaction.
  // materialize_rule is SECURITY DEFINER so it doesn't need actor context.
  const [, countRows] = await sql.transaction([
    sql`SELECT set_config('app.actor_id', '', true)`,
    sql`SELECT materialize_rule(${ruleId}) AS count`,
  ]);
  const materializedCount = (countRows as Array<{ count: number }>)[0]?.count ?? 0;

  return c.json({ rule, materialized_count: materializedCount }, 201);
});

permissionRulesRouter.openapi(listRulesRoute, async (c) => {
  const actor = requireActor(c);
  const sql = createSql();

  const [, , rows] = await sql.transaction([
    ...setActorContext(sql, actor),
    sql`SELECT id, match_kind, match_type, match_commons, match_property, grant_group_id, grant_access, created_at FROM permission_rules ORDER BY created_at DESC`,
  ]);

  return c.json({ rules: rows as Array<Record<string, unknown>> }, 200);
});

permissionRulesRouter.openapi(deleteRuleRoute, async (c) => {
  const actor = requireActor(c);

  const admin = await isNetworkAdmin(actor.id);
  if (!admin) {
    throw new ApiError(403, "forbidden", "Only network admins can delete permission rules");
  }

  const ruleId = c.req.param("id");
  const sql = createSql();

  const [, , rows] = await sql.transaction([
    ...setActorContext(sql, actor),
    sql`DELETE FROM permission_rules WHERE id = ${ruleId} RETURNING id`,
  ]);

  if ((rows as Array<Record<string, unknown>>).length === 0) {
    throw new ApiError(404, "not_found", "Permission rule not found");
  }

  return new Response(null, { status: 204 });
});
