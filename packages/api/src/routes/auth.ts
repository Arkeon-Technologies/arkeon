import { createRoute, z } from "@hono/zod-openapi";

import { createApiKey, sha256Hex } from "../lib/auth";
import { createRouter } from "../lib/openapi";
import { ApiError } from "../lib/errors";
import { requireActor, parseJsonBody } from "../lib/http";
import { setActorContext } from "../lib/actor-context";
import { generateUlid } from "../lib/ids";
import {
  ActorSchema,
  DateTimeSchema,
  EntityIdParam,
  errorResponses,
  jsonContent,
  pathParam,
  queryParam,
} from "../lib/schemas";
import { createSql } from "../lib/sql";

// --- Route definitions ---

const meRoute = createRoute({
  method: "get",
  path: "/me",
  operationId: "getAuthenticatedActor",
  tags: ["Auth"],
  summary: "Get the authenticated actor's profile",
  "x-arke-auth": "required",
  "x-arke-related": ["PUT /auth/me", "GET /auth/me/inbox"],
  "x-arke-rules": ["Operates on your own record only"],
  responses: {
    200: {
      description: "Authenticated actor",
      content: jsonContent(z.object({ actor: ActorSchema })),
    },
    ...errorResponses([401, 404]),
  },
});

const updateMeRoute = createRoute({
  method: "put",
  path: "/me",
  operationId: "updateAuthenticatedActor",
  tags: ["Auth"],
  summary: "Update the authenticated actor's properties",
  "x-arke-auth": "required",
  "x-arke-rules": ["Operates on your own record only", "Can only update properties — admin fields require PUT /actors/{id}", "Properties are shallow-merged: only provided keys are updated, omitted keys are preserved"],
  request: {
    body: {
      required: true,
      content: jsonContent(
        z.object({
          properties: z.record(z.string(), z.any()).optional(),
        }),
      ),
    },
  },
  responses: {
    200: {
      description: "Updated actor",
      content: jsonContent(z.object({ actor: ActorSchema })),
    },
    ...errorResponses([400, 401]),
  },
});

const createKeyRoute = createRoute({
  method: "post",
  path: "/keys",
  operationId: "createApiKey",
  tags: ["Auth"],
  summary: "Create a new API key for the authenticated actor",
  "x-arke-auth": "required",
  "x-arke-related": ["GET /auth/keys", "DELETE /auth/keys/{id}"],
  "x-arke-rules": ["Creates a key for your own actor only"],
  request: {
    body: {
      content: jsonContent(
        z.object({
          label: z.string().optional().describe("Optional key label"),
        }),
      ),
    },
  },
  responses: {
    201: {
      description: "API key created (key value returned once)",
      content: jsonContent(
        z.object({
          id: EntityIdParam,
          key_prefix: z.string(),
          api_key: z.string(),
          label: z.string().nullable(),
        }),
      ),
    },
    ...errorResponses([400, 401]),
  },
});

const listKeysRoute = createRoute({
  method: "get",
  path: "/keys",
  operationId: "listApiKeys",
  tags: ["Auth"],
  summary: "List API keys for the authenticated actor",
  "x-arke-auth": "required",
  "x-arke-related": ["POST /auth/keys", "DELETE /auth/keys/{id}"],
  "x-arke-rules": ["Lists only your own keys"],
  request: {
    query: z.object({
      include_revoked: queryParam(
        "include_revoked",
        z.enum(["true", "false"]).optional(),
        "Include revoked keys (default: false)",
      ),
    }),
  },
  responses: {
    200: {
      description: "API keys",
      content: jsonContent(
        z.object({
          keys: z.array(
            z.object({
              id: EntityIdParam,
              key_prefix: z.string(),
              label: z.string().nullable(),
              created_at: DateTimeSchema,
              last_used_at: DateTimeSchema.nullable(),
              revoked_at: DateTimeSchema.nullable(),
            }),
          ),
        }),
      ),
    },
    ...errorResponses([401]),
  },
});

const revokeKeyRoute = createRoute({
  method: "delete",
  path: "/keys/{id}",
  operationId: "revokeApiKey",
  tags: ["Auth"],
  summary: "Revoke an API key",
  "x-arke-auth": "required",
  "x-arke-related": ["GET /auth/keys"],
  "x-arke-rules": ["Can only revoke your own keys", "Cannot revoke the key currently in use"],
  request: {
    params: z.object({
      id: pathParam("id", EntityIdParam, "API key ULID"),
    }),
  },
  responses: {
    204: { description: "API key revoked" },
    ...errorResponses([401, 403, 404]),
  },
});

// --- Handlers ---

export const authRouter = createRouter();

authRouter.openapi(meRoute, async (c) => {
  const actor = requireActor(c);
  const sql = createSql();

  const results = await sql.transaction([
    ...setActorContext(sql, actor),
    sql`SELECT * FROM actors WHERE id = ${actor.id} LIMIT 1`,
  ]);

  const row = (results[results.length - 1] as Array<Record<string, unknown>>)[0];
  if (!row) {
    throw new ApiError(404, "not_found", "Authenticated actor not found");
  }

  return c.json({ actor: row }, 200);
});

authRouter.openapi(updateMeRoute, async (c) => {
  const actor = requireActor(c);
  const body = await parseJsonBody<Record<string, unknown>>(c);
  const sql = createSql();

  if (!body.properties || typeof body.properties !== "object") {
    throw new ApiError(400, "invalid_body", "properties must be an object");
  }

  const results = await sql.transaction([
    ...setActorContext(sql, actor),
    sql`
      UPDATE actors
      SET properties = properties || ${JSON.stringify(body.properties)}::jsonb,
          updated_at = NOW()
      WHERE id = ${actor.id}
      RETURNING *
    `,
  ]);

  const row = (results[results.length - 1] as Array<Record<string, unknown>>)[0];
  return c.json({ actor: row }, 200);
});

authRouter.openapi(createKeyRoute, async (c) => {
  const actor = requireActor(c);
  let body: Record<string, unknown> = {};
  if (c.req.header("content-length") !== "0") {
    body = await parseJsonBody<Record<string, unknown>>(c).catch(() => ({}));
  }
  const label =
    body.label === undefined ? null : typeof body.label === "string" ? body.label : null;
  if (body.label !== undefined && label === null) {
    throw new ApiError(400, "invalid_body", "Invalid label");
  }

  const apiKey = createApiKey();
  const apiKeyHash = await sha256Hex(apiKey.value);
  const keyId = generateUlid();
  const sql = createSql();

  const results = await sql.transaction([
    ...setActorContext(sql, actor),
    sql`
      INSERT INTO api_keys (id, key_prefix, key_hash, actor_id, label)
      VALUES (${keyId}, ${apiKey.keyPrefix}, ${apiKeyHash}, ${actor.id}, ${label})
      RETURNING id, key_prefix, label
    `,
  ]);

  return c.json(
    {
      ...(results[results.length - 1] as Array<Record<string, unknown>>)[0],
      api_key: apiKey.value,
    },
    201,
  );
});

authRouter.openapi(listKeysRoute, async (c) => {
  const actor = requireActor(c);
  const includeRevoked = c.req.query("include_revoked") === "true";
  const sql = createSql();

  const results = await sql.transaction([
    ...setActorContext(sql, actor),
    sql.query(
      `SELECT id, key_prefix, label, created_at, last_used_at, revoked_at
       FROM api_keys
       WHERE actor_id = $1
         AND ($2::boolean OR revoked_at IS NULL)
       ORDER BY created_at DESC`,
      [actor.id, includeRevoked],
    ),
  ]);

  return c.json({ keys: results[results.length - 1] }, 200);
});

authRouter.openapi(revokeKeyRoute, async (c) => {
  const actor = requireActor(c);
  const keyId = c.req.param("id");
  if (keyId === actor.apiKeyId) {
    throw new ApiError(403, "forbidden", "Cannot revoke the key currently in use");
  }

  const sql = createSql();
  const results = await sql.transaction([
    ...setActorContext(sql, actor),
    sql`
      UPDATE api_keys
      SET revoked_at = NOW()
      WHERE id = ${keyId}
        AND actor_id = ${actor.id}
        AND revoked_at IS NULL
      RETURNING id
    `,
  ]);

  if ((results[results.length - 1] as Array<{ id: string }>).length === 0) {
    throw new ApiError(404, "not_found", "API key not found");
  }

  return new Response(null, { status: 204 });
});
