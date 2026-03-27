import { createRoute, z } from "@hono/zod-openapi";

import { encodeCursor } from "../lib/cursor";
import { parseProjection, projectEntity } from "../lib/entity-projection";
import { ApiError } from "../lib/errors";
import { parseCursorParam, parseLimit } from "../lib/http";
import { buildEntityListingQuery, mergeFilters, parseOrder, parseSort } from "../lib/listing";
import { createRouter } from "../lib/openapi";
import {
  EntitySchema,
  ProjectionQuery,
  cursorResponseSchema,
  errorResponses,
  filterQuerySchema,
  jsonContent,
  paginationQuerySchema,
  queryParam,
} from "../lib/schemas";
import { createSql } from "../lib/sql";
import type { AppBindings } from "../types";

const SearchQuery = filterQuerySchema(["updated_at", "created_at"], "updated_at")
  .merge(ProjectionQuery)
  .merge(paginationQuerySchema(50, 200))
  .extend({
    q: queryParam("q", z.string().min(1), "Search query string"),
    commons_id: queryParam(
      "commons_id",
      z.string().optional(),
      "Comma-separated commons ULIDs to scope search",
    ),
  });

const searchRoute = createRoute({
  method: "get",
  path: "/",
  operationId: "searchEntities",
  tags: ["Search"],
  summary: "Full-text search across entities and commons",
  "x-arke-auth": "optional",
  request: {
    query: SearchQuery,
  },
  responses: {
    200: {
      description: "Search results",
      content: jsonContent(cursorResponseSchema("results", EntitySchema)),
    },
    ...errorResponses([400, 403, 404, 409]),
  },
});

export const searchRouter = createRouter();

searchRouter.openapi(searchRoute, async (c) => {
  const q = c.req.query("q");
  if (!q) {
    throw new ApiError(400, "missing_required_field", "Missing q");
  }

  const sql = createSql(c.env);
  const actorId = c.get("actor")?.id ?? "";
  const limit = parseLimit(c, { defaultValue: 50, maxValue: 200 });
  const projection = parseProjection(c.req.query("view"), c.req.query("fields"));
  const cursor = parseCursorParam(c);
  const order = parseOrder(c.req.query("order"));
  const sort = parseSort(c.req.query("sort"), ["updated_at", "created_at"], "updated_at");
  const commonsIds = c.req.query("commons_id")?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];

  // Default: exclude relationships from search unless the user explicitly
  // includes kind in their filter (e.g. filter=kind:relationship)
  const userFilter = c.req.query("filter");
  const hasKindFilter = userFilter?.split(",").some((expr) => expr.trim().startsWith("kind"));
  const implicitFilter = hasKindFilter ? undefined : "kind!:relationship";
  const filter = implicitFilter ? mergeFilters(implicitFilter, userFilter) : userFilter;

  const listing = buildEntityListingQuery({
    q,
    filter,
    limit,
    cursor,
    sort,
    order,
  });

  let query = listing.query;
  const params = [...listing.params];
  if (commonsIds.length) {
    params.splice(params.length - 1, 0, commonsIds);
    const limitIndex = params.length;
    query = `
      SELECT * FROM (
        ${query.replace(/LIMIT \$\d+$/, "")}
      ) q
      WHERE commons_id = ANY($${limitIndex - 1}::text[])
      LIMIT $${limitIndex}
    `;
  }

  const [, rows] = await sql.transaction([
    sql`SELECT set_config('app.actor_id', ${actorId}, true)`,
    sql.query(query, params),
  ]);
  const results = (rows as Array<Record<string, unknown>>).slice(0, limit);
  const next = (rows as Array<Record<string, unknown>>).length > limit ? results[results.length - 1] : null;

  return c.json({
    results: results.map((row) => projectEntity(row, projection)),
    cursor: next ? encodeCursor({ t: (next[sort] ?? next.updated_at) as string | Date, i: String(next.id) }) : null,
  }, 200);
});
