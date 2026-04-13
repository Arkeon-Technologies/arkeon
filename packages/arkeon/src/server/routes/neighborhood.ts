// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { createRoute, z } from "@hono/zod-openapi";

import { ApiError } from "../lib/errors";
import { createRouter } from "../lib/openapi";
import { fetchNeighborhood, MAX_DEPTH, MAX_LIMIT } from "../lib/neighborhood";
import { fetchSpaceForActor } from "../lib/spaces";
import { createSql } from "../lib/sql";
import {
  EntityIdParam,
  NeighborhoodResponseSchema,
  entityIdParams,
  errorResponses,
  jsonContent,
  queryParam,
} from "../lib/schemas";
import { setActorContext } from "../lib/actor-context";

const getNeighborhoodRoute = createRoute({
  method: "get",
  path: "/{id}/neighborhood",
  operationId: "getNeighborhood",
  tags: ["Graph"],
  summary: "Multi-hop BFS neighborhood from a seed entity, returning ranked nodes and connecting edges",
  "x-arke-auth": "optional",
  "x-arke-related": [
    "GET /entities/{id}",
    "GET /entities/{id}/relationships",
    "GET /search",
  ],
  "x-arke-rules": [
    "Requires read_level clearance >= seed entity's read_level",
    "Traversed entities further filtered by your classification clearance",
    "Traversal follows edges in both directions",
    "Limits are global, not per-hop",
    "Results ranked by connectivity + recency + proximity + query relevance",
    "If space_id is provided, traversal is constrained to entities within that space",
  ],
  request: {
    params: entityIdParams("Seed entity ULID"),
    query: z.object({
      depth: queryParam(
        "depth",
        z.coerce.number().int().min(1).max(MAX_DEPTH).optional(),
        `Max hops from seed (default 2, max ${MAX_DEPTH})`,
      ),
      limit: queryParam(
        "limit",
        z.coerce.number().int().min(1).max(MAX_LIMIT).optional(),
        `Max nodes to return (default 20, max ${MAX_LIMIT})`,
      ),
      space_id: queryParam(
        "space_id",
        EntityIdParam.optional(),
        "Constrain traversal to entities within this space",
      ),
      q: queryParam(
        "q",
        z.string().optional(),
        "Optional query terms — matching nodes get a ranking boost",
      ),
    }),
  },
  responses: {
    200: {
      description: "Neighborhood subgraph: ranked nodes and connecting edges",
      content: jsonContent(NeighborhoodResponseSchema),
    },
    ...errorResponses([400, 403, 404]),
  },
});

export const neighborhoodRouter = createRouter();

neighborhoodRouter.openapi(getNeighborhoodRoute, async (c) => {
  const actor = c.get("actor") ?? null;
  const seedId = c.req.param("id");
  const depth = Number(c.req.query("depth") ?? 2);
  const limit = Number(c.req.query("limit") ?? 20);
  const spaceId = c.req.query("space_id") || undefined;
  const query = c.req.query("q") || undefined;

  // Verify seed entity exists and actor can see it
  const sql = createSql();
  const seedCheck = await sql.transaction([
    ...setActorContext(sql, actor),
    sql.query(`SELECT id FROM entities WHERE id = $1 AND kind = 'entity' LIMIT 1`, [seedId]),
  ]);
  const seedRows = seedCheck[seedCheck.length - 1] as Array<Record<string, unknown>>;
  if (seedRows.length === 0) {
    throw new ApiError(404, "not_found", "Entity not found");
  }

  // If space_id provided, verify it exists and actor can see it
  if (spaceId) {
    const space = await fetchSpaceForActor(actor, spaceId);
    if (!space) {
      throw new ApiError(404, "not_found", "Space not found");
    }
  }

  const result = await fetchNeighborhood(sql, actor, {
    seedId,
    depth,
    limit,
    spaceId,
    query,
  });

  return c.json(result, 200);
});
