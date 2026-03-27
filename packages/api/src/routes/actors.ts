import { createRoute, z } from "@hono/zod-openapi";

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
  pathParam,
  queryParam,
} from "../lib/schemas";
import { createSql } from "../lib/sql";
import type { AppBindings } from "../types";

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

const actorActivityRoute = createRoute({
  method: "get",
  path: "/{actorId}/activity",
  operationId: "listActorActivity",
  tags: ["Actors"],
  summary: "Activity feed filtered by a specific actor",
  "x-arke-auth": "optional",
  "x-arke-related": ["GET /activity"],
  request: {
    params: z.object({
      actorId: pathParam("actorId", EntityIdParam, "Actor ULID"),
    }),
    query: paginationQuerySchema(50, 200).extend({
      since: queryParam(
        "since",
        DateTimeSchema.optional(),
        "ISO 8601 — only events after this time",
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

actorsRouter.openapi(actorActivityRoute, async (c) => {
  const sql = createSql(c.env);
  const actorId = c.req.param("actorId");
  const requestActorId = c.get("actor")?.id ?? "";
  const limit = parseLimit(c, { defaultValue: 50, maxValue: 200 });
  const since = parseOptionalTimestamp(c.req.query("since"), "since");
  const action = c.req.query("action");
  const cursor = parseCursorParam(c);

  const [, rows] = await sql.transaction([
    sql`SELECT set_config('app.actor_id', ${requestActorId}, true)`,
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
