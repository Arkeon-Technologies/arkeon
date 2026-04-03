import { createRoute, z } from "@hono/zod-openapi";

import { ApiError } from "../lib/errors";
import { encodeCursor } from "../lib/cursor";
import { parseCursorParam, parseLimit, parseOptionalTimestamp } from "../lib/http";
import { createRouter } from "../lib/openapi";
import {
  DateTimeSchema,
  EntityIdParam,
  cursorResponseSchema,
  entityIdParams,
  errorResponses,
  jsonContent,
  paginationQuerySchema,
  queryParam,
} from "../lib/schemas";
import { setActorContext } from "../lib/actor-context";
import { createSql } from "../lib/sql";


type ActivityRow = {
  id: number;
  entity_id: string;
  actor_id: string;
  action: string;
  detail: unknown;
  ts: string;
};

const ActivitySchema = z.object({
  id: z.number().int(),
  entity_id: EntityIdParam,
  actor_id: EntityIdParam,
  action: z.string(),
  detail: z.any(),
  ts: DateTimeSchema,
});

const activityQuery = paginationQuerySchema(100, 200).extend({
  since: queryParam(
    "since",
    DateTimeSchema.optional(),
    "ISO 8601 timestamp — only events after this time",
  ),
  action: queryParam(
    "action",
    z.string().optional(),
    "Filter by action type (e.g. entity_created, content_uploaded)",
  ),
  actor_id: queryParam("actor_id", z.string().optional(), "Filter by actor ULID"),
});

const entityActivityQuery = paginationQuerySchema(50, 200).extend({
  since: queryParam(
    "since",
    DateTimeSchema.optional(),
    "ISO 8601 timestamp — only events after this time",
  ),
  action: queryParam("action", z.string().optional(), "Filter by action type"),
  actor_id: queryParam("actor_id", z.string().optional(), "Filter by actor ULID"),
});

const listActivityRoute = createRoute({
  method: "get",
  path: "/",
  operationId: "listActivity",
  tags: ["Activity"],
  summary: "Global activity feed across all entities",
  "x-arke-auth": "optional",
  "x-arke-related": [
    "GET /entities/{id}/activity",
    "GET /actors/{actorId}/activity",
    "GET /commons/{id}/feed",
  ],
  "x-arke-rules": ["Results filtered by your classification clearance"],
  request: {
    query: activityQuery,
  },
  responses: {
    200: {
      description: "Global activity feed",
      content: jsonContent(cursorResponseSchema("activity", ActivitySchema)),
    },
    ...errorResponses([400, 403, 404]),
  },
});

const listEntityActivityRoute = createRoute({
  method: "get",
  path: "/{id}/activity",
  operationId: "listEntityActivity",
  tags: ["Activity"],
  summary: "Activity changelog for a specific entity",
  "x-arke-auth": "optional",
  "x-arke-related": ["GET /activity", "GET /commons/{id}/feed"],
  "x-arke-rules": ["Requires read_level clearance >= entity's read_level"],
  request: {
    params: entityIdParams(),
    query: entityActivityQuery,
  },
  responses: {
    200: {
      description: "Entity activity feed",
      content: jsonContent(cursorResponseSchema("activity", ActivitySchema)),
    },
    ...errorResponses([400, 403, 404]),
  },
});

export const activityRouter = createRouter();

activityRouter.openapi(listActivityRoute, async (c) => {
  const sql = createSql();
  const actorId = c.get("actor")?.id ?? "";
  const limit = parseLimit(c, { defaultValue: 100, maxValue: 200 });
  const since = parseOptionalTimestamp(c.req.query("since"), "since");
  const action = c.req.query("action");
  const actorFilter = c.req.query("actor_id");
  const cursor = parseCursorParam(c);

  const actor = c.get("actor");
  const results = await sql.transaction([
    ...setActorContext(sql, actor),
    sql`
      SELECT id, entity_id, actor_id, action, detail, ts
      FROM entity_activity
      WHERE (${since}::timestamptz IS NULL OR ts > ${since}::timestamptz)
        AND (${action ?? null}::text IS NULL OR action = ${action ?? null}::text)
        AND (${actorFilter ?? null}::text IS NULL OR actor_id = ${actorFilter ?? null}::text)
        AND (
          ${cursor?.t ?? null}::timestamptz IS NULL
          OR (ts, id) < (${cursor?.t ?? null}::timestamptz, ${cursor?.i ?? null}::bigint)
        )
      ORDER BY ts DESC, id DESC
      LIMIT ${limit + 1}
    `,
  ]);
  const rows = results[results.length - 1] as ActivityRow[];

  const page = rows.slice(0, limit);
  const next = rows.length > limit ? rows[limit - 1] : null;

  return c.json({
    activity: page,
    cursor: next ? encodeCursor({ t: next.ts as string | Date, i: next.id as string | number | bigint }) : null,
  }, 200);
});

export const entityActivityRouter = createRouter();

entityActivityRouter.openapi(listEntityActivityRoute, async (c) => {
  const sql = createSql();
  const actorId = c.get("actor")?.id ?? "";
  const entityId = c.req.param("id");
  const limit = parseLimit(c, { defaultValue: 50, maxValue: 200 });
  const since = parseOptionalTimestamp(c.req.query("since"), "since");
  const action = c.req.query("action");
  const actorFilter = c.req.query("actor_id");
  const cursor = parseCursorParam(c);

  const actor = c.get("actor");
  const results = await sql.transaction([
    ...setActorContext(sql, actor),
    sql.query(
      `
        SELECT id, entity_id, actor_id, action, detail, ts
        FROM entity_activity
        WHERE entity_id = $1
          AND ($2::timestamptz IS NULL OR ts > $2::timestamptz)
          AND ($3::text IS NULL OR action = $3)
          AND ($4::text IS NULL OR actor_id = $4)
          AND ($5::timestamptz IS NULL OR (ts, id) < ($5::timestamptz, $6::bigint))
        ORDER BY ts DESC, id DESC
        LIMIT $7
      `,
      [entityId, since, action ?? null, actorFilter ?? null, cursor?.t ?? null, cursor?.i ?? null, limit + 1],
    ),
  ]);
  const rows = results[results.length - 1] as ActivityRow[];

  const page = rows.slice(0, limit);
  const next = rows.length > limit ? page[page.length - 1] : null;

  return c.json({
    activity: page,
    cursor: next ? encodeCursor({ t: next.ts as string | Date, i: next.id as string | number | bigint }) : null,
  }, 200);
});
