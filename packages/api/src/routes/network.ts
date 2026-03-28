import { createRoute, z } from "@hono/zod-openapi";

import { ApiError } from "../lib/errors";
import { requireActor, parseJsonBody } from "../lib/http";
import { createRouter } from "../lib/openapi";
import { isNetworkAdmin, setActorContext } from "../lib/permissions";
import { EntityIdParam, errorResponses, jsonContent } from "../lib/schemas";
import { createSql } from "../lib/sql";

const NetworkConfigSchema = z
  .object({
    id: EntityIdParam,
    name: z.string(),
    registration_mode: z.string(),
    default_visibility: z.string(),
    pow_difficulty: z.number().int(),
    policy_mutability: z.boolean(),
  })
  .openapi("NetworkConfig");

const NetworkUpdateBody = z.object({
  name: z.string().optional().describe("Network display name"),
  registration_mode: z.string().optional().describe("Registration mode (open, invite, closed)"),
  default_visibility: z.string().optional().describe("Default entity visibility"),
  pow_difficulty: z.number().int().optional().describe("Proof-of-work difficulty"),
});

const getNetworkRoute = createRoute({
  method: "get",
  path: "/",
  operationId: "getNetworkConfig",
  tags: ["Network"],
  summary: "Get network configuration",
  "x-arke-auth": "none",
  "x-arke-related": ["PUT /network"],
  responses: {
    200: {
      description: "Network configuration",
      content: jsonContent(NetworkConfigSchema),
    },
    ...errorResponses([404, 500]),
  },
});

const updateNetworkRoute = createRoute({
  method: "put",
  path: "/",
  operationId: "updateNetworkConfig",
  tags: ["Network"],
  summary: "Update network configuration (admin only)",
  "x-arke-auth": "required",
  "x-arke-related": ["GET /network"],
  request: {
    body: {
      required: true,
      content: jsonContent(NetworkUpdateBody),
    },
  },
  responses: {
    200: {
      description: "Updated network configuration",
      content: jsonContent(NetworkConfigSchema),
    },
    ...errorResponses([400, 401, 403, 409]),
  },
});

function extractConfig(id: string, properties: Record<string, unknown>) {
  return {
    id,
    name: (properties.name ?? properties.label ?? "Arke Network") as string,
    registration_mode: (properties.registration_mode ?? "open") as string,
    default_visibility: (properties.default_visibility ?? "public") as string,
    pow_difficulty: (typeof properties.pow_difficulty === "number" ? properties.pow_difficulty : 22) as number,
    policy_mutability: (properties.policy_mutability !== false) as boolean,
  };
}

export const networkRouter = createRouter();

networkRouter.openapi(getNetworkRoute, async (c) => {
  const sql = createSql();
  const rootCommonsId = process.env.ROOT_COMMONS_ID;
  if (!rootCommonsId) {
    throw new ApiError(500, "misconfigured", "ROOT_COMMONS_ID not set");
  }

  const [rows] = await sql.transaction([
    sql`SELECT id, properties FROM entities WHERE id = ${rootCommonsId} LIMIT 1`,
  ]);

  const row = (rows as Array<{ id: string; properties: unknown }>)[0];
  if (!row) {
    throw new ApiError(404, "not_found", "Root commons not found");
  }
  const props: Record<string, unknown> =
    typeof row.properties === "string" ? JSON.parse(row.properties) : (row.properties as Record<string, unknown>);

  return c.json(extractConfig(row.id, props), 200);
});

networkRouter.openapi(updateNetworkRoute, async (c) => {
  const actor = requireActor(c);

  const admin = await isNetworkAdmin(actor.id);
  if (!admin) {
    throw new ApiError(403, "forbidden", "Network admin access required");
  }

  const body = await parseJsonBody<{
    name?: string;
    registration_mode?: string;
    default_visibility?: string;
    pow_difficulty?: number;
  }>(c);

  const sql = createSql();
  const rootCommonsId = process.env.ROOT_COMMONS_ID;
  if (!rootCommonsId) {
    throw new ApiError(500, "misconfigured", "ROOT_COMMONS_ID not set");
  }

  const actorCtx = { id: actor.id, groups: actor.groups ?? [] };
  const [, , currentRows] = await sql.transaction([
    ...setActorContext(sql, actorCtx),
    sql`SELECT id, properties FROM entities WHERE id = ${rootCommonsId} LIMIT 1`,
  ]);

  const current = (currentRows as Array<{ id: string; properties: Record<string, unknown> }>)[0];
  if (!current) {
    throw new ApiError(404, "not_found", "Root commons not found");
  }

  const props: Record<string, unknown> =
    typeof current.properties === "string"
      ? JSON.parse(current.properties)
      : current.properties;

  if (props.policy_mutability === false) {
    if (body.registration_mode !== undefined || body.default_visibility !== undefined) {
      throw new ApiError(
        409,
        "policy_immutable",
        "Cannot change registration_mode or default_visibility when policy_mutability is false",
      );
    }
  }

  const merged = { ...props };
  if (body.name !== undefined) merged.name = body.name;
  if (body.registration_mode !== undefined) merged.registration_mode = body.registration_mode;
  if (body.default_visibility !== undefined) merged.default_visibility = body.default_visibility;
  if (body.pow_difficulty !== undefined) merged.pow_difficulty = body.pow_difficulty;

  const [, , updatedRows] = await sql.transaction([
    ...setActorContext(sql, actorCtx),
    sql.query(
      `UPDATE entities SET properties = $1::jsonb WHERE id = $2 RETURNING id, properties`,
      [JSON.stringify(merged), rootCommonsId],
    ),
  ]);

  const updated = (updatedRows as Array<{ id: string; properties: unknown }>)[0];
  if (!updated) {
    throw new ApiError(500, "update_failed", "Failed to update network configuration");
  }
  const updatedProps: Record<string, unknown> =
    typeof updated.properties === "string" ? JSON.parse(updated.properties) : (updated.properties as Record<string, unknown>);

  return c.json(extractConfig(updated.id, updatedProps), 200);
});
