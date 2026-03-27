import { createRoute, z } from "@hono/zod-openapi";

import { encodeCursor } from "../lib/cursor";
import { ApiError } from "../lib/errors";
import { requireActor, parseCursorParam, parseLimit, parseOptionalTimestamp } from "../lib/http";
import { createRouter } from "../lib/openapi";
import {
  DateTimeSchema,
  cursorResponseSchema,
  errorResponses,
  jsonContent,
  paginationQuerySchema,
  queryParam,
} from "../lib/schemas";
import { createSql } from "../lib/sql";
import type { AppBindings } from "../types";

const InboxItemSchema = z.object({
  id: z.number().int(),
  entity_id: z.string(),
  actor_id: z.string(),
  action: z.string(),
  detail: z.any(),
  ts: DateTimeSchema,
});

const listInboxRoute = createRoute({
  method: "get",
  path: "/me/inbox",
  operationId: "listInboxNotifications",
  tags: ["Auth"],
  summary: "Get notification inbox for the authenticated actor",
  "x-arke-auth": "required",
  "x-arke-related": ["GET /auth/me/inbox/count"],
  request: {
    query: paginationQuerySchema(50, 200).extend({
      since: queryParam(
        "since",
        DateTimeSchema.optional(),
        "ISO 8601 — only notifications after this time",
      ),
      before: queryParam(
        "before",
        DateTimeSchema.optional(),
        "ISO 8601 — only notifications before this time",
      ),
      action: queryParam(
        "action",
        z.string().optional(),
        "Comma-separated action types to filter",
      ),
    }),
  },
  responses: {
    200: {
      description: "Inbox items",
      content: jsonContent(cursorResponseSchema("items", InboxItemSchema)),
    },
    ...errorResponses([400, 401, 403]),
  },
});

const countInboxRoute = createRoute({
  method: "get",
  path: "/me/inbox/count",
  operationId: "countInboxNotifications",
  tags: ["Auth"],
  summary: "Count unread notifications since a timestamp",
  "x-arke-auth": "required",
  "x-arke-related": ["GET /auth/me/inbox"],
  request: {
    query: z.object({
      since: queryParam(
        "since",
        DateTimeSchema,
        "ISO 8601 — count notifications after this time",
      ),
    }),
  },
  responses: {
    200: {
      description: "Unread notification count",
      content: jsonContent(z.object({ count: z.number().int() })),
    },
    ...errorResponses([400, 401, 403]),
  },
});

export const inboxRouter = createRouter();

inboxRouter.openapi(listInboxRoute, async (c) => {
  const actor = requireActor(c);
  const sql = createSql(c.env);
  const limit = parseLimit(c, { defaultValue: 50, maxValue: 200 });
  const since = parseOptionalTimestamp(c.req.query("since"), "since");
  const before = parseOptionalTimestamp(c.req.query("before"), "before");
  const cursor = parseCursorParam(c);
  const actions = c.req.query("action")?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];

  const [, rows] = await sql.transaction([
    sql`SELECT set_config('app.actor_id', ${actor.id}, true)`,
    sql.query(
      `
        SELECT id, entity_id, actor_id, action, detail, ts
        FROM notifications
        WHERE recipient_id = $1
          AND ($2::timestamptz IS NULL OR ts >= $2::timestamptz)
          AND ($3::timestamptz IS NULL OR ts < $3::timestamptz)
          AND ($4::text[] IS NULL OR action = ANY($4))
          AND ($5::timestamptz IS NULL OR (ts, id) < ($5::timestamptz, $6::bigint))
        ORDER BY ts DESC, id DESC
        LIMIT $7
      `,
      [actor.id, since, before, actions.length ? actions : null, cursor?.t ?? null, cursor?.i ?? null, limit + 1],
    ),
  ]);
  const items = (rows as Array<Record<string, unknown>>).slice(0, limit);
  const next = (rows as Array<Record<string, unknown>>).length > limit ? items[items.length - 1] : null;

  return c.json({
    items,
    cursor: next ? encodeCursor({ t: next.ts as string | Date, i: next.id as string | number | bigint }) : null,
  }, 200);
});

inboxRouter.openapi(countInboxRoute, async (c) => {
  const actor = requireActor(c);
  const sql = createSql(c.env);
  if (!c.req.query("since")) {
    throw new ApiError(400, "missing_required_field", "Missing since");
  }
  const since = parseOptionalTimestamp(c.req.query("since"), "since");

  const [, rows] = await sql.transaction([
    sql`SELECT set_config('app.actor_id', ${actor.id}, true)`,
    sql`
      SELECT COUNT(*)::int AS count
      FROM notifications
      WHERE recipient_id = ${actor.id}
        AND (${since}::timestamptz IS NULL OR ts > ${since}::timestamptz)
    `,
  ]);

  return c.json({ count: (rows as Array<{ count: number }>)[0]?.count ?? 0 }, 200);
});
