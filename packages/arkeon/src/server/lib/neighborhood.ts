// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Actor } from "../types";
import { setActorContext } from "./actor-context";
import type { SqlClient } from "./sql";

export interface NeighborhoodNode {
  id: string;
  kind: "entity" | "relationship";
  type: string;
  properties: { label: string | null; description: string | null };
  read_level: number;
  created_at: string;
  updated_at: string;
  depth: number;
  score: number;
}

export interface NeighborhoodEdge {
  id: string;
  source_id: string;
  target_id: string;
  predicate: string;
  properties: Record<string, unknown>;
}

export interface NeighborhoodResult {
  seed_id: string;
  nodes: NeighborhoodNode[];
  edges: NeighborhoodEdge[];
  truncated: boolean;
}

export interface NeighborhoodOptions {
  seedId: string;
  depth: number;
  limit: number;
  spaceId?: string;
  query?: string;
}

export const MAX_DEPTH = 6;
export const MAX_LIMIT = 100;

// Stop BFS once we've collected this many candidate nodes. Prevents
// runaway exploration in dense graphs — we only need enough candidates
// to score and pick the top `limit`.
const BFS_CEILING = 500;

// Max edges to follow per frontier batch. Caps the fan-out so a single
// hop through a mega-hub doesn't pull back thousands of rows.
const HOP_EDGE_LIMIT = 200;

interface VisitedNode {
  id: string;
  depth: number;
}

/**
 * Iterative BFS traversal with early termination.
 *
 * Runs one query per hop (2–6 round trips). Stops early when:
 *   - We've collected BFS_CEILING candidate nodes, OR
 *   - The frontier is empty (no more reachable nodes), OR
 *   - We've reached the requested depth
 *
 * Each hop is a single well-indexed query that follows relationship_edges
 * in both directions. RLS filters via setActorContext at each step.
 */
export async function fetchNeighborhood(
  sql: SqlClient,
  actor: Actor | null,
  options: NeighborhoodOptions,
): Promise<NeighborhoodResult> {
  const depth = Math.min(Math.max(options.depth, 1), MAX_DEPTH);
  const limit = Math.min(Math.max(options.limit, 1), MAX_LIMIT);
  const spaceId = options.spaceId ?? null;
  const query = options.query ?? null;

  // ── Phase 1: Iterative BFS ──────────────────────────────────────────
  const visited = new Map<string, number>(); // id → shallowest depth
  visited.set(options.seedId, 0);
  let frontier = [options.seedId];
  let hitCeiling = false;

  for (let d = 1; d <= depth; d++) {
    if (frontier.length === 0) break;

    const hopResults = await sql.transaction([
      ...setActorContext(sql, actor),
      sql.query(
        `SELECT DISTINCT
           CASE WHEN re.source_id = ANY($1::text[]) THEN re.target_id ELSE re.source_id END AS neighbor_id
         FROM relationship_edges re
         JOIN entities rel_ent ON rel_ent.id = re.id
         JOIN entities neighbor ON neighbor.id =
           CASE WHEN re.source_id = ANY($1::text[]) THEN re.target_id ELSE re.source_id END
         WHERE (re.source_id = ANY($1::text[]) OR re.target_id = ANY($1::text[]))
           AND neighbor.kind = 'entity'
           AND ($2::text IS NULL OR EXISTS (
             SELECT 1 FROM space_entities se
             WHERE se.space_id = $2
               AND se.entity_id = CASE WHEN re.source_id = ANY($1::text[]) THEN re.target_id ELSE re.source_id END
           ))
         LIMIT $3`,
        [frontier, spaceId, HOP_EDGE_LIMIT],
      ),
    ]);

    const rows = hopResults[hopResults.length - 1] as Array<{ neighbor_id: string }>;
    const nextFrontier: string[] = [];

    for (const row of rows) {
      const nid = String(row.neighbor_id);
      if (!visited.has(nid)) {
        visited.set(nid, d);
        nextFrontier.push(nid);
        if (visited.size >= BFS_CEILING) {
          hitCeiling = true;
          break;
        }
      }
    }

    frontier = nextFrontier;
    if (hitCeiling) break;
  }

  // Remove seed from candidate set (caller already has it)
  visited.delete(options.seedId);

  if (visited.size === 0) {
    return { seed_id: options.seedId, nodes: [], edges: [], truncated: false };
  }

  // ── Phase 2: Score candidates ───────────────────────────────────────
  const candidateIds = Array.from(visited.keys());
  const candidateDepths = Array.from(visited.values());

  const scoreResults = await sql.transaction([
    ...setActorContext(sql, actor),
    sql.query(
      `WITH candidates AS (
        SELECT unnest($1::text[]) AS id, unnest($2::int[]) AS depth
      ),
      edge_counts AS (
        SELECT
          c.id,
          c.depth,
          COUNT(re.id)::int AS edge_count
        FROM candidates c
        LEFT JOIN relationship_edges re
          ON re.source_id = c.id OR re.target_id = c.id
        GROUP BY c.id, c.depth
      )
      SELECT
        ec.id, ec.depth,
        ROUND((
          LN(ec.edge_count + 1) * 2.0
          + CASE WHEN e.updated_at > NOW() - INTERVAL '7 days' THEN 3.0
                 WHEN e.updated_at > NOW() - INTERVAL '30 days' THEN 1.5
                 ELSE 0 END
          + (($3::int - ec.depth) * 1.5)
          + CASE WHEN $4::text IS NOT NULL AND (
                e.properties->>'label' ILIKE '%' || $4 || '%'
                OR e.properties->>'description' ILIKE '%' || $4 || '%'
                OR e.type ILIKE '%' || $4 || '%'
              ) THEN 5.0 ELSE 0 END
        )::numeric, 2) AS score,
        e.kind, e.type,
        json_build_object('label', e.properties->>'label', 'description', e.properties->>'description') AS properties,
        e.read_level, e.created_at, e.updated_at
      FROM edge_counts ec
      JOIN entities e ON e.id = ec.id
      ORDER BY score DESC
      LIMIT $5 + 1`,
      [candidateIds, candidateDepths, depth, query, limit],
    ),
  ]);

  const nodeRows = scoreResults[scoreResults.length - 1] as Array<Record<string, unknown>>;
  const truncated = nodeRows.length > limit || hitCeiling;
  const nodes: NeighborhoodNode[] = nodeRows.slice(0, limit).map((row) => ({
    id: String(row.id),
    kind: row.kind as "entity" | "relationship",
    type: String(row.type),
    properties: row.properties as { label: string | null; description: string | null },
    read_level: Number(row.read_level),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    depth: Number(row.depth),
    score: Number(row.score),
  }));

  if (nodes.length === 0) {
    return { seed_id: options.seedId, nodes: [], edges: [], truncated: false };
  }

  // ── Phase 3: Fetch connecting edges ─────────────────────────────────
  const nodeIds = nodes.map((n) => n.id);
  const allIds = [options.seedId, ...nodeIds];

  const edgeResults = await sql.transaction([
    ...setActorContext(sql, actor),
    sql.query(
      `SELECT re.id, re.source_id, re.target_id, re.predicate, rel.properties
       FROM relationship_edges re
       JOIN entities rel ON rel.id = re.id
       WHERE re.source_id = ANY($1::text[]) AND re.target_id = ANY($1::text[])`,
      [allIds],
    ),
  ]);

  const edgeRows = edgeResults[edgeResults.length - 1] as Array<Record<string, unknown>>;
  const edges: NeighborhoodEdge[] = edgeRows.map((row) => ({
    id: String(row.id),
    source_id: String(row.source_id),
    target_id: String(row.target_id),
    predicate: String(row.predicate),
    properties: (row.properties ?? {}) as Record<string, unknown>,
  }));

  return { seed_id: options.seedId, nodes, edges, truncated };
}
