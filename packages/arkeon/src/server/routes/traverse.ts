// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { createRoute, z } from "@hono/zod-openapi";

import { ApiError } from "../lib/errors";
import { createRouter } from "../lib/openapi";
import { fetchTraversal, MAX_HOPS, MAX_LIMIT } from "../lib/traverse";
import { fetchSpaceForActor } from "../lib/spaces";
import { createSql } from "../lib/sql";
import {
  EntityIdParam,
  TraverseResponseSchema,
  errorResponses,
  jsonContent,
  queryParam,
} from "../lib/schemas";

const traverseRoute = createRoute({
  method: "get",
  path: "/traverse",
  operationId: "graphTraverse",
  tags: ["Graph"],
  summary: "Traverse the graph from a source set, optionally finding bridges to a target set",
  description: [
    "Universal graph traversal primitive with two modes:",
    "",
    "**Neighborhood mode** (no target): BFS from source, returns top-K ranked nearby nodes.",
    "  Example: `?source=id:01ABC&hops=2&limit=20`",
    "",
    "**Bridge mode** (target specified): bidirectional BFS finds nodes connecting two entity sets.",
    "  Example: `?source=properties.work:Moby-Dick&target=properties.work:Crime and Punishment&hops=4`",
    "",
    "Source and target accept either `id:<ULID>` for a single entity, or the standard filter syntax",
    "(e.g. `type:concept,properties.work:Moby-Dick`). See GET /help for filter syntax.",
    "",
    "Ranking heuristic: connectivity (edge count) + recency + proximity (fewer hops = higher) + optional query-term boost.",
  ].join("\n"),
  "x-arke-auth": "optional",
  "x-arke-related": [
    "GET /entities/{id}",
    "GET /entities/{id}/relationships",
    "GET /search",
  ],
  "x-arke-rules": [
    "Source and target entities filtered by your classification clearance",
    "Traversal follows edges in both directions",
    "Limits are global, not per-hop",
    "Results ranked by connectivity + recency + proximity + query relevance",
    "If space_id is provided, traversal is constrained to entities within that space",
    "Bridge mode uses bidirectional BFS for efficiency at higher hop counts",
  ],
  request: {
    query: z.object({
      source: queryParam(
        "source",
        z.string(),
        "Source entity filter. Use id:<ULID> for a single entity, or filter syntax (e.g. type:concept,properties.work:Moby-Dick)",
      ),
      target: queryParam(
        "target",
        z.string().optional(),
        "Target entity filter (enables bridge mode). Same syntax as source.",
      ),
      hops: queryParam(
        "hops",
        z.coerce.number().int().min(1).max(MAX_HOPS).optional(),
        `Max edge traversals (default 2, max ${MAX_HOPS})`,
      ),
      limit: queryParam(
        "limit",
        z.coerce.number().int().min(1).max(MAX_LIMIT).optional(),
        `Max nodes to return (default 20, max ${MAX_LIMIT})`,
      ),
      predicates: queryParam(
        "predicates",
        z.string().optional(),
        "Comma-separated edge predicate filter (e.g. related_to,influenced_by)",
      ),
      q: queryParam(
        "q",
        z.string().optional(),
        "Optional query terms — matching nodes get a ranking boost",
      ),
      space_id: queryParam(
        "space_id",
        EntityIdParam.optional(),
        "Constrain traversal to entities within this space",
      ),
    }),
  },
  responses: {
    200: {
      description: "Traversal result: ranked nodes and connecting edges",
      content: jsonContent(TraverseResponseSchema),
    },
    ...errorResponses([400, 403, 404]),
  },
});

export const graphRouter = createRouter();

graphRouter.openapi(traverseRoute, async (c) => {
  const actor = c.get("actor") ?? null;
  const source = c.req.query("source");
  if (!source) {
    throw new ApiError(400, "missing_required_field", "source query parameter is required");
  }

  const target = c.req.query("target") || undefined;
  const hops = Number(c.req.query("hops") ?? 2);
  const limit = Number(c.req.query("limit") ?? 20);
  const predicatesRaw = c.req.query("predicates");
  const predicates = predicatesRaw ? predicatesRaw.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
  const query = c.req.query("q") || undefined;
  const spaceId = c.req.query("space_id") || undefined;

  // Validate space if provided
  if (spaceId) {
    const space = await fetchSpaceForActor(actor, spaceId);
    if (!space) {
      throw new ApiError(404, "not_found", "Space not found");
    }
  }

  const sql = createSql();
  const result = await fetchTraversal(sql, actor, {
    source,
    target,
    hops,
    limit,
    predicates,
    query,
    spaceId,
  });

  if (result.source_ids.length === 0) {
    throw new ApiError(404, "not_found", "No entities match the source filter");
  }

  return c.json(result, 200);
});
