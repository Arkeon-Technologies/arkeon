import { createRoute, z } from "@hono/zod-openapi";

import { encodeCursor } from "../lib/cursor";
import { ApiError } from "../lib/errors";
import {
  requireActor,
  parseJsonBody,
  parseLimit,
  parseCursorParam,
  parseOptionalTimestamp,
} from "../lib/http";
import { generateUlid } from "../lib/ids";
import { createRouter } from "../lib/openapi";
import { createApiKey, sha256Hex } from "../lib/auth";
import {
  ActorSchema,
  ClassificationLevel,
  DateTimeSchema,
  EntityIdParam,
  JsonObjectSchema,
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

type ActorRecord = {
  id: string;
  kind: string;
  max_read_level: number;
  max_write_level: number;
  is_admin: boolean;
  can_publish_public: boolean;
  owner_id: string | null;
  properties: Record<string, unknown>;
  status: string;
  created_at: string;
  updated_at: string;
};

const ActorActivitySchema = z.object({
  id: z.number().int(),
  entity_id: EntityIdParam,
  actor_id: EntityIdParam,
  action: z.string(),
  detail: z.any(),
  ts: DateTimeSchema,
  entity: z.object({
    id: EntityIdParam,
    kind: z.string(),
    type: z.string(),
    properties: z.object({
      label: z.any().optional(),
    }),
  }),
});

const createActorRoute = createRoute({
  method: "post",
  path: "/",
  operationId: "createActor",
  tags: ["Actors"],
  summary: "Create a new actor and its initial API key",
  "x-arke-auth": "required",
  "x-arke-related": ["GET /actors/{id}", "GET /actors"],
  request: {
    body: {
      required: true,
      content: jsonContent(
        z.object({
          kind: z.enum(["user", "agent"]).describe("Actor kind: user or agent"),
          properties: JsonObjectSchema.optional().describe("Actor properties"),
          max_read_level: ClassificationLevel.optional().describe("Max read level (0-4)"),
          max_write_level: ClassificationLevel.optional().describe("Max write level (0-4)"),
          can_publish_public: z.boolean().optional().describe("Whether actor can publish public content"),
        }),
      ),
    },
  },
  responses: {
    201: {
      description: "Actor created with initial API key",
      content: jsonContent(
        z.object({
          actor: ActorSchema,
          api_key: z.string().describe("Plaintext API key (only shown once)"),
        }),
      ),
    },
    ...errorResponses([400, 401, 403]),
  },
});

const listActorsRoute = createRoute({
  method: "get",
  path: "/",
  operationId: "listActors",
  tags: ["Actors"],
  summary: "List actors (paginated)",
  "x-arke-auth": "required",
  "x-arke-related": ["POST /actors", "GET /actors/{id}"],
  request: {
    query: paginationQuerySchema(50, 200).extend({
      status: queryParam(
        "status",
        z.enum(["active", "suspended", "deactivated"]).optional(),
        "Filter by status",
      ),
      kind: queryParam(
        "kind",
        z.enum(["user", "agent"]).optional(),
        "Filter by kind",
      ),
    }),
  },
  responses: {
    200: {
      description: "Actor listing",
      content: jsonContent(cursorResponseSchema("actors", ActorSchema)),
    },
    ...errorResponses([400, 401]),
  },
});

const getActorRoute = createRoute({
  method: "get",
  path: "/{id}",
  operationId: "getActor",
  tags: ["Actors"],
  summary: "Fetch a single actor by ID",
  "x-arke-auth": "required",
  "x-arke-related": ["PUT /actors/{id}", "DELETE /actors/{id}"],
  request: {
    params: entityIdParams("Actor ULID"),
  },
  responses: {
    200: {
      description: "Actor details",
      content: jsonContent(z.object({ actor: ActorSchema })),
    },
    ...errorResponses([401, 404]),
  },
});

const updateActorRoute = createRoute({
  method: "put",
  path: "/{id}",
  operationId: "updateActor",
  tags: ["Actors"],
  summary: "Update an actor (admin or self)",
  "x-arke-auth": "required",
  "x-arke-related": ["GET /actors/{id}"],
  request: {
    params: entityIdParams("Actor ULID"),
    body: {
      required: true,
      content: jsonContent(
        z.object({
          properties: JsonObjectSchema.optional().describe("New properties"),
          max_read_level: ClassificationLevel.optional().describe("New max read level"),
          max_write_level: ClassificationLevel.optional().describe("New max write level"),
          can_publish_public: z.boolean().optional().describe("Whether actor can publish public content"),
        }),
      ),
    },
  },
  responses: {
    200: {
      description: "Actor updated",
      content: jsonContent(z.object({ actor: ActorSchema })),
    },
    ...errorResponses([400, 401, 403, 404]),
  },
});

const deactivateActorRoute = createRoute({
  method: "delete",
  path: "/{id}",
  operationId: "deactivateActor",
  tags: ["Actors"],
  summary: "Deactivate an actor (admin only)",
  "x-arke-auth": "required",
  request: {
    params: entityIdParams("Actor ULID"),
  },
  responses: {
    200: {
      description: "Actor deactivated",
      content: jsonContent(z.object({ actor: ActorSchema })),
    },
    ...errorResponses([401, 403, 404]),
  },
});

const actorActivityRoute = createRoute({
  method: "get",
  path: "/{id}/activity",
  operationId: "listActorActivity",
  tags: ["Actors"],
  summary: "Activity feed filtered by a specific actor",
  "x-arke-auth": "optional",
  "x-arke-related": ["GET /activity"],
  request: {
    params: entityIdParams("Actor ULID"),
    query: paginationQuerySchema(50, 200).extend({
      since: queryParam(
        "since",
        DateTimeSchema.optional(),
        "ISO 8601 -- only events after this time",
      ),
      action: queryParam("action", z.string().optional(), "Filter by action type"),
    }),
  },
  responses: {
    200: {
      description: "Actor activity feed",
      content: jsonContent(cursorResponseSchema("activity", ActorActivitySchema)),
    },
    ...errorResponses([400, 403, 404]),
  },
});

export const actorsRouter = createRouter();

actorsRouter.openapi(createActorRoute, async (c) => {
  const actor = requireActor(c);
  const body = await parseJsonBody<Record<string, unknown>>(c);

  if (typeof body.kind !== "string" || !["user", "agent"].includes(body.kind)) {
    throw new ApiError(400, "missing_required_field", "Missing or invalid kind");
  }

  const maxReadLevel = typeof body.max_read_level === "number" ? body.max_read_level : 0;
  const maxWriteLevel = typeof body.max_write_level === "number" ? body.max_write_level : 0;
  const canPublishPublic = body.can_publish_public === true;
  const properties = body.properties && typeof body.properties === "object" ? body.properties : {};

  // RLS: caller cannot grant higher levels than their own
  if (maxReadLevel > actor.maxReadLevel) {
    throw new ApiError(403, "forbidden", "Cannot grant max_read_level higher than your own");
  }
  if (maxWriteLevel > actor.maxWriteLevel) {
    throw new ApiError(403, "forbidden", "Cannot grant max_write_level higher than your own");
  }

  const id = generateUlid();
  const now = new Date().toISOString();
  const key = createApiKey();
  const keyHash = await sha256Hex(key.value);
  const sql = createSql();

  const keyId = generateUlid();
  const results = await sql.transaction([
    ...setActorContext(sql, actor),
    sql.query(
      `INSERT INTO actors (id, kind, max_read_level, max_write_level, is_admin, can_publish_public, owner_id, properties, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, false, $5, $6, $7::jsonb, 'active', $8::timestamptz, $8::timestamptz)
       RETURNING *`,
      [id, body.kind, maxReadLevel, maxWriteLevel, canPublishPublic, actor.id, JSON.stringify(properties), now],
    ),
    sql.query(
      `INSERT INTO api_keys (id, actor_id, key_hash, key_prefix, created_at)
       VALUES ($1, $2, $3, $4, $5::timestamptz)`,
      [keyId, id, keyHash, key.keyPrefix, now],
    ),
  ]);

  const created = (results[4] as ActorRecord[])[0]; // 4 context queries + actor INSERT
  if (!created) {
    throw new ApiError(500, "internal_error", "Failed to create actor");
  }

  return c.json({ actor: created, api_key: key.value }, 201);
});

actorsRouter.openapi(listActorsRoute, async (c) => {
  const actor = requireActor(c);
  const sql = createSql();
  const limit = parseLimit(c, { defaultValue: 50, maxValue: 200 });
  const cursor = parseCursorParam(c);
  const status = c.req.query("status");
  const kind = c.req.query("kind");

  const [,,,, rows] = await sql.transaction([
    ...setActorContext(sql, actor),
    sql.query(
      `
        SELECT *
        FROM actors
        WHERE ($1::text IS NULL OR status = $1)
          AND ($2::text IS NULL OR kind = $2)
          AND ($3::timestamptz IS NULL OR created_at < $3::timestamptz)
        ORDER BY created_at DESC
        LIMIT $4
      `,
      [status ?? null, kind ?? null, cursor?.t ?? null, limit + 1],
    ),
  ]);

  const actors = (rows as ActorRecord[]).slice(0, limit);
  const next = (rows as ActorRecord[]).length > limit ? actors[actors.length - 1] : null;

  return c.json({
    actors,
    cursor: next ? encodeCursor({ t: next.created_at, i: next.id }) : null,
  }, 200);
});

actorsRouter.openapi(getActorRoute, async (c) => {
  requireActor(c);
  const sql = createSql();
  const actorId = c.req.param("id");

  const [row] = await sql`SELECT * FROM actors WHERE id = ${actorId} LIMIT 1`;
  if (!row) {
    throw new ApiError(404, "not_found", "Actor not found");
  }

  return c.json({ actor: row as ActorRecord }, 200);
});

actorsRouter.openapi(updateActorRoute, async (c) => {
  const actor = requireActor(c);
  const actorId = c.req.param("id");
  const body = await parseJsonBody<Record<string, unknown>>(c);
  const sql = createSql();
  const now = new Date().toISOString();

  // RLS: admin or self
  if (actorId !== actor.id && !actor.isAdmin) {
    throw new ApiError(403, "forbidden", "Forbidden");
  }

  const sets: string[] = [];
  const params: unknown[] = [];
  let paramIdx = 1;

  if (body.properties && typeof body.properties === "object") {
    sets.push(`properties = $${paramIdx++}::jsonb`);
    params.push(JSON.stringify(body.properties));
  }
  if (typeof body.max_read_level === "number") {
    if (body.max_read_level > actor.maxReadLevel && !actor.isAdmin) {
      throw new ApiError(403, "forbidden", "Cannot set max_read_level higher than your own");
    }
    sets.push(`max_read_level = $${paramIdx++}`);
    params.push(body.max_read_level);
  }
  if (typeof body.max_write_level === "number") {
    if (body.max_write_level > actor.maxWriteLevel && !actor.isAdmin) {
      throw new ApiError(403, "forbidden", "Cannot set max_write_level higher than your own");
    }
    sets.push(`max_write_level = $${paramIdx++}`);
    params.push(body.max_write_level);
  }
  if (typeof body.can_publish_public === "boolean") {
    sets.push(`can_publish_public = $${paramIdx++}`);
    params.push(body.can_publish_public);
  }

  if (sets.length === 0) {
    throw new ApiError(400, "invalid_body", "No changes requested");
  }

  sets.push(`updated_at = $${paramIdx++}::timestamptz`);
  params.push(now);

  const idParamIdx = paramIdx++;
  params.push(actorId);

  const [,,,, rows] = await sql.transaction([
    ...setActorContext(sql, actor),
    sql.query(
      `
        UPDATE actors
        SET ${sets.join(", ")}
        WHERE id = $${idParamIdx}
        RETURNING *
      `,
      params,
    ),
  ]);

  const updated = (rows as ActorRecord[])[0];
  if (!updated) {
    throw new ApiError(404, "not_found", "Actor not found");
  }

  return c.json({ actor: updated }, 200);
});

actorsRouter.openapi(deactivateActorRoute, async (c) => {
  const actor = requireActor(c);
  const actorId = c.req.param("id");
  const sql = createSql();
  const now = new Date().toISOString();

  if (!actor.isAdmin) {
    throw new ApiError(403, "forbidden", "Admin access required");
  }

  const [,,,, rows] = await sql.transaction([
    ...setActorContext(sql, actor),
    sql.query(
      `
        UPDATE actors
        SET status = 'deactivated', updated_at = $1::timestamptz
        WHERE id = $2
        RETURNING *
      `,
      [now, actorId],
    ),
  ]);

  const deactivated = (rows as ActorRecord[])[0];
  if (!deactivated) {
    throw new ApiError(404, "not_found", "Actor not found");
  }

  return c.json({ actor: deactivated }, 200);
});

actorsRouter.openapi(actorActivityRoute, async (c) => {
  const sql = createSql();
  const actorId = c.req.param("id");
  const requestActorId = c.get("actor")?.id ?? "";
  const limit = parseLimit(c, { defaultValue: 50, maxValue: 200 });
  const since = parseOptionalTimestamp(c.req.query("since"), "since");
  const action = c.req.query("action");
  const cursor = parseCursorParam(c);

  const actorCtx = c.get("actor") ?? null;
  const [,,,, rows] = await sql.transaction([
    ...setActorContext(sql, actorCtx),
    sql.query(
      `
        SELECT ea.*, json_build_object('id', e.id, 'kind', e.kind, 'type', e.type, 'properties', json_build_object('label', e.properties->>'label')) AS entity
        FROM entity_activity ea
        JOIN entities e ON e.id = ea.entity_id
        WHERE ea.actor_id = $1
          AND ($2::text IS NULL OR ea.action = $2)
          AND ($3::timestamptz IS NULL OR ea.ts > $3::timestamptz)
          AND ($4::timestamptz IS NULL OR (ea.ts, ea.id) < ($4::timestamptz, $5::bigint))
        ORDER BY ea.ts DESC, ea.id DESC
        LIMIT $6
      `,
      [actorId, action ?? null, since, cursor?.t ?? null, cursor?.i ?? null, limit + 1],
    ),
  ]);

  const activity = (rows as Array<Record<string, unknown>>).slice(0, limit);
  const next = (rows as Array<Record<string, unknown>>).length > limit ? activity[activity.length - 1] : null;

  return c.json({
    activity,
    cursor: next ? encodeCursor({ t: next.ts as string | Date, i: next.id as string | number | bigint }) : null,
  }, 200);
});
