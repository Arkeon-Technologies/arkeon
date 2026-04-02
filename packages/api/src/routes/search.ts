import { createRoute, z } from "@hono/zod-openapi";

import { parseProjection, projectEntity } from "../lib/entity-projection";
import { ApiError } from "../lib/errors";
import { parseLimit } from "../lib/http";
import {
  buildSearchFilters,
  isMeilisearchConfigured,
  searchEntities,
} from "../lib/meilisearch";
import { createRouter } from "../lib/openapi";
import {
  EntitySchema,
  ProjectionQuery,
  errorResponses,
  jsonContent,
  queryParam,
} from "../lib/schemas";
import { setActorContext } from "../lib/actor-context";
import { createSql } from "../lib/sql";

const SearchQuery = ProjectionQuery.extend({
  q: queryParam("q", z.string().min(1), "Search query string"),
  type: queryParam("type", z.string().optional(), "Filter by entity type"),
  kind: queryParam(
    "kind",
    z.string().optional(),
    "Filter by kind (entity or relationship). Defaults to excluding relationships.",
  ),
  arke_id: queryParam(
    "arke_id",
    z.string().optional(),
    "Scope search to an arke ULID",
  ),
  space_id: queryParam(
    "space_id",
    z.string().optional(),
    "Scope search to a space ULID",
  ),
  read_level: queryParam(
    "read_level",
    z.coerce.number().int().min(0).max(4).optional(),
    "Restrict results to this read level or below (cannot exceed your clearance)",
  ),
  limit: queryParam(
    "limit",
    z.coerce.number().int().min(1).max(200).optional(),
    "Page size (default 50, max 200)",
  ),
  offset: queryParam(
    "offset",
    z.coerce.number().int().min(0).optional(),
    "Offset for pagination (default 0)",
  ),
});

const searchRoute = createRoute({
  method: "get",
  path: "/",
  operationId: "searchEntities",
  tags: ["Search"],
  summary: "Full-text search across entities via Meilisearch",
  description:
    "Keyword search with typo tolerance, prefix matching, and relevance ranking. " +
    "Results are automatically filtered by the caller's read clearance level. " +
    "Use the read_level parameter to restrict results below your clearance.",
  "x-arke-auth": "optional",
  request: {
    query: SearchQuery,
  },
  responses: {
    200: {
      description: "Search results ordered by relevance",
      content: jsonContent(
        z.object({
          results: z.array(EntitySchema),
          estimatedTotalHits: z.number().int(),
          limit: z.number().int(),
          offset: z.number().int(),
        }),
      ),
    },
    ...errorResponses([400, 503]),
  },
});

export const searchRouter = createRouter();

searchRouter.openapi(searchRoute, async (c) => {
  if (!isMeilisearchConfigured()) {
    throw new ApiError(503, "service_unavailable", "Search is not available (MEILI_URL not configured)");
  }

  const q = c.req.query("q");
  if (!q) {
    throw new ApiError(400, "missing_required_field", "Missing q");
  }

  const actor = c.get("actor");
  const limit = parseLimit(c, { defaultValue: 50, maxValue: 200 });
  const offset = Math.max(0, Number(c.req.query("offset")) || 0);
  const projection = parseProjection(c.req.query("view"), c.req.query("fields"));

  const readLevelParam = c.req.query("read_level");
  const readLevelOverride = readLevelParam !== undefined ? Number(readLevelParam) : undefined;

  const filters = buildSearchFilters(actor, {
    type: c.req.query("type"),
    kind: c.req.query("kind"),
    arkeId: c.get("actor")?.arkeId ?? c.req.query("arke_id") ?? undefined,
    spaceId: c.req.query("space_id"),
    readLevelOverride,
  });

  const meiliResult = await searchEntities(q, {
    filter: filters,
    limit,
    offset,
  });

  if (meiliResult.ids.length === 0) {
    return c.json({ results: [], estimatedTotalHits: 0, limit, offset }, 200);
  }

  // Fetch full entities from Postgres by ID (RLS backstop)
  const sql = createSql();
  const placeholders = meiliResult.ids.map((_, i) => `$${i + 1}`).join(", ");
  const txResults = await sql.transaction([
    ...setActorContext(sql, actor),
    sql.query(
      `SELECT * FROM entities WHERE id IN (${placeholders})`,
      meiliResult.ids,
    ),
  ]);

  const rowMap = new Map<string, Record<string, unknown>>();
  for (const row of txResults[txResults.length - 1] as Array<Record<string, unknown>>) {
    rowMap.set(String(row.id), row);
  }

  // Preserve Meilisearch relevance order, filter out rows hidden by RLS
  const results = meiliResult.ids
    .map((id) => rowMap.get(id))
    .filter((row): row is Record<string, unknown> => row !== undefined);

  return c.json({
    results: results.map((row) => projectEntity(row, projection)),
    estimatedTotalHits: meiliResult.estimatedTotalHits,
    limit,
    offset,
  }, 200);
});
