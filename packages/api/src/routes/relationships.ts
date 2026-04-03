import { createRoute, z } from "@hono/zod-openapi";

import { encodeCursor } from "../lib/cursor";
import { assertBodyObject } from "../lib/entities";
import { ApiError } from "../lib/errors";
import { requireActor, parseCursorParam, parseJsonBody, parseLimit } from "../lib/http";
import { setActorContext } from "../lib/actor-context";
import { generateUlid } from "../lib/ids";
import { fanOutNotifications } from "../lib/notifications";
import { createRouter } from "../lib/openapi";
import {
  ClassificationLevel,
  DateTimeSchema,
  EntityIdParam,
  EntitySchema,
  cursorResponseSchema,
  entityIdParams,
  errorResponses,
  jsonContent,
  paginationQuerySchema,
  pathParam,
  queryParam,
} from "../lib/schemas";
import { backgroundTask } from "../lib/background";
import { indexEntity, removeEntity } from "../lib/meilisearch";
import { createSql } from "../lib/sql";

type RelationshipRow = {
  id: string;
  predicate: string;
  source_id: string;
  target_id: string;
  ver: number;
  properties: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
};

const RelationshipSummarySchema = z.object({
  id: EntityIdParam,
  predicate: z.string(),
  source_id: EntityIdParam,
  target_id: EntityIdParam,
  direction: z.enum(["in", "out"]).describe("Whether this entity is the source (out) or target (in)"),
  properties: z.record(z.string(), z.any()),
  source: z.any().optional(),
  target: z.any().optional(),
});

const listRelationshipsRoute = createRoute({
  method: "get",
  path: "/{id}/relationships",
  operationId: "listRelationships",
  tags: ["Relationships"],
  summary: "List relationships for an entity",
  "x-arke-auth": "optional",
  "x-arke-related": ["POST /entities/{id}/relationships", "GET /relationships/{relId}"],
  "x-arke-rules": ["Results filtered by your classification clearance", "Only shows relationships where you can read the relationship entity"],
  request: {
    params: entityIdParams(),
    query: paginationQuerySchema(50, 200).extend({
      direction: queryParam("direction", z.enum(["in", "out", "both"]).optional(), "in | out | both (default: both)"),
      predicate: queryParam("predicate", z.string().optional(), "Filter by predicate string"),
      target_id: queryParam("target_id", z.string().optional(), "Filter by specific target or source"),
    }),
  },
  responses: {
    200: {
      description: "Relationships for the entity",
      content: jsonContent(cursorResponseSchema("relationships", RelationshipSummarySchema)),
    },
    ...errorResponses([400, 403, 404]),
  },
});

const createRelationshipRoute = createRoute({
  method: "post",
  path: "/{id}/relationships",
  operationId: "createRelationship",
  tags: ["Relationships"],
  summary: "Create a relationship from this entity to a target",
  "x-arke-auth": "required",
  "x-arke-related": ["GET /entities/{id}/relationships", "DELETE /relationships/{relId}"],
  "x-arke-rules": ["Requires edit access on the source entity (owner, editor, or admin role)", "Requires read access on the target entity", "Relationship read_level must be >= max(source, target) read_level", "Relationship write_level must be >= max(source, target) write_level"],
  request: {
    params: entityIdParams("Source entity ULID"),
    body: {
      required: true,
      content: jsonContent(
        z.object({
          predicate: z.string().describe("Relationship type (e.g. 'references', 'contains')"),
          target_id: EntityIdParam.describe("Target entity ULID"),
          properties: z.record(z.string(), z.any()).optional().describe("Relationship properties"),
          read_level: ClassificationLevel.optional().describe("Classification level for reading. Must be >= max(source, target) read_level. Defaults to that maximum."),
          write_level: ClassificationLevel.optional().describe("Classification level for writing. Must be >= max(source, target) write_level. Defaults to that maximum."),
        }),
      ),
    },
  },
  responses: {
    201: {
      description: "Relationship created",
      content: jsonContent(
        z.object({
          relationship: EntitySchema,
          edge: z.object({
            id: EntityIdParam,
            source_id: EntityIdParam,
            target_id: EntityIdParam,
            predicate: z.string(),
          }),
        }),
      ),
    },
    ...errorResponses([400, 401, 403, 404]),
  },
});

const getRelationshipRoute = createRoute({
  method: "get",
  path: "/{relId}",
  operationId: "getRelationship",
  tags: ["Relationships"],
  summary: "Get a relationship by its ID with source/target details",
  "x-arke-auth": "optional",
  "x-arke-related": ["PUT /relationships/{relId}", "DELETE /relationships/{relId}"],
  "x-arke-rules": ["Requires read_level clearance >= relationship's read_level"],
  request: {
    params: z.object({
      relId: pathParam("relId", EntityIdParam, "Relationship entity ULID"),
    }),
  },
  responses: {
    200: {
      description: "Relationship details",
      content: jsonContent(
        z.object({
          id: EntityIdParam,
          predicate: z.string(),
          source_id: EntityIdParam,
          target_id: EntityIdParam,
          properties: z.record(z.string(), z.any()),
          source: z.any(),
          target: z.any(),
        }),
      ),
    },
    ...errorResponses([400, 403, 404]),
  },
});

const updateRelationshipRoute = createRoute({
  method: "put",
  path: "/{relId}",
  operationId: "updateRelationship",
  tags: ["Relationships"],
  summary: "Update relationship properties",
  "x-arke-auth": "required",
  "x-arke-rules": ["Only the owner, an entity editor, or an entity admin may update", "Requires write_level clearance >= relationship's write_level", "Optimistic concurrency: must pass current ver to update"],
  request: {
    params: z.object({
      relId: pathParam("relId", EntityIdParam, "Relationship entity ULID"),
    }),
    body: {
      required: true,
      content: jsonContent(
        z.object({
          properties: z.record(z.string(), z.any()).describe("New properties"),
          ver: z.number().int().describe("Expected current version (CAS token). Server increments ver on success."),
          note: z.string().optional().describe("Edit note"),
        }),
      ),
    },
  },
  responses: {
    200: {
      description: "Relationship updated",
      content: jsonContent(z.object({ relationship: EntitySchema })),
    },
    ...errorResponses([400, 401, 403, 404, 409]),
  },
});

const deleteRelationshipRoute = createRoute({
  method: "delete",
  path: "/{relId}",
  operationId: "deleteRelationship",
  tags: ["Relationships"],
  summary: "Delete a relationship",
  "x-arke-auth": "required",
  "x-arke-rules": ["Only the relationship owner, a system admin, or an actor with edit access on the source entity may delete"],
  request: {
    params: z.object({
      relId: pathParam("relId", EntityIdParam, "Relationship entity ULID"),
    }),
  },
  responses: {
    204: {
      description: "Relationship deleted",
    },
    ...errorResponses([400, 401, 403, 404]),
  },
});

export const entityRelationshipsRouter = createRouter();
export const relationshipDirectRouter = createRouter();

entityRelationshipsRouter.openapi(listRelationshipsRoute, async (c) => {
  const sql = createSql();
  const entityId = c.req.param("id");
  const dirParam = c.req.query("direction");
  const direction = dirParam === "in" || dirParam === "out" ? dirParam : "both";
  const predicate = c.req.query("predicate");
  const limit = parseLimit(c, { defaultValue: 50, maxValue: 200 });
  const cursor = parseCursorParam(c);
  const targetId = c.req.query("target_id");

  // Build WHERE clause based on direction
  const directionFilter =
    direction === "out" ? "re.source_id = $1"
    : direction === "in" ? "re.target_id = $1"
    : "(re.source_id = $1 OR re.target_id = $1)";

  const actorCtx = c.get("actor");
  const [,,,,, rows] = await sql.transaction([
    ...setActorContext(sql, actorCtx),
    sql.query(
      `
        SELECT
          rel.id,
          re.predicate,
          re.source_id,
          re.target_id,
          rel.properties,
          CASE WHEN re.source_id = $1 THEN 'out' ELSE 'in' END AS direction,
          json_build_object(
            'id', other.id,
            'kind', other.kind,
            'type', other.type,
            'properties', other.properties
          ) AS counterpart,
          rel.created_at
        FROM relationship_edges re
        JOIN entities rel ON rel.id = re.id
        JOIN entities other ON other.id = CASE WHEN re.source_id = $1 THEN re.target_id ELSE re.source_id END
        WHERE ${directionFilter}
          AND ($2::text IS NULL OR re.predicate = $2)
          AND ($3::text IS NULL OR re.target_id = $3 OR re.source_id = $3)
          AND ($4::timestamptz IS NULL OR (rel.created_at, rel.id) < ($4::timestamptz, $5::text))
        ORDER BY rel.created_at DESC, rel.id DESC
        LIMIT $6
      `,
      [entityId, predicate ?? null, targetId ?? null, cursor?.t ?? null, cursor?.i ?? null, limit + 1],
    ),
  ]);

  const page = (rows as Array<Record<string, unknown>>).slice(0, limit);
  const next = (rows as Array<Record<string, unknown>>).length > limit ? page[page.length - 1] : null;

  return c.json({
    relationships: page.map((row) => {
      const dir = row.direction as string;
      return {
        id: row.id,
        predicate: row.predicate,
        source_id: row.source_id,
        target_id: row.target_id,
        direction: dir,
        properties: row.properties,
        [dir === "in" ? "source" : "target"]: row.counterpart,
      };
    }),
    cursor: next ? encodeCursor({ t: next.created_at as string | Date, i: String(next.id) }) : null,
  }, 200);
});

entityRelationshipsRouter.openapi(createRelationshipRoute, async (c) => {
  const actor = requireActor(c);
  const sourceId = c.req.param("id");
  const body = await parseJsonBody<Record<string, unknown>>(c);
  if (typeof body.predicate !== "string" || typeof body.target_id !== "string") {
    throw new ApiError(400, "invalid_body", "Invalid relationship payload");
  }
  const properties = body.properties === undefined ? {} : assertBodyObject(body.properties, "properties");
  const requestedReadLevel = typeof body.read_level === "number" ? body.read_level : null;
  const requestedWriteLevel = typeof body.write_level === "number" ? body.write_level : null;
  const relId = generateUlid();
  const now = new Date().toISOString();
  const sql = createSql();

  // Pre-validate: actor must see both entities, have edit access on source,
  // and any requested classification levels must be at or above the endpoint floor
  const [,,,,, preCheckRows] = await sql.transaction([
    ...setActorContext(sql, actor),
    sql`
      SELECT
        src.owner_id AS source_owner,
        (
          current_actor_is_admin()
          OR src.owner_id = current_actor_id()
          OR actor_has_entity_role(src.id, ARRAY['editor', 'admin'])
        ) AS can_edit_source,
        GREATEST(src.read_level, tgt.read_level) AS min_read,
        GREATEST(src.write_level, tgt.write_level) AS min_write
      FROM entities src, entities tgt
      WHERE src.id = ${sourceId} AND tgt.id = ${body.target_id}
    `,
  ]);

  const preCheck = (preCheckRows as Array<{
    source_owner: string; can_edit_source: boolean;
    min_read: number; min_write: number;
  }>)[0];
  if (!preCheck) {
    // At least one entity not visible to actor — diagnose which
    const [, srcExists, tgtExists] = await sql.transaction([
      sql`SELECT set_config('app.actor_id', '', true)`,
      sql`SELECT entity_exists(${sourceId}) AS e`,
      sql`SELECT entity_exists(${body.target_id}) AS e`,
    ]);
    const srcE = (srcExists as Array<{ e: boolean }>)[0]?.e;
    const tgtE = (tgtExists as Array<{ e: boolean }>)[0]?.e;
    if (!srcE) throw new ApiError(404, "not_found", "Source entity not found");
    if (!tgtE) throw new ApiError(404, "not_found", "Target entity not found");
    throw new ApiError(403, "forbidden", "Insufficient classification level to access source or target entity");
  }
  if (!preCheck.can_edit_source) {
    throw new ApiError(403, "forbidden", "You need edit access on the source entity to create relationships from it");
  }
  if (requestedReadLevel !== null && requestedReadLevel < preCheck.min_read) {
    throw new ApiError(400, "invalid_read_level",
      `read_level ${requestedReadLevel} must be >= max(source, target) read_level (${preCheck.min_read})`);
  }
  if (requestedWriteLevel !== null && requestedWriteLevel < preCheck.min_write) {
    throw new ApiError(400, "invalid_write_level",
      `write_level ${requestedWriteLevel} must be >= max(source, target) write_level (${preCheck.min_write})`);
  }

  const [,,,,, entityRows, edgeRows] = await sql.transaction([
    ...setActorContext(sql, actor),
    sql`
      INSERT INTO entities (
        id, kind, type, arke_id, ver, properties, owner_id,
        read_level, write_level,
        edited_by, note, created_at, updated_at
      )
      SELECT
        ${relId}, 'relationship', 'relationship', src.arke_id, 1, ${JSON.stringify(properties)}::jsonb,
        ${actor.id},
        GREATEST(src.read_level, tgt.read_level, ${requestedReadLevel ?? 0}),
        GREATEST(src.write_level, tgt.write_level, ${requestedWriteLevel ?? 0}),
        ${actor.id}, NULL, ${now}::timestamptz, ${now}::timestamptz
      FROM entities src, entities tgt
      WHERE src.id = ${sourceId} AND tgt.id = ${body.target_id}
      RETURNING *
    `,
    sql`
      INSERT INTO relationship_edges (id, source_id, target_id, predicate)
      VALUES (${relId}, ${sourceId}, ${body.target_id}, ${body.predicate})
      RETURNING *
    `,
    sql`
      INSERT INTO entity_versions (entity_id, ver, properties, edited_by, note, created_at)
      VALUES (${relId}, 1, ${JSON.stringify(properties)}::jsonb, ${actor.id}, NULL, ${now}::timestamptz)
    `,
    sql`
      INSERT INTO entity_activity (entity_id, actor_id, action, detail, ts)
      VALUES (${sourceId}, ${actor.id}, 'relationship_created',
             ${JSON.stringify({ relationship_id: relId, predicate: body.predicate, target_id: body.target_id })}::jsonb,
             ${now}::timestamptz)
    `,
  ]);

  backgroundTask(
    fanOutNotifications({
      entity_id: sourceId,
      actor_id: actor.id,
      action: "relationship_created",
      detail: { relationship_id: relId, predicate: body.predicate, target_id: body.target_id },
      ts: now,
    }),
  );

  const relEntity = (entityRows as Array<Record<string, unknown>>)[0];
  if (!relEntity) {
    throw new ApiError(500, "internal_error", "Failed to create relationship entity");
  }
  backgroundTask(indexEntity(relEntity, sql));

  return c.json(
    {
      relationship: relEntity,
      edge: (edgeRows as Array<Record<string, unknown>>)[0],
    },
    201,
  );
});

relationshipDirectRouter.openapi(getRelationshipRoute, async (c) => {
  const sql = createSql();
  const actorId = c.get("actor")?.id ?? "";
  const relId = c.req.param("relId");

  const actorCtx = c.get("actor");
  const [,,,,, rows] = await sql.transaction([
    ...setActorContext(sql, actorCtx),
    sql.query(
      `
        SELECT
          rel.*,
          re.predicate,
          re.source_id,
          re.target_id,
          json_build_object('id', source.id, 'kind', source.kind, 'type', source.type, 'properties', source.properties) AS source,
          json_build_object('id', target.id, 'kind', target.kind, 'type', target.type, 'properties', target.properties) AS target
        FROM entities rel
        JOIN relationship_edges re ON re.id = rel.id
        JOIN entities source ON source.id = re.source_id
        JOIN entities target ON target.id = re.target_id
        WHERE rel.id = $1
        LIMIT 1
      `,
      [relId],
    ),
  ]);

  const row = (rows as Array<Record<string, unknown>>)[0];
  if (!row) {
    throw new ApiError(404, "not_found", "Relationship not found");
  }

  return c.json(row, 200);
});

relationshipDirectRouter.openapi(updateRelationshipRoute, async (c) => {
  const actor = requireActor(c);
  const relId = c.req.param("relId");
  const body = await parseJsonBody<Record<string, unknown>>(c);
  if (typeof body.ver !== "number") {
    throw new ApiError(400, "missing_required_field", "Missing ver");
  }
  const properties = assertBodyObject(body.properties, "properties");
  const note = body.note === undefined ? null : typeof body.note === "string" ? body.note : null;
  const now = new Date().toISOString();
  const sql = createSql();

  const [,,,,, rows] = await sql.transaction([
    ...setActorContext(sql, actor),
    sql.query(
      `
        UPDATE entities
        SET properties = $1::jsonb,
            ver = ver + 1,
            edited_by = $2,
            note = $3,
            updated_at = $4::timestamptz
        WHERE id = $5
          AND ver = $6
        RETURNING *
      `,
      [JSON.stringify(properties), actor.id, note, now, relId, body.ver],
    ),
  ]);

  const row = (rows as Array<Record<string, unknown>>)[0];
  if (!row) {
    throw new ApiError(409, "cas_conflict", "Version mismatch");
  }
  await sql.transaction([
    ...setActorContext(sql, actor),
    sql.query(
      `
        INSERT INTO entity_versions (entity_id, ver, properties, edited_by, note, created_at)
        SELECT id, ver, properties, edited_by, note, $2::timestamptz
        FROM entities
        WHERE id = $1
      `,
      [relId, now],
    ),
    sql.query(
      `
        INSERT INTO entity_activity (entity_id, actor_id, action, detail, ts)
        SELECT re.source_id, $2, 'relationship_updated',
               $3::jsonb, $4::timestamptz
        FROM relationship_edges re
        WHERE re.id = $1
      `,
      [relId, actor.id, JSON.stringify({ relationship_id: relId, ver: row.ver }), now],
    ),
  ]);
  backgroundTask(indexEntity(row as Record<string, unknown>, sql));
  return c.json({ relationship: row }, 200);
});

relationshipDirectRouter.openapi(deleteRelationshipRoute, async (c) => {
  const actor = requireActor(c);
  const relId = c.req.param("relId");
  const now = new Date().toISOString();
  const sql = createSql();

  const [,,,,, relRows] = await sql.transaction([
    ...setActorContext(sql, actor),
    sql.query(
      `
        SELECT re.source_id, re.target_id, re.predicate
        FROM relationship_edges re
        WHERE re.id = $1
      `,
      [relId],
    ),
  ]);

  const rel = (relRows as Array<{ source_id: string; target_id: string; predicate: string }>)[0];
  if (!rel) {
    throw new ApiError(404, "not_found", "Relationship not found");
  }

  await sql.transaction([
    ...setActorContext(sql, actor),
    sql`DELETE FROM entities WHERE id = ${relId}`,
    sql`
      INSERT INTO entity_activity (entity_id, actor_id, action, detail, ts)
      VALUES (
        ${rel.source_id},
        ${actor.id},
        'relationship_removed',
        ${JSON.stringify({ relationship_id: relId, predicate: rel.predicate, target_id: rel.target_id })}::jsonb,
        ${now}::timestamptz
      )
    `,
  ]);

  backgroundTask(removeEntity(relId));
  backgroundTask(
    fanOutNotifications({
      entity_id: rel.source_id,
      space_id: null,
      actor_id: actor.id,
      action: "relationship_removed",
      detail: { relationship_id: relId, predicate: rel.predicate, target_id: rel.target_id },
      ts: now,
    }),
  );

  return new Response(null, { status: 204 });
});
