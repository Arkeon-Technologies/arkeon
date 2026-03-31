import { createRoute, z } from "@hono/zod-openapi";

import { backgroundTask } from "../lib/background";
import { encodeCursor } from "../lib/cursor";
import { parseProjection, projectEntity } from "../lib/entity-projection";
import { assertBodyObject, type EntityRecord } from "../lib/entities";
import { ApiError } from "../lib/errors";
import {
  requireActor,
  parseCursorParam,
  parseJsonBody,
  parseLimit,
} from "../lib/http";
import { generateUlid } from "../lib/ids";
import { buildEntityListingQuery, mergeFilters, parseOrder, parseSort } from "../lib/listing";
import { indexEntity, indexEntityById, removeEntity } from "../lib/meilisearch";
import { createRouter } from "../lib/openapi";
import {
  ClassificationLevel,
  DateTimeSchema,
  EntityIdParam,
  EntityResponse,
  EntitySchema,
  ProjectionQuery,
  cursorResponseSchema,
  entityIdParams,
  errorResponses,
  filterQuerySchema,
  jsonContent,
  paginationQuerySchema,
  pathParam,
  queryParam,
} from "../lib/schemas";
import { setActorContext } from "../lib/actor-context";
import { createSql } from "../lib/sql";

type VersionRow = {
  entity_id?: string;
  ver: number;
  properties?: Record<string, unknown>;
  edited_by: string;
  note: string | null;
  created_at: string;
};

const PermissionGrantSchema = z.object({
  entity_id: EntityIdParam,
  grantee_type: z.enum(["actor", "group"]),
  grantee_id: z.string(),
  role: z.enum(["admin", "editor"]),
  granted_by: EntityIdParam,
  granted_at: DateTimeSchema,
});

const VersionSchema = z.object({
  entity_id: EntityIdParam.optional(),
  ver: z.number().int(),
  properties: z.record(z.string(), z.any()).optional(),
  edited_by: EntityIdParam,
  note: z.string().nullable(),
  created_at: DateTimeSchema,
});

// --- Route definitions ---

const ListEntitiesQuery = filterQuerySchema(["updated_at", "created_at"], "updated_at")
  .merge(ProjectionQuery)
  .merge(paginationQuerySchema(50, 200));

const listEntitiesRoute = createRoute({
  method: "get",
  path: "/",
  operationId: "listEntities",
  tags: ["Entities"],
  summary: "List entities with filtering, sorting, and cursor pagination",
  "x-arke-auth": "optional",
  "x-arke-related": ["GET /search", "GET /entities/{id}"],
  request: {
    query: ListEntitiesQuery,
  },
  responses: {
    200: {
      description: "Paginated entity list",
      content: jsonContent(cursorResponseSchema("entities", EntitySchema)),
    },
    ...errorResponses([400, 403]),
  },
});

const createEntityRoute = createRoute({
  method: "post",
  path: "/",
  operationId: "createEntity",
  tags: ["Entities"],
  summary: "Create a new entity",
  "x-arke-auth": "required",
  "x-arke-related": ["GET /entities/{id}", "PUT /entities/{id}"],
  request: {
    body: {
      required: true,
      content: jsonContent(
        z.object({
          network_id: EntityIdParam.describe("Arke (network) ULID"),
          type: z.string().describe("Entity type"),
          properties: z.record(z.string(), z.any()).describe("Arbitrary properties"),
          read_level: ClassificationLevel.optional(),
          write_level: ClassificationLevel.optional(),
        }),
      ),
    },
  },
  responses: {
    201: {
      description: "Entity created",
      content: jsonContent(EntityResponse),
    },
    ...errorResponses([400, 401, 403]),
  },
});

const getEntityRoute = createRoute({
  method: "get",
  path: "/{id}",
  operationId: "getEntity",
  tags: ["Entities"],
  summary: "Fetch a single entity by ID",
  "x-arke-auth": "optional",
  "x-arke-related": [
    "PUT /entities/{id}",
    "GET /entities/{id}/versions",
  ],
  request: {
    params: entityIdParams(),
    query: z.object({
      view: queryParam(
        "view",
        z.enum(["full", "summary"]).optional(),
        "Projection: full | summary",
      ),
      fields: queryParam("fields", z.string().optional(), "Comma-separated field list"),
    }),
  },
  responses: {
    200: {
      description: "Entity details",
      content: jsonContent(EntityResponse),
    },
    304: { description: "Not modified" },
    ...errorResponses([400, 404]),
  },
});

const updateEntityRoute = createRoute({
  method: "put",
  path: "/{id}",
  operationId: "updateEntity",
  tags: ["Entities"],
  summary: "Update entity properties",
  "x-arke-auth": "required",
  "x-arke-related": ["GET /entities/{id}", "GET /entities/{id}/versions"],
  request: {
    params: entityIdParams(),
    body: {
      required: true,
      content: jsonContent(
        z.object({
          ver: z.number().int().describe("Expected current version (CAS token)"),
          properties: z.record(z.string(), z.any()).optional(),
          note: z.string().optional(),
        }),
      ),
    },
  },
  responses: {
    200: {
      description: "Entity updated",
      content: jsonContent(EntityResponse),
    },
    ...errorResponses([400, 401, 403, 404, 409]),
  },
});

const deleteEntityRoute = createRoute({
  method: "delete",
  path: "/{id}",
  operationId: "deleteEntity",
  tags: ["Entities"],
  summary: "Delete an entity",
  "x-arke-auth": "required",
  request: { params: entityIdParams() },
  responses: {
    204: { description: "Entity deleted" },
    ...errorResponses([401, 403, 404]),
  },
});

const changeLevelRoute = createRoute({
  method: "put",
  path: "/{id}/level",
  operationId: "changeEntityLevel",
  tags: ["Entities"],
  summary: "Change entity classification levels",
  "x-arke-auth": "required",
  request: {
    params: entityIdParams(),
    body: {
      required: true,
      content: jsonContent(
        z.object({
          read_level: ClassificationLevel.optional(),
          write_level: ClassificationLevel.optional(),
        }),
      ),
    },
  },
  responses: {
    200: {
      description: "Classification updated",
      content: jsonContent(EntityResponse),
    },
    ...errorResponses([400, 401, 403, 404]),
  },
});

const getPermissionsRoute = createRoute({
  method: "get",
  path: "/{id}/permissions",
  operationId: "getEntityPermissions",
  tags: ["Entities"],
  summary: "List permission grants on an entity",
  "x-arke-auth": "required",
  request: { params: entityIdParams() },
  responses: {
    200: {
      description: "Entity permissions",
      content: jsonContent(
        z.object({
          owner_id: EntityIdParam,
          permissions: z.array(PermissionGrantSchema),
        }),
      ),
    },
    ...errorResponses([401, 404]),
  },
});

const grantPermissionRoute = createRoute({
  method: "post",
  path: "/{id}/permissions",
  operationId: "grantEntityPermission",
  tags: ["Entities"],
  summary: "Grant a role on an entity (owner/admin only, enforced by RLS)",
  "x-arke-auth": "required",
  request: {
    params: entityIdParams(),
    body: {
      required: true,
      content: jsonContent(
        z.object({
          grantee_type: z.enum(["actor", "group"]),
          grantee_id: z.string(),
          role: z.enum(["admin", "editor"]),
        }),
      ),
    },
  },
  responses: {
    201: {
      description: "Permission granted",
      content: jsonContent(z.object({ permission: PermissionGrantSchema })),
    },
    ...errorResponses([400, 401, 403, 404]),
  },
});

const revokePermissionRoute = createRoute({
  method: "delete",
  path: "/{id}/permissions/{granteeId}",
  operationId: "revokeEntityPermission",
  tags: ["Entities"],
  summary: "Revoke a role from a user or group",
  "x-arke-auth": "required",
  request: {
    params: z.object({
      id: pathParam("id", EntityIdParam, "Entity ULID"),
      granteeId: pathParam("granteeId", z.string(), "Grantee actor or group ID"),
    }),
  },
  responses: {
    204: { description: "Permission revoked" },
    ...errorResponses([401, 403, 404]),
  },
});

const transferOwnerRoute = createRoute({
  method: "put",
  path: "/{id}/owner",
  operationId: "transferEntityOwner",
  tags: ["Entities"],
  summary: "Transfer entity ownership",
  "x-arke-auth": "required",
  request: {
    params: entityIdParams(),
    body: {
      required: true,
      content: jsonContent(
        z.object({
          owner_id: EntityIdParam.describe("New owner actor ULID"),
        }),
      ),
    },
  },
  responses: {
    200: {
      description: "Ownership transferred",
      content: jsonContent(EntityResponse),
    },
    ...errorResponses([400, 401, 403, 404]),
  },
});

const listVersionsRoute = createRoute({
  method: "get",
  path: "/{id}/versions",
  operationId: "listEntityVersions",
  tags: ["Entities"],
  summary: "List version history",
  "x-arke-auth": "optional",
  request: {
    params: entityIdParams(),
    query: paginationQuerySchema(50, 200),
  },
  responses: {
    200: {
      description: "Version history",
      content: jsonContent(cursorResponseSchema("versions", VersionSchema)),
    },
    ...errorResponses([400, 404]),
  },
});

const getVersionRoute = createRoute({
  method: "get",
  path: "/{id}/versions/{ver}",
  operationId: "getEntityVersion",
  tags: ["Entities"],
  summary: "Get a specific version snapshot",
  "x-arke-auth": "optional",
  request: {
    params: z.object({
      id: pathParam("id", EntityIdParam, "Entity ULID"),
      ver: pathParam("ver", z.coerce.number().int().min(1), "Version number"),
    }),
  },
  responses: {
    200: {
      description: "Version snapshot",
      content: jsonContent(VersionSchema.extend({ entity_id: EntityIdParam })),
    },
    ...errorResponses([400, 404]),
  },
});

// --- Handlers ---

export const entitiesRouter = createRouter();

entitiesRouter.openapi(listEntitiesRoute, async (c) => {
  const sql = createSql();
  const actorCtx = c.get("actor");
  const limit = parseLimit(c, { defaultValue: 50, maxValue: 200 });
  const projection = parseProjection(c.req.query("view"), c.req.query("fields"));
  const cursor = parseCursorParam(c);
  const order = parseOrder(c.req.query("order"));
  const sort = parseSort(c.req.query("sort"), ["updated_at", "created_at"], "updated_at");

  const userFilter = c.req.query("filter");
  const hasKindFilter = userFilter?.split(",").some((expr) => expr.trim().startsWith("kind"));
  const implicitFilter = hasKindFilter ? undefined : "kind!:relationship";
  const filter = implicitFilter ? mergeFilters(implicitFilter, userFilter) : userFilter;

  const listing = buildEntityListingQuery({ filter, limit, cursor, sort, order });

  const txResults = await sql.transaction([
    ...setActorContext(sql, actorCtx),
    sql.query(listing.query, listing.params),
  ]);
  const rows = txResults[txResults.length - 1] as Array<Record<string, unknown>>;
  const entities = rows.slice(0, limit);
  const next = rows.length > limit ? entities[entities.length - 1] : null;

  return c.json({
    entities: entities.map((row) => projectEntity(row, projection)),
    cursor: next ? encodeCursor({ t: (next[sort] ?? next.updated_at) as string | Date, i: String(next.id) }) : null,
  }, 200);
});

entitiesRouter.openapi(createEntityRoute, async (c) => {
  const actor = requireActor(c);
  const body = await parseJsonBody<Record<string, unknown>>(c);

  if (typeof body.network_id !== "string") {
    throw new ApiError(400, "missing_required_field", "Missing network_id");
  }
  if (typeof body.type !== "string") {
    throw new ApiError(400, "missing_required_field", "Missing type");
  }

  const properties = assertBodyObject(body.properties, "properties");
  const id = generateUlid();
  const now = new Date().toISOString();
  const readLevel = typeof body.read_level === "number" ? body.read_level : 1;
  const writeLevel = typeof body.write_level === "number" ? body.write_level : 1;
  const sql = createSql();

  // RLS enforces: actor.max_write_level >= write_level AND actor.max_read_level >= read_level
  const results = await sql.transaction([
    ...setActorContext(sql, actor),
    sql.query(
      `INSERT INTO entities (
        id, kind, type, network_id, ver, properties, owner_id,
        read_level, write_level, edited_by, note, created_at, updated_at
      ) VALUES (
        $1, 'entity', $2, $3, 1, $4::jsonb, $5,
        $6, $7, $5, NULL, $8::timestamptz, $8::timestamptz
      ) RETURNING *`,
      [id, body.type, body.network_id, JSON.stringify(properties), actor.id, readLevel, writeLevel, now],
    ),
    sql.query(
      `INSERT INTO entity_versions (entity_id, ver, properties, edited_by, note, created_at)
       VALUES ($1, 1, $2::jsonb, $3, NULL, $4::timestamptz)`,
      [id, JSON.stringify(properties), actor.id, now],
    ),
    sql.query(
      `INSERT INTO entity_activity (entity_id, actor_id, action, detail, ts)
       VALUES ($1, $2, 'entity_created', $3::jsonb, $4::timestamptz)`,
      [id, actor.id, JSON.stringify({ kind: "entity", type: body.type }), now],
    ),
  ]);

  const inserted = (results[4] as EntityRecord[])[0]; // 4 context queries + INSERT
  if (!inserted) {
    throw new ApiError(403, "forbidden", "Insufficient classification level");
  }

  backgroundTask(indexEntity(inserted, sql));

  return c.json({ entity: inserted }, 201);
});

entitiesRouter.openapi(getEntityRoute, async (c) => {
  const actor = c.get("actor");
  const projection = parseProjection(c.req.query("view"), c.req.query("fields"));
  const entityId = c.req.param("id");
  const sql = createSql();

  // RLS handles classification filtering — just SELECT
  const results = await sql.transaction([
    ...setActorContext(sql, actor),
    sql`SELECT * FROM entities WHERE id = ${entityId} LIMIT 1`,
  ]);

  const entity = (results[results.length - 1] as EntityRecord[])[0];
  if (!entity) {
    throw new ApiError(404, "not_found", "Entity not found");
  }

  const ifNoneMatch = c.req.header("if-none-match")?.replaceAll("\"", "");
  if (ifNoneMatch && ifNoneMatch === String(entity.ver)) {
    return new Response(null, {
      status: 304,
      headers: { ETag: `"${entity.ver}"` },
    });
  }

  c.header("etag", `"${entity.ver}"`);
  return c.json({ entity: projectEntity(entity, projection) }, 200);
});

entitiesRouter.openapi(updateEntityRoute, async (c) => {
  const actor = requireActor(c);
  const entityId = c.req.param("id");
  const body = await parseJsonBody<Record<string, unknown>>(c);
  const expectedVer = typeof body.ver === "number" ? body.ver : null;
  if (expectedVer === null) {
    throw new ApiError(400, "missing_required_field", "Missing ver");
  }

  const properties = body.properties === undefined
    ? undefined
    : assertBodyObject(body.properties, "properties");
  const note = body.note === undefined ? null : typeof body.note === "string" ? body.note : null;

  if (!properties) {
    throw new ApiError(400, "invalid_body", "No changes requested");
  }

  const sql = createSql();
  const now = new Date().toISOString();

  // RLS enforces: classification ceiling + ACL (owner/editor/admin/is_admin)
  const results = await sql.transaction([
    ...setActorContext(sql, actor),
    sql.query(
      `UPDATE entities
       SET properties = $1::jsonb,
           ver = ver + 1,
           edited_by = $2,
           note = $3,
           updated_at = $4::timestamptz
       WHERE id = $5 AND ver = $6
       RETURNING *`,
      [JSON.stringify(properties), actor.id, note, now, entityId, expectedVer],
    ),
  ]);

  const updated = (results[results.length - 1] as EntityRecord[])[0];
  if (!updated) {
    // Distinguish CAS conflict from permission denial
    const existsResult = await sql.transaction([
      ...setActorContext(sql, actor),
      sql`SELECT ver FROM entities WHERE id = ${entityId} LIMIT 1`,
    ]);
    const fresh = (existsResult[existsResult.length - 1] as Array<{ ver: number }>)[0];
    if (fresh) {
      if (fresh.ver !== expectedVer) {
        throw new ApiError(409, "cas_conflict", "Version mismatch", {
          entity_id: entityId,
          expected_ver: expectedVer,
        });
      }
      throw new ApiError(403, "forbidden", "Forbidden");
    }
    // Entity not visible — could be 403 or 404
    const exists = await sql.transaction([
      sql`SELECT set_config('app.actor_id', '', true)`,
      sql`SELECT entity_exists(${entityId}) AS e`,
    ]);
    if ((exists[1] as Array<{ e: boolean }>)[0]?.e) {
      throw new ApiError(403, "forbidden", "Forbidden");
    }
    throw new ApiError(404, "not_found", "Entity not found");
  }

  // Version snapshot + activity
  backgroundTask(
    sql.transaction([
      ...setActorContext(sql, actor),
      sql.query(
        `INSERT INTO entity_versions (entity_id, ver, properties, edited_by, note, created_at)
         VALUES ($1, $2, $3::jsonb, $4, $5, $6::timestamptz)`,
        [entityId, updated.ver, JSON.stringify(updated.properties), actor.id, note, now],
      ),
      sql.query(
        `INSERT INTO entity_activity (entity_id, actor_id, action, detail, ts)
         VALUES ($1, $2, 'content_updated', $3::jsonb, $4::timestamptz)`,
        [entityId, actor.id, JSON.stringify({ ver: updated.ver, note }), now],
      ),
    ]).then(() => undefined).catch(console.error),
  );
  backgroundTask(indexEntity(updated, sql));

  return c.json({ entity: updated }, 200);
});

entitiesRouter.openapi(deleteEntityRoute, async (c) => {
  const actor = requireActor(c);
  const entityId = c.req.param("id");
  const sql = createSql();

  // RLS enforces: classification ceiling + admin ACL (owner/admin/is_admin)
  const results = await sql.transaction([
    ...setActorContext(sql, actor),
    sql`DELETE FROM entities WHERE id = ${entityId} RETURNING id`,
  ]);

  if ((results[results.length - 1] as Array<{ id: string }>).length === 0) {
    const exists = await sql.transaction([
      sql`SELECT set_config('app.actor_id', '', true)`,
      sql`SELECT entity_exists(${entityId}) AS e`,
    ]);
    if ((exists[1] as Array<{ e: boolean }>)[0]?.e) {
      throw new ApiError(403, "forbidden", "Forbidden");
    }
    throw new ApiError(404, "not_found", "Entity not found");
  }

  backgroundTask(removeEntity(entityId));

  return new Response(null, { status: 204 });
});

entitiesRouter.openapi(changeLevelRoute, async (c) => {
  const actor = requireActor(c);
  const entityId = c.req.param("id");
  const body = await parseJsonBody<Record<string, unknown>>(c);
  const sql = createSql();
  const now = new Date().toISOString();

  // Validate levels
  if (typeof body.read_level === "number" && body.read_level > actor.maxReadLevel) {
    throw new ApiError(403, "forbidden", "Cannot set read_level above your clearance");
  }
  if (typeof body.write_level === "number" && body.write_level > actor.maxWriteLevel) {
    throw new ApiError(403, "forbidden", "Cannot set write_level above your clearance");
  }
  if (typeof body.read_level === "number" && body.read_level === 0 && !actor.canPublishPublic) {
    throw new ApiError(403, "forbidden", "Cannot set read_level to PUBLIC without can_publish_public");
  }

  // RLS on UPDATE enforces ACL (owner/editor/admin)
  const results = await sql.transaction([
    ...setActorContext(sql, actor),
    sql.query(
      `UPDATE entities
       SET read_level = COALESCE($1, read_level),
           write_level = COALESCE($2, write_level)
       WHERE id = $3
       RETURNING *`,
      [
        typeof body.read_level === "number" ? body.read_level : null,
        typeof body.write_level === "number" ? body.write_level : null,
        entityId,
      ],
    ),
  ]);

  const updated = (results[results.length - 1] as EntityRecord[])[0];
  if (!updated) {
    throw new ApiError(404, "not_found", "Entity not found or access denied");
  }

  backgroundTask(
    sql.transaction([
      ...setActorContext(sql, actor),
      sql.query(
        `INSERT INTO entity_activity (entity_id, actor_id, action, detail, ts)
         VALUES ($1, $2, 'classification_changed', $3::jsonb, $4::timestamptz)`,
        [entityId, actor.id, JSON.stringify({ read_level: updated.read_level, write_level: updated.write_level }), now],
      ),
    ]).then(() => undefined).catch(console.error),
  );
  backgroundTask(indexEntity(updated, sql));

  return c.json({ entity: updated }, 200);
});

entitiesRouter.openapi(getPermissionsRoute, async (c) => {
  const actor = requireActor(c);
  const entityId = c.req.param("id");
  const sql = createSql();

  const results = await sql.transaction([
    ...setActorContext(sql, actor),
    sql`SELECT owner_id FROM entities WHERE id = ${entityId} LIMIT 1`,
    sql`SELECT * FROM entity_permissions WHERE entity_id = ${entityId} ORDER BY granted_at`,
  ]);

  const entity = (results[results.length - 2] as Array<{ owner_id: string }>)[0];
  if (!entity) {
    throw new ApiError(404, "not_found", "Entity not found");
  }

  return c.json({
    owner_id: entity.owner_id,
    permissions: results[results.length - 1],
  }, 200);
});

entitiesRouter.openapi(grantPermissionRoute, async (c) => {
  const actor = requireActor(c);
  const entityId = c.req.param("id");
  const body = await parseJsonBody<Record<string, unknown>>(c);
  const sql = createSql();

  if (!body.grantee_type || !body.grantee_id || !body.role) {
    throw new ApiError(400, "invalid_body", "Missing grantee_type, grantee_id, or role");
  }

  // RLS on entity_permissions INSERT enforces: owner or admin
  const results = await sql.transaction([
    ...setActorContext(sql, actor),
    sql.query(
      `INSERT INTO entity_permissions (entity_id, grantee_type, grantee_id, role, granted_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (entity_id, grantee_type, grantee_id)
       DO UPDATE SET role = EXCLUDED.role, granted_by = EXCLUDED.granted_by, granted_at = NOW()
       RETURNING *`,
      [entityId, body.grantee_type, body.grantee_id, body.role, actor.id],
    ),
  ]);

  const perm = (results[results.length - 1] as Array<Record<string, unknown>>)[0];
  if (!perm) {
    throw new ApiError(403, "forbidden", "Forbidden");
  }

  return c.json({ permission: perm }, 201);
});

entitiesRouter.openapi(revokePermissionRoute, async (c) => {
  const actor = requireActor(c);
  const entityId = c.req.param("id");
  const granteeId = c.req.param("granteeId");
  const sql = createSql();

  // RLS on entity_permissions DELETE enforces: owner or admin
  const results = await sql.transaction([
    ...setActorContext(sql, actor),
    sql`DELETE FROM entity_permissions WHERE entity_id = ${entityId} AND grantee_id = ${granteeId} RETURNING entity_id`,
  ]);

  if ((results[results.length - 1] as Array<Record<string, unknown>>).length === 0) {
    throw new ApiError(404, "not_found", "Permission not found");
  }

  return new Response(null, { status: 204 });
});

entitiesRouter.openapi(transferOwnerRoute, async (c) => {
  const actor = requireActor(c);
  const entityId = c.req.param("id");
  const body = await parseJsonBody<Record<string, unknown>>(c);
  if (typeof body.owner_id !== "string") {
    throw new ApiError(400, "missing_required_field", "Missing owner_id");
  }

  const sql = createSql();
  const now = new Date().toISOString();

  // First verify current ownership (only owner can transfer)
  const results = await sql.transaction([
    ...setActorContext(sql, actor),
    sql`SELECT owner_id FROM entities WHERE id = ${entityId} LIMIT 1`,
  ]);

  const entity = (results[results.length - 1] as Array<{ owner_id: string }>)[0];
  if (!entity) {
    throw new ApiError(404, "not_found", "Entity not found");
  }
  if (entity.owner_id !== actor.id && !actor.isAdmin) {
    throw new ApiError(403, "forbidden", "Only the owner can transfer ownership");
  }

  const updateResults = await sql.transaction([
    ...setActorContext(sql, actor),
    sql`UPDATE entities SET owner_id = ${body.owner_id} WHERE id = ${entityId} RETURNING *`,
    sql.query(
      `INSERT INTO entity_activity (entity_id, actor_id, action, detail, ts)
       VALUES ($1, $2, 'ownership_transferred', $3::jsonb, $4::timestamptz)`,
      [entityId, actor.id, JSON.stringify({ from: actor.id, to: body.owner_id }), now],
    ),
  ]);

  const updated = (updateResults[updateResults.length - 2] as EntityRecord[])[0];
  return c.json({ entity: updated }, 200);
});

entitiesRouter.openapi(listVersionsRoute, async (c) => {
  const actor = c.get("actor");
  const entityId = c.req.param("id");
  const limit = parseLimit(c, { defaultValue: 50, maxValue: 200 });
  const cursor = parseCursorParam(c);
  const sql = createSql();

  // RLS on entity_versions inherits parent entity classification
  const results = await sql.transaction([
    ...setActorContext(sql, actor),
    sql`
      SELECT ver, properties, edited_by, note, created_at
      FROM entity_versions
      WHERE entity_id = ${entityId}
        AND (${cursor?.i ?? null}::int IS NULL OR ver < ${cursor?.i ?? null}::int)
      ORDER BY ver DESC
      LIMIT ${limit + 1}
    `,
  ]);

  const rows = results[results.length - 1] as VersionRow[];
  const versions = rows.slice(0, limit);
  const next = rows.length > limit ? versions[versions.length - 1] : null;

  return c.json({
    versions,
    cursor: next ? encodeCursor({ t: next.created_at, i: next.ver }) : null,
  }, 200);
});

entitiesRouter.openapi(getVersionRoute, async (c) => {
  const actor = c.get("actor");
  const entityId = c.req.param("id");
  const ver = Number.parseInt(c.req.param("ver"), 10);
  if (!Number.isInteger(ver) || ver < 1) {
    throw new ApiError(400, "invalid_path_param", "Invalid version");
  }

  const sql = createSql();
  const results = await sql.transaction([
    ...setActorContext(sql, actor),
    sql`
      SELECT entity_id, ver, properties, edited_by, note, created_at
      FROM entity_versions
      WHERE entity_id = ${entityId} AND ver = ${ver}
      LIMIT 1
    `,
  ]);

  const version = (results[results.length - 1] as VersionRow[])[0];
  if (!version) {
    throw new ApiError(404, "not_found", "Version not found");
  }

  return c.json(version, 200);
});
