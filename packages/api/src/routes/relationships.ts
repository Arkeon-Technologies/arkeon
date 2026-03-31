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
  request: {
    params: entityIdParams(),
    query: paginationQuerySchema(50, 200).extend({
      direction: queryParam("direction", z.enum(["in", "out"]).optional(), "in | out (default: out)"),
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
  request: {
    params: entityIdParams("Source entity ULID"),
    body: {
      required: true,
      content: jsonContent(
        z.object({
          predicate: z.string().describe("Relationship type (e.g. 'references', 'contains')"),
          target_id: EntityIdParam.describe("Target entity ULID"),
          properties: z.record(z.string(), z.any()).optional().describe("Relationship properties"),
        }),
      ),
    },
  },
  responses: {
    201: {
      description: "Relationship created",
      content: jsonContent(
        z.object({
          relationship_entity: EntitySchema,
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
  const actorId = c.get("actor")?.id ?? "";
  const entityId = c.req.param("id");
  const direction = c.req.query("direction") === "in" ? "in" : "out";
  const predicate = c.req.query("predicate");
  const limit = parseLimit(c, { defaultValue: 50, maxValue: 200 });
  const cursor = parseCursorParam(c);
  const targetId = c.req.query("target_id");

  const sourceColumn = direction === "in" ? "re.target_id" : "re.source_id";
  const joinColumn = direction === "in" ? "re.source_id" : "re.target_id";
  const counterpartKey = direction === "in" ? "source" : "target";

  const actorCtx = c.get("actor");
  const [,,,, rows] = await sql.transaction([
    ...setActorContext(sql, actorCtx),
    sql.query(
      `
        SELECT
          rel.id,
          re.predicate,
          re.source_id,
          re.target_id,
          rel.properties,
          json_build_object(
            'id', other.id,
            'kind', other.kind,
            'type', other.type,
            'properties', other.properties
          ) AS counterpart,
          rel.created_at
        FROM relationship_edges re
        JOIN entities rel ON rel.id = re.id
        JOIN entities other ON other.id = ${joinColumn}
        WHERE ${sourceColumn} = $1
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
    relationships: page.map((row) => ({
      id: row.id,
      predicate: row.predicate,
      target_id: row.target_id,
      source_id: row.source_id,
      properties: row.properties,
      [counterpartKey]: row.counterpart,
    })),
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
  const relId = generateUlid();
  const now = new Date().toISOString();
  const sql = createSql();

  const [,,,, entityRows, edgeRows] = await sql.transaction([
    ...setActorContext(sql, actor),
    sql`
      INSERT INTO entities (
        id, kind, type, network_id, ver, properties, owner_id,
        read_level, write_level,
        edited_by, note, created_at, updated_at
      )
      SELECT
        ${relId}, 'relationship', 'relationship', src.network_id, 1, ${JSON.stringify(properties)}::jsonb,
        ${actor.id},
        GREATEST(src.read_level, tgt.read_level),
        GREATEST(src.write_level, tgt.write_level),
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
  backgroundTask(indexEntity(relEntity, sql));

  return c.json(
    {
      relationship_entity: relEntity,
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
  const [,,,, rows] = await sql.transaction([
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

  const [,,,, rows] = await sql.transaction([
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

  const [,,,, relRows] = await sql.transaction([
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
