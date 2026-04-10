import { createRoute, z } from "@hono/zod-openapi";

import { backgroundTask } from "../lib/background";
import { encodeCursor } from "../lib/cursor";
import { parseProjection, projectEntity } from "../lib/entity-projection";
import {
  assertBodyObject,
  addEntityToSpaceQuery,
  grantEntityPermissionQuery,
  InlinePermissionGrant,
  validatePermissionGrant,
  type EntityRecord,
} from "../lib/entities";
import { requireSpaceRole } from "../lib/spaces";
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
import { fetchRelationshipContext } from "../lib/relationship-context";
import { createRouter } from "../lib/openapi";
import {
  ClassificationLevel,
  ExpandedEntitySchema,
  DateTimeSchema,
  EntityIdParam,
  EntityResponse,
  EntitySchema,
  ProjectionQuery,
  UlidSchema,
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
  .merge(paginationQuerySchema(50, 200))
  .merge(z.object({
    space_id: queryParam("space_id", z.string().optional(), "Scope results to a space ULID"),
  }));

const listEntitiesRoute = createRoute({
  method: "get",
  path: "/",
  operationId: "listEntities",
  tags: ["Entities"],
  summary: "List entities with filtering, sorting, and cursor pagination",
  "x-arke-auth": "optional",
  "x-arke-related": ["GET /search", "GET /entities/{id}"],
  "x-arke-rules": [
    "Results filtered by your classification clearance",
    "If space_id is provided, only entities belonging to that space are returned",
  ],
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
  summary: "Create a new entity, optionally adding it to a space and granting permissions",
  "x-arke-auth": "required",
  "x-arke-related": ["GET /entities/{id}", "PUT /entities/{id}", "POST /spaces/{id}/entities", "POST /entities/{id}/permissions"],
  "x-arke-rules": [
    "Requires write_level clearance >= entity's write_level",
    "Requires read_level clearance >= entity's read_level",
    "If space_id is provided, requires contributor role or above on that space",
    "All operations (create, space add, permission grants) are atomic",
  ],
  request: {
    body: {
      required: true,
      content: jsonContent(
        z.object({
          type: z.string().describe("Entity type"),
          properties: z.record(z.string(), z.any()).describe("Arbitrary properties"),
          read_level: ClassificationLevel.optional(),
          write_level: ClassificationLevel.optional(),
          space_id: EntityIdParam.optional().describe("Space ULID — if provided, the entity is added to this space atomically"),
          permissions: z.array(InlinePermissionGrant).optional().describe("Permission grants to apply to the new entity atomically"),
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
  description:
    "Use view=expanded to include the entity's relationships with counterpart summaries. " +
    "Control the number of relationships with rel_limit (default 20, max 100). " +
    "Check _relationships_truncated to know if more exist; use GET /entities/{id}/relationships for the full paginated set.",
  "x-arke-auth": "optional",
  "x-arke-related": [
    "PUT /entities/{id}",
    "GET /entities/{id}/versions",
  ],
  "x-arke-rules": ["Requires read_level clearance >= entity's read_level", "Returns 404 if entity is not visible to you"],
  request: {
    params: entityIdParams(),
    query: z.object({
      view: queryParam(
        "view",
        z.enum(["summary", "expanded"]).optional(),
        "Projection: summary | expanded. Default returns all fields. expanded adds _relationships.",
      ),
      fields: queryParam("fields", z.string().optional(), "Comma-separated field list"),
      rel_limit: queryParam(
        "rel_limit",
        z.coerce.number().int().min(1).max(100).optional(),
        "Max relationships when view=expanded (default 20, max 100)",
      ),
    }),
  },
  responses: {
    200: {
      description: "Entity details. When view=expanded, includes _relationships and _relationships_truncated.",
      content: jsonContent(z.object({
        entity: z.union([EntitySchema, ExpandedEntitySchema]),
      })),
    },
    304: { description: "Not modified" },
    ...errorResponses([400, 404]),
    410: { description: "Entity was merged into another entity" },
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
  "x-arke-rules": ["Only the owner, an entity editor, or an entity admin may update", "Requires write_level clearance >= entity's write_level", "Optimistic concurrency: must pass current ver to update", "Properties are shallow-merged: only provided keys are updated, omitted keys are preserved"],
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
  "x-arke-rules": ["Only the owner, an entity admin, or a system admin may delete", "Requires write_level clearance >= entity's write_level"],
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
  "x-arke-rules": ["Only the owner, an entity editor, or an entity admin may change levels", "Cannot set read_level above your own max_read_level", "Cannot set write_level above your own max_write_level", "Setting read_level to PUBLIC (0) requires can_publish_public flag"],
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
  "x-arke-rules": ["Requires read_level clearance >= entity's read_level"],
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
  "x-arke-rules": ["Only the entity owner, an entity admin, or a system admin may grant permissions"],
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
  "x-arke-rules": ["Only the entity owner, an entity admin, or a system admin may revoke permissions"],
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
  "x-arke-rules": ["Only the current owner or a system admin may transfer ownership", "Previous owner loses all access unless they have a separate permission grant"],
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
  "x-arke-rules": ["Requires read_level clearance >= entity's read_level"],
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

const mergeEntityRoute = createRoute({
  method: "post",
  path: "/{id}/merge",
  operationId: "mergeEntity",
  tags: ["Entities"],
  summary: "Merge a source entity into this entity",
  "x-arke-auth": "required",
  "x-arke-related": ["GET /entities/{id}", "DELETE /entities/{id}"],
  "x-arke-rules": [
    "Requires admin access on both source and target entities",
    "Both entities must have the same kind (entity or relationship)",
    "If merging relationships, both must connect the same source and target entities",
    "Source entity is deleted after merge; a redirect is created from source ID to target ID",
  ],
  request: {
    params: entityIdParams(),
    body: {
      required: true,
      content: jsonContent(
        z.object({
          source_id: EntityIdParam.describe("Entity ULID to merge FROM (will be deleted)"),
          property_strategy: z.enum(["keep_target", "keep_source", "shallow_merge"]).default("keep_source")
            .describe("How to merge properties: keep_target, keep_source (default), or shallow_merge (source wins conflicts)"),
          ver: z.number().int().describe("Expected current version of the target entity (CAS token)"),
          note: z.string().optional().describe("Optional version note for the merge"),
        }),
      ),
    },
  },
  responses: {
    200: {
      description: "Entity merged successfully",
      content: jsonContent(EntityResponse),
    },
    ...errorResponses([400, 401, 403, 404, 409]),
  },
});

const getVersionRoute = createRoute({
  method: "get",
  path: "/{id}/versions/{ver}",
  operationId: "getEntityVersion",
  tags: ["Entities"],
  summary: "Get a specific version snapshot",
  "x-arke-auth": "optional",
  "x-arke-rules": ["Requires read_level clearance >= entity's read_level"],
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

const bulkGetEntitiesRoute = createRoute({
  method: "post",
  path: "/bulk",
  operationId: "bulkGetEntities",
  tags: ["Entities"],
  summary: "Fetch multiple entities by ID in one request",
  description:
    "Accepts up to 100 entity IDs and returns them in the requested order. " +
    "Entities hidden by RLS are silently omitted. " +
    "Use view=expanded to include relationships with counterpart summaries.",
  "x-arke-auth": "optional",
  "x-arke-related": ["GET /entities/{id}", "GET /search"],
  "x-arke-rules": ["Results filtered by your classification clearance"],
  request: {
    body: {
      required: true,
      content: jsonContent(
        z.object({
          ids: z.array(UlidSchema).min(1).max(100).describe("Entity ULIDs to fetch (max 100)"),
        }),
      ),
    },
    query: z.object({
      view: queryParam(
        "view",
        z.enum(["summary", "expanded"]).optional(),
        "Projection: summary | expanded. Default returns all fields. expanded adds _relationships.",
      ),
      fields: queryParam("fields", z.string().optional(), "Comma-separated field list"),
      rel_limit: queryParam(
        "rel_limit",
        z.coerce.number().int().min(1).max(100).optional(),
        "Max relationships per entity when view=expanded (default 20, max 100)",
      ),
    }),
  },
  responses: {
    200: {
      description: "Entities in requested order (missing/hidden entities omitted). When view=expanded, each entity includes _relationships and _relationships_truncated.",
      content: jsonContent(
        z.object({
          entities: z.array(z.union([EntitySchema, ExpandedEntitySchema])),
        }),
      ),
    },
    ...errorResponses([400]),
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

  const spaceId = c.req.query("space_id");
  const listing = buildEntityListingQuery({ filter, limit, cursor, sort, order, spaceId });

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

  if (typeof body.type !== "string") {
    throw new ApiError(400, "missing_required_field", "Missing type");
  }

  const properties = assertBodyObject(body.properties, "properties");
  const id = generateUlid();
  const now = new Date().toISOString();
  const readLevel = typeof body.read_level === "number" ? body.read_level : 1;
  const writeLevel = typeof body.write_level === "number" ? body.write_level : 1;
  const spaceId = typeof body.space_id === "string" ? body.space_id : null;
  const permissionGrants = Array.isArray(body.permissions)
    ? (body.permissions as Array<Record<string, unknown>>).map((g, i) => validatePermissionGrant(g, i))
    : [];
  const sql = createSql();

  // Pre-validate space access before the transaction
  if (spaceId) {
    await requireSpaceRole(sql, actor, spaceId, "contributor");
  }

  // Build transaction: core entity insert + optional space/permission queries
  const queries = [
    ...setActorContext(sql, actor),
    sql.query(
      `INSERT INTO entities (
        id, kind, type, ver, properties, owner_id,
        read_level, write_level, edited_by, note, created_at, updated_at
      ) VALUES (
        $1, 'entity', $2, 1, $3::jsonb, $4,
        $5, $6, $4, NULL, $7::timestamptz, $7::timestamptz
      ) RETURNING *`,
      [id, body.type, JSON.stringify(properties), actor.id, readLevel, writeLevel, now],
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
  ];

  if (spaceId) {
    queries.push(addEntityToSpaceQuery(sql, spaceId, id, actor.id, now));
  }
  for (const grant of permissionGrants) {
    queries.push(grantEntityPermissionQuery(sql, id, grant.grantee_type, grant.grantee_id, grant.role, actor.id));
  }

  // RLS enforces: actor.max_write_level >= write_level AND actor.max_read_level >= read_level
  const results = await sql.transaction(queries);

  const inserted = (results[1] as EntityRecord[])[0]; // 1 context query + INSERT
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
    sql`SELECT e.*,
      (SELECT COALESCE(array_agg(se.space_id), '{}') FROM space_entities se WHERE se.entity_id = e.id) AS space_ids
      FROM entities e WHERE e.id = ${entityId} LIMIT 1`,
  ]);

  const entity = (results[results.length - 1] as EntityRecord[])[0];
  if (!entity) {
    // Check if entity was merged into another
    const redirectRows = await sql`SELECT new_id, merged_at FROM entity_redirects WHERE old_id = ${entityId} LIMIT 1`;
    const redirect = (redirectRows as Array<{ new_id: string; merged_at: string }>)[0];
    if (redirect) {
      throw new ApiError(410, "entity_merged", "This entity was merged into another entity", {
        merged_into: redirect.new_id,
        merged_at: redirect.merged_at,
      });
    }
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

  if (projection.view === "expanded") {
    const relLimit = Math.min(Number(c.req.query("rel_limit")) || 20, 100);
    const relMap = await fetchRelationshipContext(sql, actor, [entityId], relLimit);
    const ctx = relMap.get(entityId);
    return c.json({
      entity: {
        ...projectEntity(entity, { view: "full", fields: null }),
        _relationships: ctx?.items ?? [],
        _relationships_truncated: ctx?.truncated ?? false,
      },
    }, 200);
  }

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
       SET properties = properties || $1::jsonb,
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
      throw new ApiError(403, "forbidden", "You do not have write access on this entity");
    }
    // Entity not visible — could be 403 or 404
    const exists = await sql.transaction([
      sql`SELECT set_config('app.actor_id', '', true)`,
      sql`SELECT entity_exists(${entityId}) AS e`,
    ]);
    if ((exists[1] as Array<{ e: boolean }>)[0]?.e) {
      throw new ApiError(403, "forbidden", "You do not have access to this entity");
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
      throw new ApiError(403, "forbidden", "You do not have access to this entity");
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

  const grant = validatePermissionGrant(body);

  // RLS on entity_permissions INSERT enforces: owner or admin
  const results = await sql.transaction([
    ...setActorContext(sql, actor),
    grantEntityPermissionQuery(sql, entityId, grant.grantee_type, grant.grantee_id, grant.role, actor.id),
  ]);

  const perm = (results[results.length - 1] as Array<Record<string, unknown>>)[0];
  if (!perm) {
    throw new ApiError(403, "forbidden", "Only the entity owner or an admin can grant permissions");
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

entitiesRouter.openapi(mergeEntityRoute, async (c) => {
  const actor = requireActor(c);
  const targetId = c.req.param("id");
  const body = await parseJsonBody<Record<string, unknown>>(c);

  const sourceId = typeof body.source_id === "string" ? body.source_id : null;
  if (!sourceId) {
    throw new ApiError(400, "missing_required_field", "Missing source_id");
  }
  if (sourceId === targetId) {
    throw new ApiError(400, "invalid_body", "Cannot merge an entity into itself");
  }

  const expectedVer = typeof body.ver === "number" ? body.ver : null;
  if (expectedVer === null) {
    throw new ApiError(400, "missing_required_field", "Missing ver");
  }

  const strategy = typeof body.property_strategy === "string"
    ? body.property_strategy
    : "keep_source";
  if (!["keep_target", "keep_source", "shallow_merge"].includes(strategy)) {
    throw new ApiError(400, "invalid_body", "Invalid property_strategy");
  }

  const note = typeof body.note === "string" ? body.note : null;
  const sql = createSql();
  const now = new Date().toISOString();

  // Single atomic transaction for the entire merge
  const results = await sql.transaction([
    ...setActorContext(sql, actor),

    // Fetch both entities (RLS applies classification check)
    sql.query(
      `SELECT * FROM entities WHERE id = ANY($1)`,
      [[targetId, sourceId]],
    ),

    // Fetch relationship edges if these are relationships (for endpoint validation)
    sql.query(
      `SELECT id, source_id, target_id FROM relationship_edges WHERE id = ANY($1)`,
      [[targetId, sourceId]],
    ),
  ]);

  const ctxLen = 1; // setActorContext produces 1 query
  const lockedRows = results[ctxLen] as EntityRecord[];
  const target = lockedRows.find((r) => r.id === targetId);
  const source = lockedRows.find((r) => r.id === sourceId);

  if (!target) {
    throw new ApiError(404, "not_found", "Target entity not found");
  }
  if (!source) {
    throw new ApiError(404, "not_found", "Source entity not found");
  }

  // Validate same kind
  if (source.kind !== target.kind) {
    throw new ApiError(400, "invalid_body", "Cannot merge entities of different kinds");
  }

  // Validate admin access on both
  const isTargetAdmin = target.owner_id === actor.id || actor.isAdmin;
  const isSourceAdmin = source.owner_id === actor.id || actor.isAdmin;

  if (!isTargetAdmin || !isSourceAdmin) {
    // Check entity_permissions for admin grants (only for the ones not already covered)
    const permChecks = await sql.transaction([
      ...setActorContext(sql, actor),
      ...(!isTargetAdmin ? [sql.query(
        `SELECT 1 FROM entity_permissions WHERE entity_id = $1 AND role = 'admin'
         AND ((grantee_type = 'actor' AND grantee_id = $2)
           OR (grantee_type = 'group' AND EXISTS (
             SELECT 1 FROM group_memberships WHERE group_id = grantee_id AND actor_id = $2)))
         LIMIT 1`,
        [targetId, actor.id],
      )] : []),
      ...(!isSourceAdmin ? [sql.query(
        `SELECT 1 FROM entity_permissions WHERE entity_id = $1 AND role = 'admin'
         AND ((grantee_type = 'actor' AND grantee_id = $2)
           OR (grantee_type = 'group' AND EXISTS (
             SELECT 1 FROM group_memberships WHERE group_id = grantee_id AND actor_id = $2)))
         LIMIT 1`,
        [sourceId, actor.id],
      )] : []),
    ]);

    let idx = ctxLen;
    if (!isTargetAdmin) {
      const targetPerm = (permChecks[idx] as Array<Record<string, unknown>>);
      if (targetPerm.length === 0) {
        throw new ApiError(403, "forbidden", "Requires admin access on both entities");
      }
      idx++;
    }
    if (!isSourceAdmin) {
      const sourcePerm = (permChecks[idx] as Array<Record<string, unknown>>);
      if (sourcePerm.length === 0) {
        throw new ApiError(403, "forbidden", "Requires admin access on both entities");
      }
    }
  }

  // If relationships, validate same endpoints
  if (source.kind === "relationship") {
    const edgeRows = results[ctxLen + 1] as Array<{ id: string; source_id: string; target_id: string }>;
    const targetEdge = edgeRows.find((r) => r.id === targetId);
    const sourceEdge = edgeRows.find((r) => r.id === sourceId);

    if (!targetEdge || !sourceEdge) {
      throw new ApiError(400, "invalid_body", "Relationship edge data not found");
    }
    if (targetEdge.source_id !== sourceEdge.source_id || targetEdge.target_id !== sourceEdge.target_id) {
      throw new ApiError(400, "invalid_body", "Cannot merge relationships with different endpoints");
    }
  }

  // Compute merged properties
  let mergedProperties: Record<string, unknown>;
  switch (strategy) {
    case "keep_target":
      mergedProperties = target.properties;
      break;
    case "keep_source":
      mergedProperties = source.properties;
      break;
    case "shallow_merge":
      mergedProperties = { ...target.properties, ...source.properties };
      break;
    default:
      mergedProperties = source.properties;
  }

  const newVer = target.ver + 1;
  const mergeDetail = JSON.stringify({
    source_id: sourceId,
    source_type: source.type,
    source_ver: source.ver,
    source_properties: source.properties,
    property_strategy: strategy,
  });

  // Execute the merge via SECURITY DEFINER function (bypasses RLS since
  // app layer already verified admin access on both entities)
  const mergeResults = await sql.transaction([
    ...setActorContext(sql, actor),
    sql.query(
      `SELECT * FROM perform_entity_merge($1, $2, $3::jsonb, $4, $5, $6, $7, $8::timestamptz, $9::jsonb)`,
      [sourceId, targetId, JSON.stringify(mergedProperties), newVer, expectedVer, actor.id, note, now, mergeDetail],
    ),
  ]);

  const updated = (mergeResults[ctxLen] as EntityRecord[])[0];
  if (!updated) {
    // CAS guard failed — target was modified between validation and merge
    throw new ApiError(409, "cas_conflict", "Target entity was modified during merge, please retry", {
      entity_id: targetId,
      expected_ver: expectedVer,
    });
  }

  // Background tasks: clean up search index
  backgroundTask(removeEntity(sourceId));
  backgroundTask(indexEntity(updated, sql));

  return c.json({ entity: updated }, 200);
});

entitiesRouter.openapi(bulkGetEntitiesRoute, async (c) => {
  const actor = c.get("actor");
  const body = await parseJsonBody<{ ids: string[] }>(c);

  if (!Array.isArray(body.ids) || body.ids.length === 0) {
    throw new ApiError(400, "invalid_body", "ids must be a non-empty array");
  }
  if (body.ids.length > 100) {
    throw new ApiError(400, "invalid_body", "Maximum 100 IDs per request");
  }

  const projection = parseProjection(c.req.query("view"), c.req.query("fields"));
  const sql = createSql();

  const txResults = await sql.transaction([
    ...setActorContext(sql, actor),
    sql.query(
      `SELECT * FROM entities WHERE id = ANY($1::text[])`,
      [body.ids],
    ),
  ]);

  const rowMap = new Map<string, Record<string, unknown>>();
  for (const row of txResults[txResults.length - 1] as Array<Record<string, unknown>>) {
    rowMap.set(String(row.id), row);
  }

  // Preserve requested order, omit missing/hidden
  const entities = body.ids
    .map((id: string) => rowMap.get(id))
    .filter((row): row is Record<string, unknown> => row !== undefined);

  if (projection.view === "expanded") {
    const relLimit = Math.min(Number(c.req.query("rel_limit")) || 20, 100);
    const visibleIds = entities.map((e) => String(e.id));
    const relMap = await fetchRelationshipContext(sql, actor, visibleIds, relLimit);

    return c.json({
      entities: entities.map((row) => {
        const ctx = relMap.get(String(row.id));
        return {
          ...projectEntity(row, { view: "full", fields: null }),
          _relationships: ctx?.items ?? [],
          _relationships_truncated: ctx?.truncated ?? false,
        };
      }),
    }, 200);
  }

  return c.json({
    entities: entities.map((row) => projectEntity(row, projection)),
  }, 200);
});
