// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * arke.ops/v1 executor.
 *
 * Takes a validated OpsPlan and runs the whole batch in a single Postgres
 * transaction. All-or-nothing semantics — any failure rolls back every op.
 *
 * This is the canonical atomic multi-entity writer for Arkeon. It mirrors
 * the insert patterns in routes/entities.ts and routes/relationships.ts but
 * composes them into one transaction so an LLM can build a whole subgraph
 * in one call.
 *
 * Pre-transaction checks (so we can surface diagnostic errors before doing
 * any writes):
 *   1. Classification ceilings — entity read/write_level vs actor clearance
 *   2. Space roles — every distinct space_id requires contributor+
 *   3. Source document visibility — if source.entity_id is set
 *   4. Global ref existence — every ULID referenced as source/target of an
 *      edge must exist AND be visible to the actor
 */
import { ApiError } from "./errors";
import { addEntityToSpaceQuery, grantEntityPermissionQuery } from "./entities";
import { backgroundTask } from "./background";
import { generateUlid } from "./ids";
import { indexEntityById } from "./meilisearch";
import { deepMergeObjects } from "./properties";
import { setActorContext } from "./actor-context";
import { requireSpaceRole } from "./spaces";
import type { SqlClient } from "./sql";
import type { Actor } from "../types";

import type { OpsEnvelope, OpsResult, CreatedEntityResult, CreatedEdgeResult } from "./ops-schema";
import type { OpsPlan, PlannedEntity, PlannedEdge, PlannedMerge } from "./ops-parse";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ExecuteOpts {
  dryRun?: boolean;
}

/**
 * Execute a validated OpsPlan.
 *
 * Throws ApiError with diagnostic details (op_index, code, fix) on any
 * failure. Never leaks raw Postgres messages to the caller.
 */
export async function executeOps(
  envelope: OpsEnvelope,
  plan: OpsPlan,
  actor: Actor,
  sql: SqlClient,
  opts: ExecuteOpts = {},
): Promise<OpsResult> {
  // ---- Pre-flight validation (in order of increasing cost) -----------------

  assertClassificationCeilings(plan, actor);

  await assertSpaceRoles(plan, actor, sql);

  if (envelope.source?.entity_id) {
    await assertSourceVisible(envelope.source.entity_id, actor, sql);
  }

  if (plan.referenced_global_ids.size > 0) {
    await assertGlobalRefsVisible(plan, actor, sql);
  }

  // ---- Upsert: resolve existing entities by (type, label) within space -----
  if (plan.upsert_active) {
    await resolveUpsertTargets(plan, actor, sql);
  }

  if (opts.dryRun) {
    const entityResults = plan.entities.map((e) => ({
      ref: e.local_ref,
      id: e.id,
      type: e.type,
      label: e.label,
      action: (e.is_upsert ? "updated" : "created") as "created" | "updated",
    }));
    return {
      format: "arke.ops/v1",
      committed: false,
      entities: entityResults,
      created: entityResults, // backwards compat
      edges: plan.edges.map((edge) => ({
        id: edge.id,
        source: edge.source_id,
        predicate: edge.predicate,
        target: edge.target_id,
      })),
      stats: { entities: plan.entities.length, edges: plan.edges.length },
    };
  }

  // ---- Build transaction ---------------------------------------------------

  const now = new Date().toISOString();
  const queries: Array<ReturnType<SqlClient["query"]>> = [
    ...setActorContext(sql, actor),
  ];

  // Record positions in the query array for each inserted row we care about.
  // We'll check these after tx completes to detect any RLS-blocked inserts.
  const entityQueryIdx: number[] = [];
  const edgeEntityQueryIdx: number[] = [];
  // One index per extracted_from edge — tracked separately so we can verify
  // every provenance insert landed (see issue #1 review). Parallel to the
  // extractedFromEdges array below.
  const extractedFromQueryIdx: number[] = [];

  const upsertMode = plan.upsert_mode ?? "accumulate";

  for (const entity of plan.entities) {
    entityQueryIdx.push(queries.length);
    if (entity.is_upsert) {
      queries.push(buildEntityUpsertUpdate(sql, entity, actor.id, now, upsertMode));
      queries.push(buildEntityUpsertVersionInsert(sql, entity.id, actor.id, now));
      queries.push(buildEntityUpsertActivityInsert(sql, entity, actor.id, now));
    } else {
      queries.push(buildEntityInsert(sql, entity, actor.id, now));
      queries.push(buildEntityVersionInsert(sql, entity, actor.id, now));
      queries.push(buildEntityActivityInsert(sql, entity, actor.id, now));
    }
    if (entity.space_id) {
      queries.push(addEntityToSpaceQuery(sql, entity.space_id, entity.id, actor.id, now));
    }
    for (const grant of entity.permissions) {
      queries.push(
        grantEntityPermissionQuery(sql, entity.id, grant.grantee_type, grant.grantee_id, grant.role, actor.id),
      );
    }
  }

  for (const edge of plan.edges) {
    edgeEntityQueryIdx.push(queries.length);
    queries.push(buildEdgeEntityInsert(sql, edge, actor.id, now));
    queries.push(buildEdgeRelationshipInsert(sql, edge));
    queries.push(buildEntityVersionInsert(sql, { id: edge.id, properties: edge.properties }, actor.id, now));
    queries.push(buildEdgeActivityInsert(sql, edge, actor.id, now));
    if (edge.space_id) {
      queries.push(addEntityToSpaceQuery(sql, edge.space_id, edge.id, actor.id, now));
    }
    for (const grant of edge.permissions) {
      queries.push(
        grantEntityPermissionQuery(sql, edge.id, grant.grantee_type, grant.grantee_id, grant.role, actor.id),
      );
    }
  }

  // ---- Optional: extracted_from edges to source document ------------------
  //
  // If source.entity_id was provided, every entity AND relationship created
  // in this batch gets an 'extracted_from' edge back to the source document.
  // This covers both entity ops (persons, concepts, etc.) and relate ops
  // (relationships the LLM extracted from the source). The only things that
  // do NOT get provenance edges are the extracted_from edges themselves —
  // that would be provenance edges for provenance edges.
  //
  // We track the query index of each provenance entity INSERT so we can
  // verify post-tx that it actually landed. In practice these should never
  // silently drop — assertSourceVisible already confirmed the source is
  // readable, and every entity being linked FROM was just created by the
  // same actor in the same transaction. But if the SELECT joining src + tgt
  // inside buildExtractedFromEdgeEntityInsert ever returns 0 rows (e.g. due
  // to a race with the source document being deleted or reclassified), we
  // want an explicit error rather than a silently-dropped provenance edge
  // and a committed: true response.
  interface PlannedProvenanceEdge {
    id: string;
    sourceEntityId: string;
  }
  const extractedFromEdges: PlannedProvenanceEdge[] = [];
  const sourceId = envelope.source?.entity_id ?? null;
  if (sourceId) {
    // Entities created by entity ops
    for (const entity of plan.entities) {
      const edgeId = generateUlid();
      extractedFromEdges.push({ id: edgeId, sourceEntityId: entity.id });
      extractedFromQueryIdx.push(queries.length);
      queries.push(
        buildExtractedFromEdgeEntityInsert(sql, edgeId, entity.id, sourceId, actor.id, now, envelope.source?.extracted_by),
      );
      queries.push(
        buildExtractedFromEdgeRelationshipInsert(sql, edgeId, entity.id, sourceId),
      );
      queries.push(
        buildEntityVersionInsert(sql, { id: edgeId, properties: envelope.source?.extracted_by ?? {} }, actor.id, now),
      );
    }
    // Relationship entities created by relate ops — these are also
    // "extracted from" the source document. Without this, arkeon rm
    // can't cascade-delete relationships that were extracted from a file.
    for (const edge of plan.edges) {
      const edgeId = generateUlid();
      extractedFromEdges.push({ id: edgeId, sourceEntityId: edge.id });
      extractedFromQueryIdx.push(queries.length);
      queries.push(
        buildExtractedFromEdgeEntityInsert(sql, edgeId, edge.id, sourceId, actor.id, now, envelope.source?.extracted_by),
      );
      queries.push(
        buildExtractedFromEdgeRelationshipInsert(sql, edgeId, edge.id, sourceId),
      );
      queries.push(
        buildEntityVersionInsert(sql, { id: edgeId, properties: envelope.source?.extracted_by ?? {} }, actor.id, now),
      );
    }
  }

  // ---- Execute -------------------------------------------------------------

  let txResults: Awaited<ReturnType<SqlClient["transaction"]>>;
  try {
    txResults = await sql.transaction(queries);
  } catch (err) {
    throw mapTransactionError(err, plan);
  }

  // ---- Verify every expected INSERT returned a row (RLS may silently drop) -

  const resultEntities: CreatedEntityResult[] = [];
  for (let i = 0; i < plan.entities.length; i++) {
    const entity = plan.entities[i];
    const queryIdx = entityQueryIdx[i];
    const rows = txResults[queryIdx] as Array<Record<string, unknown>>;
    if (!rows || rows.length === 0) {
      if (entity.is_upsert) {
        // CAS conflict — another writer bumped ver between pre-flight and UPDATE
        throw new ApiError(
          409,
          "cas_conflict",
          `Op #${entity.op_index} (entity ${entity.local_ref}) — upsert UPDATE returned zero rows. The entity was modified by another writer between lookup and write.`,
          {
            op_index: entity.op_index,
            ref: entity.local_ref,
            entity_id: entity.id,
            expected_ver: entity.existing_ver,
            fix: "Retry the batch — the upsert will pick up the latest version on the next attempt.",
          },
        );
      }
      throw new ApiError(
        403,
        "forbidden",
        `Op #${entity.op_index} (entity ${entity.local_ref}) was blocked by row-level security — most likely a classification ceiling you can't write at.`,
        {
          op_index: entity.op_index,
          ref: entity.local_ref,
          fix: "Check that your actor has max_write_level >= entity.write_level and max_read_level >= entity.read_level. Lower the levels on the op, or request higher clearance.",
        },
      );
    }
    resultEntities.push({
      ref: entity.local_ref,
      id: entity.id,
      type: entity.type,
      label: entity.label,
      action: entity.is_upsert ? "updated" : "created",
    });
  }

  const createdEdges: CreatedEdgeResult[] = [];
  for (let i = 0; i < plan.edges.length; i++) {
    const edge = plan.edges[i];
    const queryIdx = edgeEntityQueryIdx[i];
    const rows = txResults[queryIdx] as Array<Record<string, unknown>>;
    if (!rows || rows.length === 0) {
      // Two distinct failure modes with different messaging:
      //   - both ends are @local refs → entities we inserted in THIS tx.
      //     This should not happen (the actor just created them and owns
      //     them), and if it does it's a bug in this file or an RLS policy
      //     regression. Surface as 500 so it gets attention.
      //   - at least one end is a global ULID → caller's referenced entity
      //     could have been deleted or reclassified mid-tx. 404 with guidance.
      if (edge.source_is_local && edge.target_is_local) {
        throw new ApiError(
          500,
          "internal_error",
          `Op #${edge.op_index} (relate ${edge.source_id} → ${edge.target_id}) — edge insert joined against entities created in the same transaction but returned zero rows. This is unexpected; please file a bug.`,
          {
            op_index: edge.op_index,
            source: edge.source_id,
            target: edge.target_id,
            source_is_local: true,
            target_is_local: true,
          },
        );
      }
      throw new ApiError(
        404,
        "target_not_found",
        `Op #${edge.op_index} (relate ${edge.source_id} → ${edge.target_id}) — one of the referenced entities is no longer visible. It may have been deleted, reclassified, or had its permissions changed between pre-flight and write.`,
        {
          op_index: edge.op_index,
          source: edge.source_id,
          target: edge.target_id,
          source_is_local: edge.source_is_local,
          target_is_local: edge.target_is_local,
          fix: "Re-fetch the referenced entities with GET /entities/{id} and retry. Only global-ULID refs can fail here; @local refs are created in the same batch.",
        },
      );
    }
    createdEdges.push({
      id: edge.id,
      source: edge.source_id,
      predicate: edge.predicate,
      target: edge.target_id,
    });
  }

  // ---- Verify extracted_from provenance edges landed ----------------------
  //
  // Same shape as the edge verification above. If any provenance insert
  // returned zero rows, the source document changed between
  // assertSourceVisible and the main transaction — hard error so we never
  // return committed: true with missing provenance.
  for (let i = 0; i < extractedFromEdges.length; i++) {
    const edge = extractedFromEdges[i];
    const queryIdx = extractedFromQueryIdx[i];
    const rows = txResults[queryIdx] as Array<Record<string, unknown>>;
    if (!rows || rows.length === 0) {
      throw new ApiError(
        409,
        "source_changed",
        `extracted_from edge for entity ${edge.sourceEntityId} → ${sourceId} returned zero rows. The source document may have been deleted or reclassified between pre-flight and write.`,
        {
          source_entity_id: sourceId,
          affected_entity: edge.sourceEntityId,
          fix: "Verify the source document still exists and is readable, then retry the batch.",
        },
      );
    }
  }

  // ---- Background Meilisearch indexing ------------------------------------

  for (const entity of plan.entities) {
    backgroundTask(indexEntityById(entity.id));
  }
  for (const edge of plan.edges) {
    backgroundTask(indexEntityById(edge.id));
  }
  for (const provEdge of extractedFromEdges) {
    backgroundTask(indexEntityById(provEdge.id));
  }

  // ---- Post-transaction merges (independent, non-fatal) -------------------
  const mergeResults: Array<{ target_id: string; sources: number; error?: string }> = [];
  if (plan.merges && plan.merges.length > 0) {
    for (const merge of plan.merges) {
      try {
        await executeSingleMerge(sql, merge, actor, now);
        mergeResults.push({ target_id: merge.target_id, sources: merge.source_ids.length });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[ops] Merge failed (target=${merge.target_id}): ${message}`);
        mergeResults.push({ target_id: merge.target_id, sources: merge.source_ids.length, error: message });
      }
    }
  }

  return {
    format: "arke.ops/v1",
    committed: true,
    entities: resultEntities,
    created: resultEntities, // backwards compat
    edges: createdEdges,
    stats: { entities: resultEntities.length, edges: createdEdges.length },
    ...(mergeResults.length > 0 ? { merges: mergeResults } : {}),
  };
}

// ---------------------------------------------------------------------------
// Post-transaction merge
// ---------------------------------------------------------------------------

async function executeSingleMerge(
  sql: SqlClient,
  merge: PlannedMerge,
  actor: Actor,
  now: string,
): Promise<void> {
  const allIds = [merge.target_id, ...merge.source_ids];
  const ctxQueries = setActorContext(sql, actor);
  const txResults = await sql.transaction([
    ...ctxQueries,
    sql.query(
      `SELECT id, ver, properties, owner_id FROM entities WHERE id = ANY($1)`,
      [allIds],
    ),
  ]);

  const rows = txResults[txResults.length - 1] as Array<{
    id: string; ver: number; properties: Record<string, unknown>; owner_id: string;
  }>;
  const rowMap = new Map(rows.map(r => [r.id, r]));

  const target = rowMap.get(merge.target_id);
  if (!target) throw new Error(`Target entity ${merge.target_id} not found`);

  // Authorization: actor must own or have admin role on every entity in the merge.
  // Mirrors the merge-batch endpoint's check (entities.ts).
  const nonOwnedIds = allIds.filter((id) => {
    const e = rowMap.get(id);
    return !e || (e.owner_id !== actor.id && !actor.isAdmin);
  });
  if (nonOwnedIds.length > 0) {
    const permResults = await sql.transaction([
      ...setActorContext(sql, actor),
      sql.query(
        `SELECT entity_id FROM entity_permissions
         WHERE entity_id = ANY($1::text[]) AND role = 'admin'
         AND ((grantee_type = 'actor' AND grantee_id = $2)
           OR (grantee_type = 'group' AND EXISTS (
             SELECT 1 FROM group_memberships WHERE group_id = grantee_id AND actor_id = $2)))`,
        [nonOwnedIds, actor.id],
      ),
    ]);
    const permittedIds = new Set(
      (permResults[permResults.length - 1] as Array<{ entity_id: string }>).map((r) => r.entity_id),
    );
    const unauthorized = nonOwnedIds.filter((id) => !permittedIds.has(id));
    if (unauthorized.length > 0) {
      throw new ApiError(
        403,
        "forbidden",
        `Merge requires admin access on all entities. Missing admin on: ${unauthorized.slice(0, 3).join(", ")}${unauthorized.length > 3 ? ` (+${unauthorized.length - 3} more)` : ""}`,
      );
    }
  }

  // Accumulate properties: start with target, deep-merge each source
  let merged: Record<string, unknown> = (target.properties ?? {}) as Record<string, unknown>;
  for (const sourceId of merge.source_ids) {
    const source = rowMap.get(sourceId);
    if (!source) throw new Error(`Source entity ${sourceId} not found`);
    merged = deepMergeObjects(merged, (source.properties ?? {}) as Record<string, unknown>);
  }

  // Build merge details for audit trail
  const mergeDetails = merge.source_ids.map(id => {
    const src = rowMap.get(id);
    return JSON.stringify({
      source_id: id,
      source_label: (src?.properties as Record<string, unknown>)?.label ?? "",
    });
  });

  // Call perform_group_merge
  await sql.transaction([
    ...setActorContext(sql, actor),
    sql.query(
      `SELECT * FROM perform_group_merge($1, $2::text[], $3::jsonb, $4, $5, $6::timestamptz, $7::jsonb[])`,
      [
        merge.target_id,
        merge.source_ids,
        JSON.stringify(merged),
        target.ver,
        actor.id,
        now,
        mergeDetails,
      ],
    ),
  ]);
}

// ---------------------------------------------------------------------------
// Pre-flight checks
// ---------------------------------------------------------------------------

function assertClassificationCeilings(plan: OpsPlan, actor: Actor): void {
  if (actor.isAdmin) return;
  for (const entity of plan.entities) {
    if (entity.read_level !== null && entity.read_level > actor.maxReadLevel) {
      throw new ApiError(
        403,
        "invalid_classification",
        `Op #${entity.op_index} requests read_level ${entity.read_level}, but your clearance is ${actor.maxReadLevel}.`,
        {
          op_index: entity.op_index,
          ref: entity.local_ref,
          requested: entity.read_level,
          ceiling: actor.maxReadLevel,
          fix: `Lower read_level to <= ${actor.maxReadLevel}, or request higher clearance on your actor.`,
        },
      );
    }
    if (entity.write_level !== null && entity.write_level > actor.maxWriteLevel) {
      throw new ApiError(
        403,
        "invalid_classification",
        `Op #${entity.op_index} requests write_level ${entity.write_level}, but your clearance is ${actor.maxWriteLevel}.`,
        {
          op_index: entity.op_index,
          ref: entity.local_ref,
          requested: entity.write_level,
          ceiling: actor.maxWriteLevel,
          fix: `Lower write_level to <= ${actor.maxWriteLevel}, or request higher clearance on your actor.`,
        },
      );
    }
  }
}

async function assertSpaceRoles(plan: OpsPlan, actor: Actor, sql: SqlClient): Promise<void> {
  const distinctSpaceIds = new Set<string>();
  for (const entity of plan.entities) {
    if (entity.space_id) distinctSpaceIds.add(entity.space_id);
  }
  for (const edge of plan.edges) {
    if (edge.space_id) distinctSpaceIds.add(edge.space_id);
  }
  for (const spaceId of distinctSpaceIds) {
    try {
      await requireSpaceRole(sql, actor, spaceId, "contributor");
    } catch (err) {
      if (err instanceof ApiError) {
        throw new ApiError(err.status, err.code, err.message, {
          ...err.details,
          space_id: spaceId,
          fix: "All ops in this batch that reference this space require contributor role or above. Remove the space_id from the ops, or request a role on the space.",
        });
      }
      throw err;
    }
  }
}

async function assertSourceVisible(sourceId: string, actor: Actor, sql: SqlClient): Promise<void> {
  const txResults = await sql.transaction([
    ...setActorContext(sql, actor),
    sql`SELECT id FROM entities WHERE id = ${sourceId} LIMIT 1`,
  ]);
  const rows = txResults.at(-1) as Array<{ id: string }>;
  if (!rows || rows.length === 0) {
    throw new ApiError(
      404,
      "source_not_found",
      `source.entity_id ${sourceId} was not found or is not visible to your actor.`,
      {
        source_entity_id: sourceId,
        fix: "Check the ULID is correct and you have read access. Source documents must be readable for extracted_from edges to be created.",
      },
    );
  }
}

async function assertGlobalRefsVisible(plan: OpsPlan, actor: Actor, sql: SqlClient): Promise<void> {
  const ids = [...plan.referenced_global_ids];
  const txResults = await sql.transaction([
    ...setActorContext(sql, actor),
    sql`SELECT id FROM entities WHERE id = ANY(${ids}::text[])`,
  ]);
  const rows = txResults.at(-1) as Array<{ id: string }>;
  const found = new Set(rows.map((r) => r.id.toUpperCase()));
  const missing = ids.filter((id) => !found.has(id.toUpperCase()));
  if (missing.length === 0) return;

  // Find the first op_index that references one of the missing IDs
  const missingSet = new Set(missing.map((id) => id.toUpperCase()));
  let firstBadOp = -1;
  let firstBadRef = "";
  let firstBadField: "source" | "target" = "source";
  for (const edge of plan.edges) {
    if (!edge.source_is_local && missingSet.has(edge.source_id.toUpperCase())) {
      firstBadOp = edge.op_index;
      firstBadRef = edge.source_id;
      firstBadField = "source";
      break;
    }
    if (!edge.target_is_local && missingSet.has(edge.target_id.toUpperCase())) {
      firstBadOp = edge.op_index;
      firstBadRef = edge.target_id;
      firstBadField = "target";
      break;
    }
  }

  throw new ApiError(
    404,
    "target_not_found",
    firstBadOp >= 0
      ? `Op #${firstBadOp} references ${firstBadField}=${firstBadRef} but that entity does not exist or is not visible to your actor.`
      : `Referenced entities not found or not visible: ${missing.join(", ")}`,
    {
      op_index: firstBadOp >= 0 ? firstBadOp : undefined,
      field: firstBadOp >= 0 ? firstBadField : undefined,
      offending_value: firstBadOp >= 0 ? firstBadRef : undefined,
      missing_ids: missing,
      fix: "Confirm the ULID is correct and you have read access. Use GET /entities/{id} to verify. Or create the entity in the same batch with a @local ref.",
    },
  );
}

// ---------------------------------------------------------------------------
// Upsert: resolve existing entities by (type, label) within space
// ---------------------------------------------------------------------------

/**
 * For each entity in the plan that has an upsert_key, look up existing entities
 * with matching (type, lower(label)) within the same space. When a match is
 * found, overwrite the entity's preallocated ULID with the existing entity's ID,
 * mark it as an upsert, and store the existing ver for CAS.
 *
 * This mutates plan.entities in place — downstream code sees the correct IDs
 * so @local refs that were mapped during parsing still resolve correctly
 * (the localRefs Map in the parser used the preallocated ULID, but edges
 * already captured that ULID as source_id/target_id — we need to patch those too).
 */
async function resolveUpsertTargets(plan: OpsPlan, actor: Actor, sql: SqlClient): Promise<void> {
  // Collect entities that can be upserted, grouped by space
  const bySpace = new Map<string, PlannedEntity[]>();
  for (const entity of plan.entities) {
    if (entity.upsert_key && entity.space_id) {
      let list = bySpace.get(entity.space_id);
      if (!list) {
        list = [];
        bySpace.set(entity.space_id, list);
      }
      list.push(entity);
    }
  }

  if (bySpace.size === 0) return;

  // For each space, batch-query existing entities
  // Build a map from old preallocated ULID → existing ULID for edge patching
  const idRemap = new Map<string, string>();

  for (const [spaceId, entities] of bySpace) {
    // Build parameter arrays for the query
    const types: string[] = [];
    const labelsLower: string[] = [];
    for (const entity of entities) {
      types.push(entity.type);
      labelsLower.push(entity.upsert_key!.split("|")[1]);
    }

    // Query existing entities matching any (type, lower(label)) in this space.
    // DISTINCT ON + ORDER BY created_at picks the oldest entity deterministically
    // when pre-existing duplicates exist (multiple entities with same type+label).
    const txResults = await sql.transaction([
      ...setActorContext(sql, actor),
      sql.query(
        `SELECT DISTINCT ON (e.type, lower(e.properties->>'label'))
                e.id, e.type, lower(e.properties->>'label') AS label_lower, e.ver, e.properties
         FROM entities e
         JOIN space_entities se ON se.entity_id = e.id
         WHERE se.space_id = $1
           AND e.kind = 'entity'
           AND e.type = ANY($2::text[])
           AND lower(e.properties->>'label') = ANY($3::text[])
         ORDER BY e.type, lower(e.properties->>'label'), e.created_at ASC`,
        [spaceId, types, labelsLower],
      ),
    ]);

    const rows = txResults.at(-1) as Array<{ id: string; type: string; label_lower: string; ver: number; properties: Record<string, unknown> }>;
    if (!rows || rows.length === 0) continue;

    // Build lookup map: "type|label_lower" → { id, ver, properties }
    // DISTINCT ON guarantees one row per (type, label_lower).
    const existing = new Map<string, { id: string; ver: number; properties: Record<string, unknown> }>();
    for (const row of rows) {
      existing.set(`${row.type}|${row.label_lower}`, { id: row.id, ver: row.ver, properties: row.properties });
    }

    // Patch matching entities
    for (const entity of entities) {
      const match = existing.get(entity.upsert_key!);
      if (match) {
        const oldId = entity.id;
        entity.id = match.id;
        entity.is_upsert = true;
        entity.existing_ver = match.ver;
        entity.existing_properties = match.properties;
        idRemap.set(oldId, match.id);
      }
    }
  }

  // Patch edge source_id / target_id that referenced preallocated ULIDs
  if (idRemap.size > 0) {
    for (const edge of plan.edges) {
      const remappedSource = idRemap.get(edge.source_id);
      if (remappedSource) edge.source_id = remappedSource;
      const remappedTarget = idRemap.get(edge.target_id);
      if (remappedTarget) edge.target_id = remappedTarget;
    }
  }
}

// ---------------------------------------------------------------------------
// INSERT query builders
// ---------------------------------------------------------------------------

function buildEntityInsert(
  sql: SqlClient,
  entity: PlannedEntity,
  actorId: string,
  now: string,
) {
  const readLevel = entity.read_level ?? 1;
  const writeLevel = entity.write_level ?? 1;
  return sql.query(
    `INSERT INTO entities (
      id, kind, type, ver, properties, owner_id,
      read_level, write_level, edited_by, note, created_at, updated_at
    ) VALUES (
      $1, 'entity', $2, 1, $3::jsonb, $4,
      $5, $6, $4, NULL, $7::timestamptz, $7::timestamptz
    ) RETURNING *`,
    [entity.id, entity.type, JSON.stringify(entity.properties), actorId, readLevel, writeLevel, now],
  );
}

function buildEntityVersionInsert(
  sql: SqlClient,
  entity: { id: string; properties: Record<string, unknown> },
  actorId: string,
  now: string,
) {
  return sql.query(
    `INSERT INTO entity_versions (entity_id, ver, properties, edited_by, note, created_at)
     VALUES ($1, 1, $2::jsonb, $3, NULL, $4::timestamptz)`,
    [entity.id, JSON.stringify(entity.properties), actorId, now],
  );
}

function buildEntityActivityInsert(
  sql: SqlClient,
  entity: PlannedEntity,
  actorId: string,
  now: string,
) {
  return sql.query(
    `INSERT INTO entity_activity (entity_id, actor_id, action, detail, ts)
     VALUES ($1, $2, 'entity_created', $3::jsonb, $4::timestamptz)`,
    [entity.id, actorId, JSON.stringify({ kind: "entity", type: entity.type, via: "ops" }), now],
  );
}

function buildEntityUpsertUpdate(
  sql: SqlClient,
  entity: PlannedEntity,
  actorId: string,
  now: string,
  upsertMode: "accumulate" | "replace" = "accumulate",
) {
  if (upsertMode === "accumulate" && entity.existing_properties) {
    const merged = deepMergeObjects(
      entity.existing_properties as Record<string, unknown>,
      entity.properties,
    );
    return sql.query(
      `UPDATE entities
       SET properties = $1::jsonb,
           ver = ver + 1,
           edited_by = $2,
           updated_at = $3::timestamptz
       WHERE id = $4 AND ver = $5
       RETURNING *`,
      [JSON.stringify(merged), actorId, now, entity.id, entity.existing_ver],
    );
  }
  return sql.query(
    `UPDATE entities
     SET properties = properties || $1::jsonb,
         ver = ver + 1,
         edited_by = $2,
         updated_at = $3::timestamptz
     WHERE id = $4 AND ver = $5
     RETURNING *`,
    [JSON.stringify(entity.properties), actorId, now, entity.id, entity.existing_ver],
  );
}

/**
 * Version snapshot for upserts. Reads the merged properties from the entity
 * row (which was just UPDATE'd earlier in the same transaction) rather than
 * using the incoming properties — ensures the snapshot reflects the actual
 * post-merge state including preserved keys from the original entity.
 */
function buildEntityUpsertVersionInsert(
  sql: SqlClient,
  entityId: string,
  actorId: string,
  now: string,
) {
  return sql.query(
    `INSERT INTO entity_versions (entity_id, ver, properties, edited_by, note, created_at)
     SELECT $1, ver, properties, $2, NULL, $3::timestamptz
     FROM entities WHERE id = $1`,
    [entityId, actorId, now],
  );
}

function buildEntityUpsertActivityInsert(
  sql: SqlClient,
  entity: PlannedEntity,
  actorId: string,
  now: string,
) {
  return sql.query(
    `INSERT INTO entity_activity (entity_id, actor_id, action, detail, ts)
     VALUES ($1, $2, 'content_updated', $3::jsonb, $4::timestamptz)`,
    [entity.id, actorId, JSON.stringify({ kind: "entity", type: entity.type, via: "ops_upsert" }), now],
  );
}

function buildEdgeEntityInsert(sql: SqlClient, edge: PlannedEdge, actorId: string, now: string) {
  // GREATEST(...) auto-lifts read/write levels to >= max(src, tgt).
  //
  // The SELECT joins on src + tgt. Both are guaranteed visible to the
  // actor-bound RLS session at this point:
  //
  //   - For @local refs (source_is_local / target_is_local = true): the
  //     entity was INSERTed earlier in this same transaction by the same
  //     actor. The actor owns it, so the read RLS policy always admits it,
  //     regardless of classification. assertClassificationCeilings already
  //     rejected any op whose read/write_level exceeds the actor's ceiling,
  //     so self-read is unconditional.
  //
  //   - For global ULID refs: assertGlobalRefsVisible already confirmed
  //     every referenced ULID is both present and readable via a pre-flight
  //     SELECT under the same actor context.
  //
  // If this SELECT nonetheless returns 0 rows (race with deletion /
  // reclassification / permission revocation), the INSERT silently inserts
  // nothing and the post-tx row count check surfaces the problem — see
  // the `if (edge.source_is_local && edge.target_is_local)` branch in the
  // verification loop above.
  const requestedRead = edge.read_level ?? 0;
  const requestedWrite = edge.write_level ?? 0;
  return sql.query(
    `INSERT INTO entities (
      id, kind, type, ver, properties, owner_id,
      read_level, write_level, edited_by, note, created_at, updated_at
    )
    SELECT
      $1, 'relationship', 'relationship', 1, $2::jsonb, $3,
      GREATEST(src.read_level, tgt.read_level, $4::int),
      GREATEST(src.write_level, tgt.write_level, $5::int),
      $3, NULL, $6::timestamptz, $6::timestamptz
    FROM entities src, entities tgt
    WHERE src.id = $7 AND tgt.id = $8
    RETURNING *`,
    [edge.id, JSON.stringify(edge.properties), actorId, requestedRead, requestedWrite, now, edge.source_id, edge.target_id],
  );
}

function buildEdgeRelationshipInsert(sql: SqlClient, edge: PlannedEdge) {
  return sql.query(
    `INSERT INTO relationship_edges (id, source_id, target_id, predicate)
     VALUES ($1, $2, $3, $4)`,
    [edge.id, edge.source_id, edge.target_id, edge.predicate],
  );
}

function buildEdgeActivityInsert(sql: SqlClient, edge: PlannedEdge, actorId: string, now: string) {
  return sql.query(
    `INSERT INTO entity_activity (entity_id, actor_id, action, detail, ts)
     VALUES ($1, $2, 'relationship_created', $3::jsonb, $4::timestamptz)`,
    [
      edge.source_id,
      actorId,
      JSON.stringify({ relationship_id: edge.id, predicate: edge.predicate, target_id: edge.target_id, via: "ops" }),
      now,
    ],
  );
}

function buildExtractedFromEdgeEntityInsert(
  sql: SqlClient,
  edgeId: string,
  entityId: string,
  sourceId: string,
  actorId: string,
  now: string,
  extractedBy?: Record<string, unknown>,
) {
  const properties = { extracted_by: extractedBy ?? {} };
  return sql.query(
    `INSERT INTO entities (
      id, kind, type, ver, properties, owner_id,
      read_level, write_level, edited_by, note, created_at, updated_at
    )
    SELECT
      $1, 'relationship', 'relationship', 1, $2::jsonb, $3,
      GREATEST(src.read_level, tgt.read_level),
      GREATEST(src.write_level, tgt.write_level),
      $3, NULL, $4::timestamptz, $4::timestamptz
    FROM entities src, entities tgt
    WHERE src.id = $5 AND tgt.id = $6
    RETURNING id`,
    [edgeId, JSON.stringify(properties), actorId, now, entityId, sourceId],
  );
}

function buildExtractedFromEdgeRelationshipInsert(
  sql: SqlClient,
  edgeId: string,
  entityId: string,
  sourceId: string,
) {
  return sql.query(
    `INSERT INTO relationship_edges (id, source_id, target_id, predicate)
     VALUES ($1, $2, $3, 'extracted_from')`,
    [edgeId, entityId, sourceId],
  );
}

// ---------------------------------------------------------------------------
// Postgres error mapping — never leak raw DB messages
// ---------------------------------------------------------------------------

interface PgErrorLike {
  code?: string;
  message?: string;
  constraint_name?: string;
}

function mapTransactionError(err: unknown, plan: OpsPlan): ApiError {
  const pg = err as PgErrorLike;
  const code = pg?.code;

  // 42501 = insufficient_privilege (RLS denied)
  if (code === "42501") {
    return new ApiError(
      403,
      "forbidden",
      "Your actor lacks the required permissions to perform one or more ops in this batch.",
      {
        fix: "Check classification ceilings and space roles for every op. Use ?dry_run=true to see which ops your actor can execute.",
      },
    );
  }

  // 23503 = foreign_key_violation — usually relationship_edges referring to
  // a missing entity. Happens when a global ULID referenced as source/target
  // is deleted between assertGlobalRefsVisible and the main transaction
  // (TOCTOU). Local @refs can't trigger this — they're created in the same tx.
  //
  // Attach the first edge whose source or target is a global ref as the most
  // likely culprit. The error still isn't exact (we don't know which specific
  // ULID was the offender without parsing pg.detail) but it gives the caller
  // an op_index to start investigating from.
  if (code === "23503") {
    const firstGlobalRefEdge = plan.edges.find(
      (e) => !e.source_is_local || !e.target_is_local,
    );
    const details: Record<string, unknown> = {
      fix: "Re-fetch the referenced entities to confirm they still exist, then retry. Only global-ULID refs can trigger this; @local refs within the batch cannot.",
      plan_edge_count: plan.edges.length,
    };
    if (firstGlobalRefEdge) {
      details.likely_op_index = firstGlobalRefEdge.op_index;
      details.likely_source = firstGlobalRefEdge.source_id;
      details.likely_target = firstGlobalRefEdge.target_id;
    }
    return new ApiError(
      404,
      "target_not_found",
      firstGlobalRefEdge
        ? `A relate op references an entity that no longer exists. Most likely op_index ${firstGlobalRefEdge.op_index}: ${firstGlobalRefEdge.source_id} → ${firstGlobalRefEdge.target_id}. The entity may have been deleted between pre-flight and write.`
        : "One or more relationship targets no longer exist. The referenced entity may have been deleted between batch creation and execution.",
      details,
    );
  }

  // 23505 = unique_violation
  if (code === "23505") {
    return new ApiError(
      409,
      "conflict",
      "A uniqueness constraint was violated. This usually means a ULID collision or a duplicate space/permission grant.",
      { fix: "Retry the request — ULID collisions are astronomically rare and usually transient." },
    );
  }

  // 23514 = check_violation — e.g. classification level out of range
  if (code === "23514") {
    return new ApiError(
      400,
      "invalid_classification",
      `A check constraint was violated: ${pg?.constraint_name ?? "unknown"}.`,
      {
        fix: "Check that all classification levels are between 0 and 4.",
      },
    );
  }

  // Unknown DB error — do NOT leak the raw message
  return new ApiError(
    500,
    "internal_error",
    "Transaction failed during ops execution.",
    {
      fix: "This is usually transient — retry the request. If it persists, contact the instance administrator.",
    },
  );
}
