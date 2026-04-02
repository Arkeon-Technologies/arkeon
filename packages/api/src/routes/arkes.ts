import { createRoute, z } from "@hono/zod-openapi";

import { ApiError } from "../lib/errors";
import { requireActor, parseJsonBody, parseLimit, parseCursorParam } from "../lib/http";
import { generateUlid } from "../lib/ids";
import { createRouter } from "../lib/openapi";
import { encodeCursor } from "../lib/cursor";
import {
  ArkeSchema,
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

type ArkeRecord = {
  id: string;
  name: string;
  description: string | null;
  owner_id: string;
  default_read_level: number;
  default_write_level: number;
  properties: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

const createArkeRoute = createRoute({
  method: "post",
  path: "/",
  operationId: "createArke",
  tags: ["Arkes"],
  summary: "Create a new arke (network)",
  "x-arke-auth": "required",
  "x-arke-related": ["GET /arkes/{id}", "GET /arkes"],
  request: {
    body: {
      required: true,
      content: jsonContent(
        z.object({
          name: z.string().min(1).describe("Arke name"),
          description: z.string().nullable().optional().describe("Arke description"),
          default_read_level: ClassificationLevel.optional().describe("Default read level (0-4)"),
          default_write_level: ClassificationLevel.optional().describe("Default write level (0-4)"),
          properties: JsonObjectSchema.optional().describe("Arbitrary properties"),
        }),
      ),
    },
  },
  responses: {
    201: {
      description: "Arke created",
      content: jsonContent(z.object({ arke: ArkeSchema })),
    },
    ...errorResponses([400, 401, 403]),
  },
});

const listArkesRoute = createRoute({
  method: "get",
  path: "/",
  operationId: "listArkes",
  tags: ["Arkes"],
  summary: "List all arkes (networks)",
  "x-arke-auth": "optional",
  "x-arke-related": ["POST /arkes", "GET /arkes/{id}"],
  request: {
    query: paginationQuerySchema(50, 200).extend({
      q: queryParam("q", z.string().optional(), "Search by name"),
    }),
  },
  responses: {
    200: {
      description: "Arke listing",
      content: jsonContent(cursorResponseSchema("arkes", ArkeSchema)),
    },
    ...errorResponses([400]),
  },
});

const getArkeRoute = createRoute({
  method: "get",
  path: "/{id}",
  operationId: "getArke",
  tags: ["Arkes"],
  summary: "Fetch a single arke by ID",
  "x-arke-auth": "optional",
  "x-arke-related": ["PUT /arkes/{id}", "DELETE /arkes/{id}"],
  request: {
    params: entityIdParams("Arke ULID"),
  },
  responses: {
    200: {
      description: "Arke details",
      content: jsonContent(z.object({ arke: ArkeSchema })),
    },
    ...errorResponses([404]),
  },
});

const updateArkeRoute = createRoute({
  method: "put",
  path: "/{id}",
  operationId: "updateArke",
  tags: ["Arkes"],
  summary: "Update an arke (admin only via RLS)",
  "x-arke-auth": "required",
  "x-arke-related": ["GET /arkes/{id}"],
  request: {
    params: entityIdParams("Arke ULID"),
    body: {
      required: true,
      content: jsonContent(
        z.object({
          name: z.string().min(1).optional().describe("New name"),
          description: z.string().nullable().optional().describe("New description"),
          default_read_level: ClassificationLevel.optional().describe("New default read level"),
          default_write_level: ClassificationLevel.optional().describe("New default write level"),
          properties: JsonObjectSchema.optional().describe("New properties"),
        }),
      ),
    },
  },
  responses: {
    200: {
      description: "Arke updated",
      content: jsonContent(z.object({ arke: ArkeSchema })),
    },
    ...errorResponses([400, 401, 403, 404]),
  },
});

const deleteArkeRoute = createRoute({
  method: "delete",
  path: "/{id}",
  operationId: "deleteArke",
  tags: ["Arkes"],
  summary: "Delete an arke (admin only via RLS)",
  "x-arke-auth": "required",
  request: {
    params: entityIdParams("Arke ULID"),
  },
  responses: {
    204: {
      description: "Arke deleted",
    },
    ...errorResponses([401, 403, 404]),
  },
});

export const arkesRouter = createRouter();

arkesRouter.openapi(createArkeRoute, async (c) => {
  const actor = requireActor(c);
  const body = await parseJsonBody<Record<string, unknown>>(c);

  if (typeof body.name !== "string" || body.name.length === 0) {
    throw new ApiError(400, "missing_required_field", "Missing name");
  }

  const id = generateUlid();
  const now = new Date().toISOString();
  const sql = createSql();
  const description = typeof body.description === "string" ? body.description : null;
  const defaultReadLevel = typeof body.default_read_level === "number" ? body.default_read_level : 0;
  const defaultWriteLevel = typeof body.default_write_level === "number" ? body.default_write_level : 0;
  const properties = body.properties && typeof body.properties === "object" ? body.properties : {};

  const [,,,,, rows] = await sql.transaction([
    ...setActorContext(sql, actor),
    sql.query(
      `
        INSERT INTO arkes (id, name, description, owner_id, default_read_level, default_write_level, properties, created_at, updated_at)
        SELECT $1, $2, $3, $4, $5, $6, $7::jsonb, $8::timestamptz, $8::timestamptz
        WHERE current_setting('app.actor_is_admin', true) = 'true'
        RETURNING *
      `,
      [id, body.name, description, actor.id, defaultReadLevel, defaultWriteLevel, JSON.stringify(properties), now],
    ),
  ]);

  const arke = (rows as ArkeRecord[])[0];
  if (!arke) {
    throw new ApiError(403, "forbidden", "Admin access required");
  }

  return c.json({ arke }, 201);
});

arkesRouter.openapi(listArkesRoute, async (c) => {
  const sql = createSql();
  const actorId = c.get("actor")?.id ?? "";
  const limit = parseLimit(c, { defaultValue: 50, maxValue: 200 });
  const cursor = parseCursorParam(c);
  const q = c.req.query("q");

  const actorCtx = { id: actorId, maxReadLevel: c.get("actor")?.maxReadLevel ?? -1, maxWriteLevel: c.get("actor")?.maxWriteLevel ?? -1, isAdmin: c.get("actor")?.isAdmin ?? false } as any;
  const [,,,,, rows] = await sql.transaction([
    ...setActorContext(sql, actorCtx),
    sql.query(
      `
        SELECT *
        FROM arkes
        WHERE ($1::text IS NULL OR name ILIKE '%' || $1 || '%')
          AND ($2::timestamptz IS NULL OR created_at < $2::timestamptz)
        ORDER BY created_at DESC
        LIMIT $3
      `,
      [q ?? null, cursor?.t ?? null, limit + 1],
    ),
  ]);

  const arkes = (rows as ArkeRecord[]).slice(0, limit);
  const next = (rows as ArkeRecord[]).length > limit ? arkes[arkes.length - 1] : null;

  return c.json({
    arkes,
    cursor: next ? encodeCursor({ t: next.created_at, i: next.id }) : null,
  }, 200);
});

arkesRouter.openapi(getArkeRoute, async (c) => {
  const sql = createSql();
  const arkeId = c.req.param("id");

  const [row] = await sql`SELECT * FROM arkes WHERE id = ${arkeId} LIMIT 1`;

  if (!row) {
    throw new ApiError(404, "not_found", "Arke not found");
  }

  return c.json({ arke: row as ArkeRecord }, 200);
});

arkesRouter.openapi(updateArkeRoute, async (c) => {
  const actor = requireActor(c);
  const arkeId = c.req.param("id");
  const body = await parseJsonBody<Record<string, unknown>>(c);

  const sql = createSql();
  const now = new Date().toISOString();

  const sets: string[] = [];
  const params: unknown[] = [];
  let paramIdx = 1;

  if (typeof body.name === "string") {
    sets.push(`name = $${paramIdx++}`);
    params.push(body.name);
  }
  if (body.description !== undefined) {
    sets.push(`description = $${paramIdx++}`);
    params.push(typeof body.description === "string" ? body.description : null);
  }
  if (typeof body.default_read_level === "number") {
    sets.push(`default_read_level = $${paramIdx++}`);
    params.push(body.default_read_level);
  }
  if (typeof body.default_write_level === "number") {
    sets.push(`default_write_level = $${paramIdx++}`);
    params.push(body.default_write_level);
  }
  if (body.properties && typeof body.properties === "object") {
    sets.push(`properties = $${paramIdx++}::jsonb`);
    params.push(JSON.stringify(body.properties));
  }

  if (sets.length === 0) {
    throw new ApiError(400, "invalid_body", "No changes requested");
  }

  sets.push(`updated_at = $${paramIdx++}::timestamptz`);
  params.push(now);

  const idParamIdx = paramIdx++;
  params.push(arkeId);

  const [,,,,, rows] = await sql.transaction([
    ...setActorContext(sql, actor),
    sql.query(
      `
        UPDATE arkes
        SET ${sets.join(", ")}
        WHERE id = $${idParamIdx}
          AND current_setting('app.actor_is_admin', true) = 'true'
        RETURNING *
      `,
      params,
    ),
  ]);

  const arke = (rows as ArkeRecord[])[0];
  if (!arke) {
    const [exists] = await sql`SELECT id FROM arkes WHERE id = ${arkeId} LIMIT 1`;
    if (exists) {
      throw new ApiError(403, "forbidden", "Admin access required");
    }
    throw new ApiError(404, "not_found", "Arke not found");
  }

  return c.json({ arke }, 200);
});

arkesRouter.openapi(deleteArkeRoute, async (c) => {
  const actor = requireActor(c);
  const arkeId = c.req.param("id");
  const sql = createSql();

  const [,,,,, rows] = await sql.transaction([
    ...setActorContext(sql, actor),
    sql.query(
      `
        DELETE FROM arkes
        WHERE id = $1
          AND current_setting('app.actor_is_admin', true) = 'true'
        RETURNING id
      `,
      [arkeId],
    ),
  ]);

  const deleted = (rows as Array<{ id: string }>)[0];
  if (!deleted) {
    const [exists] = await sql`SELECT id FROM arkes WHERE id = ${arkeId} LIMIT 1`;
    if (exists) {
      throw new ApiError(403, "forbidden", "Admin access required");
    }
    throw new ApiError(404, "not_found", "Arke not found");
  }

  return new Response(null, { status: 204 });
});
