import { createRoute, z } from "@hono/zod-openapi";

import { encodeCursor } from "../lib/cursor";
import { parseProjection, projectEntity } from "../lib/entity-projection";
import {
  assertBodyObject,
  type EntityRecord,
  validateAccessValue,
} from "../lib/entities";
import { ApiError } from "../lib/errors";
import {
  requireActor,
  parseCursorParam,
  parseJsonBody,
  parseLimit,
} from "../lib/http";
import { generateUlid } from "../lib/ids";
import { createRouter } from "../lib/openapi";
import {
  ContributeAccessPolicy,
  DateTimeSchema,
  EditAccessPolicy,
  EntityIdParam,
  EntityResponse,
  EntitySchema,
  ViewAccessPolicy,
  cursorResponseSchema,
  entityIdParams,
  errorResponses,
  jsonContent,
  paginationQuerySchema,
  pathParam,
  queryParam,
} from "../lib/schemas";
import { createSql } from "../lib/sql";
import type { AppBindings } from "../types";

type AccessGrantRow = {
  actor_id: string;
  access_type: string;
  granted_at: string;
};

type VersionRow = {
  entity_id?: string;
  ver: number;
  properties?: Record<string, unknown>;
  edited_by: string;
  note: string | null;
  created_at: string;
};

async function loadVisibleEntity(
  env: AppBindings["Bindings"],
  actorId: string,
  entityId: string,
): Promise<{ entity: EntityRecord | null; exists: boolean }> {
  const sql = createSql(env);
  const [, entityRows, existsRows, grantRows] = await sql.transaction([
    sql`SELECT set_config('app.actor_id', ${actorId}, true)`,
    sql.query(
      `
        SELECT *
        FROM entities
        WHERE id = $1
        LIMIT 1
      `,
      [entityId],
    ),
    sql`SELECT entity_exists(${entityId}) AS exists`,
    actorId
      ? sql.query(
          `
            SELECT 1
            FROM entity_access
            WHERE entity_id = $1
              AND actor_id = $2
            LIMIT 1
          `,
          [entityId, actorId],
        )
      : sql`SELECT 1 WHERE false`,
  ]);
  const entity = (entityRows as EntityRecord[])[0] ?? null;
  const canView = Boolean(
    entity &&
    (
      entity.view_access === "public" ||
      entity.owner_id === actorId ||
      (grantRows as Array<{ "?column?": number }>).length > 0
    ),
  );

  return {
    entity: canView ? entity : null,
    exists: Boolean((existsRows as Array<{ exists: boolean }>)[0]?.exists),
  };
}

function requireVisibleEntity(entity: EntityRecord | null, exists: boolean) {
  if (entity) {
    return entity;
  }
  if (exists) {
    throw new ApiError(403, "forbidden", "Forbidden");
  }
  throw new ApiError(404, "not_found", "Entity not found");
}

async function ensureManageAccess(
  env: AppBindings["Bindings"],
  actorId: string,
  entityId: string,
) {
  const sql = createSql(env);
  const [, rows, existsRows] = await sql.transaction([
    sql`SELECT set_config('app.actor_id', ${actorId}, true)`,
    sql.query(
      `
        SELECT e.*
        FROM entities e
        WHERE e.id = $1
          AND (
            e.owner_id = current_actor_id()
            OR EXISTS (
              SELECT 1 FROM entity_access ea
              WHERE ea.entity_id = e.id
                AND ea.actor_id = current_actor_id()
                AND ea.access_type = 'admin'
            )
          )
        LIMIT 1
      `,
      [entityId],
    ),
    sql`SELECT entity_exists(${entityId}) AS exists`,
  ]);

  const entity = (rows as EntityRecord[])[0] ?? null;
  return {
    entity,
    exists: Boolean((existsRows as Array<{ exists: boolean }>)[0]?.exists),
  };
}

const AccessGrantSchema = z.object({
  actor_id: EntityIdParam,
  access_type: z.enum(["view", "edit", "contribute", "admin"]),
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

const createEntityRoute = createRoute({
  method: "post",
  path: "/",
  operationId: "createEntity",
  tags: ["Entities"],
  summary: "Create a new entity within a commons",
  "x-arke-auth": "required",
  "x-arke-related": ["GET /entities/{id}", "PUT /entities/{id}"],
  request: {
    body: {
      required: true,
      content: jsonContent(
        z.object({
          commons_id: EntityIdParam.describe("Parent commons ULID"),
          type: z.string().describe("Entity type"),
          properties: z.record(z.string(), z.any()).describe("Arbitrary properties"),
          view_access: ViewAccessPolicy.optional(),
          edit_access: EditAccessPolicy.optional(),
          contribute_access: ContributeAccessPolicy.optional(),
        }),
      ),
    },
  },
  responses: {
    201: {
      description: "Entity created",
      content: jsonContent(EntityResponse),
    },
    ...errorResponses([400, 401, 403, 404]),
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
    "GET /entities/{id}/content",
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
    304: {
      description: "Not modified",
    },
    ...errorResponses([400, 403, 404]),
  },
});

const updateEntityRoute = createRoute({
  method: "put",
  path: "/{id}",
  operationId: "updateEntity",
  tags: ["Entities"],
  summary: "Update entity properties, move commons, or tombstone",
  "x-arke-auth": "required",
  "x-arke-related": ["GET /entities/{id}", "GET /entities/{id}/versions"],
  request: {
    params: entityIdParams(),
    body: {
      required: true,
      content: jsonContent(
        z.object({
          ver: z.number().int().describe("Expected current version (CAS token). Server increments ver on success."),
          properties: z.record(z.string(), z.any()).optional().describe("New properties"),
          commons_id: EntityIdParam.optional().describe("Move to new parent commons"),
          tombstone: z.boolean().optional().describe("Soft-delete the entity"),
          note: z.string().optional().describe("Edit note"),
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

const getEntityAccessRoute = createRoute({
  method: "get",
  path: "/{id}/access",
  operationId: "getEntityAccess",
  tags: ["Entities"],
  summary: "Get access policies and grants for an entity",
  "x-arke-auth": "optional",
  "x-arke-related": ["PUT /entities/{id}/access", "POST /entities/{id}/access/grants"],
  request: {
    params: entityIdParams(),
  },
  responses: {
    200: {
      description: "Entity access state",
      content: jsonContent(
        z.object({
          owner_id: EntityIdParam,
          view_access: ViewAccessPolicy,
          edit_access: EditAccessPolicy,
          contribute_access: ContributeAccessPolicy,
          grants: z.array(AccessGrantSchema),
        }),
      ),
    },
    ...errorResponses([403, 404]),
  },
});

const updateEntityAccessRoute = createRoute({
  method: "put",
  path: "/{id}/access",
  operationId: "updateEntityAccess",
  tags: ["Entities"],
  summary: "Update access policies (owner or admin only)",
  "x-arke-auth": "required",
  "x-arke-related": ["GET /entities/{id}/access"],
  request: {
    params: entityIdParams(),
    body: {
      required: true,
      content: jsonContent(
        z.object({
          view_access: ViewAccessPolicy.optional(),
          edit_access: EditAccessPolicy.optional(),
          contribute_access: ContributeAccessPolicy.optional(),
        }),
      ),
    },
  },
  responses: {
    200: {
      description: "Updated access policies",
      content: jsonContent(
        z.object({
          owner_id: EntityIdParam,
          view_access: ViewAccessPolicy,
          edit_access: EditAccessPolicy,
          contribute_access: ContributeAccessPolicy,
        }),
      ),
    },
    ...errorResponses([400, 401, 403, 404]),
  },
});

const transferOwnerRoute = createRoute({
  method: "put",
  path: "/{id}/access/owner",
  operationId: "transferEntityOwner",
  tags: ["Entities"],
  summary: "Transfer entity ownership (owner only)",
  "x-arke-auth": "required",
  request: {
    params: entityIdParams(),
    body: {
      required: true,
      content: jsonContent(
        z.object({
          new_owner_id: EntityIdParam.describe("New owner actor ULID"),
        }),
      ),
    },
  },
  responses: {
    200: {
      description: "Ownership transferred",
      content: jsonContent(z.object({ owner_id: EntityIdParam })),
    },
    ...errorResponses([400, 401, 403, 404]),
  },
});

const createGrantRoute = createRoute({
  method: "post",
  path: "/{id}/access/grants",
  operationId: "createEntityAccessGrant",
  tags: ["Entities"],
  summary: "Grant access to an actor (owner or admin only)",
  "x-arke-auth": "required",
  "x-arke-related": ["DELETE /entities/{id}/access/grants/{actorId}"],
  request: {
    params: entityIdParams(),
    body: {
      required: true,
      content: jsonContent(
        z.object({
          actor_id: EntityIdParam.describe("Target actor ULID"),
          access_type: z.enum(["view", "edit", "contribute", "admin"]).describe(
            "view | edit | contribute | admin",
          ),
        }),
      ),
    },
  },
  responses: {
    201: {
      description: "Grant created",
      content: jsonContent(z.object({ grant: AccessGrantSchema.extend({ entity_id: EntityIdParam }) })),
    },
    ...errorResponses([400, 401, 403, 404]),
  },
});

const revokeAllGrantsRoute = createRoute({
  method: "delete",
  path: "/{id}/access/grants/{actorId}",
  operationId: "deleteEntityAccessGrants",
  tags: ["Entities"],
  summary: "Revoke all access for an actor",
  "x-arke-auth": "required",
  "x-arke-related": ["DELETE /entities/{id}/access/grants/{actorId}/{type}"],
  request: {
    params: z.object({
      id: pathParam("id", EntityIdParam, "Entity ULID"),
      actorId: pathParam("actorId", EntityIdParam, "Target actor ULID"),
    }),
  },
  responses: {
    204: {
      description: "All grants revoked",
    },
    ...errorResponses([401, 403, 404]),
  },
});

const revokeSpecificGrantRoute = createRoute({
  method: "delete",
  path: "/{id}/access/grants/{actorId}/{type}",
  operationId: "deleteEntityAccessGrant",
  tags: ["Entities"],
  summary: "Revoke a specific access type for an actor",
  "x-arke-auth": "required",
  request: {
    params: z.object({
      id: pathParam("id", EntityIdParam, "Entity ULID"),
      actorId: pathParam("actorId", EntityIdParam, "Target actor ULID"),
      type: pathParam(
        "type",
        z.enum(["view", "edit", "contribute", "admin"]),
        "view | edit | contribute | admin",
      ),
    }),
  },
  responses: {
    204: {
      description: "Grant revoked",
    },
    ...errorResponses([400, 401, 403, 404]),
  },
});

const listVersionsRoute = createRoute({
  method: "get",
  path: "/{id}/versions",
  operationId: "listEntityVersions",
  tags: ["Entities"],
  summary: "List version history for an entity",
  "x-arke-auth": "optional",
  "x-arke-related": ["GET /entities/{id}/versions/{ver}"],
  request: {
    params: entityIdParams(),
    query: paginationQuerySchema(50, 200),
  },
  responses: {
    200: {
      description: "Entity version history",
      content: jsonContent(cursorResponseSchema("versions", VersionSchema)),
    },
    ...errorResponses([400, 403, 404]),
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
      ver: pathParam("ver", z.coerce.number().int().min(1), "Version number (integer >= 1)"),
    }),
  },
  responses: {
    200: {
      description: "Entity version snapshot",
      content: jsonContent(VersionSchema.extend({ entity_id: EntityIdParam })),
    },
    ...errorResponses([400, 403, 404]),
  },
});

export const entitiesRouter = createRouter();

entitiesRouter.openapi(createEntityRoute, async (c) => {
  const actor = requireActor(c);
  const body = await parseJsonBody<Record<string, unknown>>(c);
  const commonsId =
    typeof body.commons_id === "string" ? body.commons_id : null;
  if (!commonsId) {
    throw new ApiError(400, "missing_required_field", "Missing commons_id");
  }

  if (typeof body.type !== "string") {
    throw new ApiError(400, "missing_required_field", "Missing type");
  }

  const properties = assertBodyObject(body.properties, "properties");
  const id = generateUlid();
  const now = new Date().toISOString();
  const sql = createSql(c.env);
  const viewAccess = validateAccessValue(body.view_access, "view_access") ?? "public";
  const editAccess = validateAccessValue(body.edit_access, "edit_access") ?? "collaborators";
  const contributeAccess =
    validateAccessValue(body.contribute_access, "contribute_access") ?? "public";

  const [, insertedRows, versionRows, activityRows, parentRows] = await sql.transaction([
    sql`SELECT set_config('app.actor_id', ${actor.id}, true)`,
    sql.query(
      `
        INSERT INTO entities (
          id, kind, type, ver, properties, owner_id, view_access, edit_access,
          contribute_access, commons_id, edited_by, note, created_at, updated_at
        )
        SELECT $1, 'entity', $2, 1, $3::jsonb, $4, $5, $6, $7, $8, $4, NULL, $9::timestamptz, $9::timestamptz
        FROM entities parent
        WHERE parent.id = $8
          AND (
            parent.owner_id = current_actor_id()
            OR parent.contribute_access = 'public'
            OR (
              parent.contribute_access = 'contributors'
              AND EXISTS (
                SELECT 1 FROM entity_access
                WHERE entity_id = parent.id
                  AND actor_id = current_actor_id()
                  AND access_type IN ('contribute', 'admin')
              )
            )
          )
        RETURNING *
      `,
      [
        id,
        body.type,
        JSON.stringify(properties),
        actor.id,
        viewAccess,
        editAccess,
        contributeAccess,
        commonsId,
        now,
      ],
    ),
    sql.query(
      `
        INSERT INTO entity_versions (entity_id, ver, properties, edited_by, note, created_at)
        SELECT id, ver, properties, edited_by, note, created_at
        FROM entities
        WHERE id = $1
        RETURNING entity_id
      `,
      [id],
    ),
    sql.query(
      `
        INSERT INTO entity_activity (entity_id, commons_id, actor_id, action, detail, ts)
        SELECT id, commons_id, $2, 'entity_created', $3::jsonb, $4::timestamptz
        FROM entities
        WHERE id = $1
        RETURNING id
      `,
      [id, actor.id, JSON.stringify({ kind: "entity", type: body.type }), now],
    ),
    sql`SELECT entity_exists(${commonsId}) AS exists`,
  ]);

  const inserted = (insertedRows as EntityRecord[])[0];
  if (!inserted) {
    const parentExists = Boolean((parentRows as Array<{ exists: boolean }>)[0]?.exists);
    if (parentExists) {
      throw new ApiError(403, "forbidden", "Forbidden");
    }
    throw new ApiError(404, "not_found", "Parent commons not found");
  }

  void versionRows;
  void activityRows;

  return c.json({ entity: inserted }, 201);
});

entitiesRouter.openapi(getEntityRoute, async (c) => {
  const actorId = c.get("actor")?.id ?? "";
  const projection = parseProjection(c.req.query("view"), c.req.query("fields"));
  const entityId = c.req.param("id");
  const loaded = await loadVisibleEntity(c.env, actorId, entityId);
  const entity = requireVisibleEntity(loaded.entity, loaded.exists);

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

  const properties =
    body.properties === undefined ? undefined : assertBodyObject(body.properties, "properties");
  const nextCommonsId =
    body.commons_id === undefined ? undefined : typeof body.commons_id === "string" ? body.commons_id : null;
  if (body.commons_id !== undefined && nextCommonsId === null) {
    throw new ApiError(400, "invalid_body", "Invalid commons_id");
  }

  const tombstone = body.tombstone === true;
  const note = body.note === undefined ? null : typeof body.note === "string" ? body.note : null;
  if (!properties && nextCommonsId === undefined && !tombstone) {
    throw new ApiError(400, "invalid_body", "No changes requested");
  }

  const loaded = await loadVisibleEntity(c.env, actor.id, entityId);
  const current = requireVisibleEntity(loaded.entity, loaded.exists);

  if (nextCommonsId && nextCommonsId !== current.commons_id) {
    const sqlCheck = createSql(c.env);
    const [, rows, existsRows] = await sqlCheck.transaction([
      sqlCheck`SELECT set_config('app.actor_id', ${actor.id}, true)`,
      sqlCheck.query(
        `
          SELECT id
          FROM entities parent
          WHERE parent.id = $1
            AND (
              parent.owner_id = current_actor_id()
              OR parent.contribute_access = 'public'
              OR (
                parent.contribute_access = 'contributors'
                AND EXISTS (
                  SELECT 1 FROM entity_access
                  WHERE entity_id = parent.id
                    AND actor_id = current_actor_id()
                    AND access_type IN ('contribute', 'admin')
                )
              )
            )
        `,
        [nextCommonsId],
      ),
      sqlCheck`SELECT entity_exists(${nextCommonsId}) AS exists`,
    ]);
    if ((rows as Array<{ id: string }>).length === 0) {
      const exists = Boolean((existsRows as Array<{ exists: boolean }>)[0]?.exists);
      if (exists) {
        throw new ApiError(403, "forbidden", "Forbidden");
      }
      throw new ApiError(404, "not_found", "Parent commons not found");
    }
  }

  const sql = createSql(c.env);
  const now = new Date().toISOString();
  const updateProperties = tombstone ? {} : properties ?? current.properties;
  const contentChanged = tombstone || Boolean(properties);
  const nextVer = contentChanged ? current.ver + 1 : current.ver;
  const targetCommonsId = nextCommonsId ?? current.commons_id;

  const [, updateRows] = await sql.transaction([
    sql`SELECT set_config('app.actor_id', ${actor.id}, true)`,
    sql.query(
      `
        UPDATE entities
        SET properties = $1::jsonb,
            commons_id = $2,
            ver = $3,
            edited_by = CASE WHEN $4::boolean THEN $5 ELSE edited_by END,
            note = CASE WHEN $4::boolean THEN $6 ELSE note END,
            updated_at = CASE WHEN $4::boolean THEN $7::timestamptz ELSE updated_at END
        WHERE id = $8
          AND ver = $9
        RETURNING *
      `,
      [
        JSON.stringify(updateProperties),
        targetCommonsId,
        nextVer,
        contentChanged,
        actor.id,
        note,
        now,
        entityId,
        expectedVer,
      ],
    ),
  ]);

  const updated = (updateRows as EntityRecord[])[0];
  if (!updated) {
    if (current.ver !== expectedVer) {
      throw new ApiError(409, "cas_conflict", "Version mismatch", {
        entity_id: entityId,
        expected_ver: expectedVer,
      });
    }
    throw new ApiError(403, "forbidden", "Forbidden");
  }

  // If tombstoning, snapshot outbound relationships before deleting them
  let relationshipsRemoved: Array<Record<string, unknown>> = [];
  if (tombstone) {
    const [, relRows] = await sql.transaction([
      sql`SELECT set_config('app.actor_id', ${actor.id}, true)`,
      sql.query(
        `
          SELECT rel.id, re.predicate, re.source_id, re.target_id, rel.properties
          FROM relationship_edges re
          JOIN entities rel ON rel.id = re.id
          WHERE re.source_id = $1
        `,
        [entityId],
      ),
    ]);
    relationshipsRemoved = relRows as Array<Record<string, unknown>>;
  }

  await sql.transaction([
    sql`SELECT set_config('app.actor_id', ${actor.id}, true)`,
    ...(contentChanged
      ? [
          sql.query(
            `
              INSERT INTO entity_versions (entity_id, ver, properties, edited_by, note, created_at)
              SELECT id, ver, properties, edited_by, note, $2::timestamptz
              FROM entities
              WHERE id = $1
            `,
            [entityId, now],
          ),
        ]
      : []),
    sql.query(
      `
        INSERT INTO entity_activity (entity_id, commons_id, actor_id, action, detail, ts)
        SELECT id, commons_id, $2, $3, $4::jsonb, $5::timestamptz
        FROM entities
        WHERE id = $1
      `,
      [
        entityId,
        actor.id,
        tombstone
          ? "entity_tombstoned"
          : contentChanged
            ? "content_updated"
            : "commons_changed",
        JSON.stringify(
          tombstone
            ? {
                ver: nextVer,
                relationships_removed: relationshipsRemoved.map((r) => ({
                  id: r.id,
                  predicate: r.predicate,
                  target_id: r.target_id,
                  properties: r.properties,
                })),
              }
            : contentChanged
              ? { ver: nextVer, note }
              : { from: current.commons_id, to: targetCommonsId },
        ),
        now,
      ],
    ),
    // Hard-delete outbound relationship entities (CASCADE removes edges, versions, activity)
    ...(tombstone && relationshipsRemoved.length > 0
      ? [
          sql.query(
            `DELETE FROM entities WHERE id = ANY($1::text[])`,
            [relationshipsRemoved.map((r) => r.id)],
          ),
        ]
      : []),
  ]);

  return c.json({ entity: updated }, 200);
});

entitiesRouter.openapi(getEntityAccessRoute, async (c) => {
  const actorId = c.get("actor")?.id ?? "";
  const entityId = c.req.param("id");
  const loaded = await loadVisibleEntity(c.env, actorId, entityId);
  requireVisibleEntity(loaded.entity, loaded.exists);
  const sql = createSql(c.env);

  const [, entityRows, grantsRows] = await sql.transaction([
    sql`SELECT set_config('app.actor_id', ${actorId}, true)`,
    sql`
      SELECT owner_id, view_access, edit_access, contribute_access
      FROM entities
      WHERE id = ${entityId}
      LIMIT 1
    `,
    sql`
      SELECT actor_id, access_type, granted_at
      FROM entity_access
      WHERE entity_id = ${entityId}
      ORDER BY granted_at ASC
    `,
  ]);
  const entity = (entityRows as Array<Record<string, unknown>>)[0];

  return c.json({
    ...entity,
    grants: grantsRows as AccessGrantRow[],
  }, 200);
});

entitiesRouter.openapi(updateEntityAccessRoute, async (c) => {
  const actor = requireActor(c);
  const entityId = c.req.param("id");
  const body = await parseJsonBody<Record<string, unknown>>(c);
  const manage = await ensureManageAccess(c.env, actor.id, entityId);
  const entity = requireVisibleEntity(manage.entity, manage.exists);

  const viewAccess = validateAccessValue(body.view_access, "view_access");
  const editAccess = validateAccessValue(body.edit_access, "edit_access");
  const contributeAccess = validateAccessValue(body.contribute_access, "contribute_access");

  if (!viewAccess && !editAccess && !contributeAccess) {
    throw new ApiError(400, "invalid_body", "No policy changes requested");
  }

  const sql = createSql(c.env);
  const now = new Date().toISOString();
  const [, rows] = await sql.transaction([
    sql`SELECT set_config('app.actor_id', ${actor.id}, true)`,
    sql.query(
      `
        UPDATE entities
        SET view_access = $1,
            edit_access = $2,
            contribute_access = $3
        WHERE id = $4
        RETURNING owner_id, view_access, edit_access, contribute_access
      `,
      [
        viewAccess ?? entity.view_access,
        editAccess ?? entity.edit_access,
        contributeAccess ?? entity.contribute_access,
        entityId,
      ],
    ),
    sql.query(
      `
        INSERT INTO entity_activity (entity_id, commons_id, actor_id, action, detail, ts)
        SELECT id, commons_id, $2, 'policy_updated', $3::jsonb, $4::timestamptz
        FROM entities
        WHERE id = $1
      `,
      [
        entityId,
        actor.id,
        JSON.stringify({
          view_access: viewAccess ?? entity.view_access,
          edit_access: editAccess ?? entity.edit_access,
          contribute_access: contributeAccess ?? entity.contribute_access,
        }),
        now,
      ],
    ),
  ]);

  return c.json(rows[0], 200);
});

entitiesRouter.openapi(transferOwnerRoute, async (c) => {
  const actor = requireActor(c);
  const entityId = c.req.param("id");
  const body = await parseJsonBody<Record<string, unknown>>(c);
  if (typeof body.new_owner_id !== "string") {
    throw new ApiError(400, "missing_required_field", "Missing new_owner_id");
  }

  const loaded = await loadVisibleEntity(c.env, actor.id, entityId);
  const entity = requireVisibleEntity(loaded.entity, loaded.exists);
  if (entity.owner_id !== actor.id) {
    throw new ApiError(403, "forbidden", "Forbidden");
  }

  const sql = createSql(c.env);
  const now = new Date().toISOString();
  await sql.transaction([
    sql`SELECT set_config('app.actor_id', ${actor.id}, true)`,
    sql`UPDATE entities SET owner_id = ${body.new_owner_id} WHERE id = ${entityId}`,
    sql`
      INSERT INTO entity_access (entity_id, actor_id, access_type)
      VALUES (${entityId}, ${actor.id}, 'admin')
      ON CONFLICT DO NOTHING
    `,
    sql.query(
      `
        INSERT INTO entity_activity (entity_id, commons_id, actor_id, action, detail, ts)
        SELECT id, commons_id, $2, 'ownership_transferred', $3::jsonb, $4::timestamptz
        FROM entities
        WHERE id = $1
      `,
      [entityId, actor.id, JSON.stringify({ from: actor.id, to: body.new_owner_id }), now],
    ),
  ]);

  return c.json({ owner_id: body.new_owner_id }, 200);
});

entitiesRouter.openapi(createGrantRoute, async (c) => {
  const actor = requireActor(c);
  const entityId = c.req.param("id");
  const body = await parseJsonBody<Record<string, unknown>>(c);
  if (typeof body.actor_id !== "string" || typeof body.access_type !== "string") {
    throw new ApiError(400, "invalid_body", "Invalid grant body");
  }
  if (!["view", "edit", "contribute", "admin"].includes(body.access_type)) {
    throw new ApiError(400, "invalid_body", "Invalid access_type");
  }

  const manage = await ensureManageAccess(c.env, actor.id, entityId);
  requireVisibleEntity(manage.entity, manage.exists);

  const sql = createSql(c.env);
  const now = new Date().toISOString();
  const [, rows] = await sql.transaction([
    sql`SELECT set_config('app.actor_id', ${actor.id}, true)`,
    sql.query(
      `
        INSERT INTO entity_access (entity_id, actor_id, access_type)
        VALUES ($1, $2, $3)
        ON CONFLICT (entity_id, actor_id, access_type)
        DO UPDATE SET granted_at = entity_access.granted_at
        RETURNING entity_id, actor_id, access_type, granted_at
      `,
      [entityId, body.actor_id, body.access_type],
    ),
    sql.query(
      `
        INSERT INTO entity_activity (entity_id, commons_id, actor_id, action, detail, ts)
        SELECT id, commons_id, $2, 'access_granted', $3::jsonb, $4::timestamptz
        FROM entities
        WHERE id = $1
      `,
      [
        entityId,
        actor.id,
        JSON.stringify({ target_actor_id: body.actor_id, access_type: body.access_type }),
        now,
      ],
    ),
  ]);

  return c.json({ grant: rows[0] }, 201);
});

entitiesRouter.openapi(revokeAllGrantsRoute, async (c) => {
  const actor = requireActor(c);
  const entityId = c.req.param("id");
  const targetActorId = c.req.param("actorId");
  const manage = await ensureManageAccess(c.env, actor.id, entityId);
  const entity = requireVisibleEntity(manage.entity, manage.exists);

  const sql = createSql(c.env);
  const adminRows = await sql.transaction([
    sql`SELECT set_config('app.actor_id', ${actor.id}, true)`,
    sql`
      SELECT access_type
      FROM entity_access
      WHERE entity_id = ${entityId}
        AND actor_id = ${targetActorId}
    `,
  ]);
  const targetHasAdmin = (adminRows[1] as Array<{ access_type: string }>).some(
    (row) => row.access_type === "admin",
  );
  if (targetHasAdmin && entity.owner_id !== actor.id) {
    throw new ApiError(403, "forbidden", "Only the owner can revoke admin access");
  }

  const now = new Date().toISOString();
  await sql.transaction([
    sql`SELECT set_config('app.actor_id', ${actor.id}, true)`,
    sql`DELETE FROM entity_access WHERE entity_id = ${entityId} AND actor_id = ${targetActorId}`,
    sql.query(
      `
        INSERT INTO entity_activity (entity_id, commons_id, actor_id, action, detail, ts)
        SELECT id, commons_id, $2, 'access_revoked', $3::jsonb, $4::timestamptz
        FROM entities
        WHERE id = $1
      `,
      [
        entityId,
        actor.id,
        JSON.stringify({ target_actor_id: targetActorId }),
        now,
      ],
    ),
  ]);

  return new Response(null, { status: 204 });
});

entitiesRouter.openapi(revokeSpecificGrantRoute, async (c) => {
  const actor = requireActor(c);
  const entityId = c.req.param("id");
  const targetActorId = c.req.param("actorId");
  const accessType = c.req.param("type");
  if (!["view", "edit", "contribute", "admin"].includes(accessType)) {
    throw new ApiError(400, "invalid_path_param", "Invalid access type");
  }

  const manage = await ensureManageAccess(c.env, actor.id, entityId);
  const entity = requireVisibleEntity(manage.entity, manage.exists);
  if (accessType === "admin" && entity.owner_id !== actor.id) {
    throw new ApiError(403, "forbidden", "Only the owner can revoke admin access");
  }

  const sql = createSql(c.env);
  const now = new Date().toISOString();
  await sql.transaction([
    sql`SELECT set_config('app.actor_id', ${actor.id}, true)`,
    sql`
      DELETE FROM entity_access
      WHERE entity_id = ${entityId}
        AND actor_id = ${targetActorId}
        AND access_type = ${accessType}
    `,
    sql.query(
      `
        INSERT INTO entity_activity (entity_id, commons_id, actor_id, action, detail, ts)
        SELECT id, commons_id, $2, 'access_revoked', $3::jsonb, $4::timestamptz
        FROM entities
        WHERE id = $1
      `,
      [
        entityId,
        actor.id,
        JSON.stringify({ target_actor_id: targetActorId, access_type: accessType }),
        now,
      ],
    ),
  ]);

  return new Response(null, { status: 204 });
});

entitiesRouter.openapi(listVersionsRoute, async (c) => {
  const sql = createSql(c.env);
  const actorId = c.get("actor")?.id ?? "";
  const entityId = c.req.param("id");
  const loaded = await loadVisibleEntity(c.env, actorId, entityId);
  requireVisibleEntity(loaded.entity, loaded.exists);
  const limit = parseLimit(c, { defaultValue: 50, maxValue: 200 });
  const cursor = parseCursorParam(c);

  const [, rows] = await sql.transaction([
    sql`SELECT set_config('app.actor_id', ${actorId}, true)`,
    sql`
      SELECT ver, edited_by, note, created_at
      FROM entity_versions
      WHERE entity_id = ${entityId}
        AND (
          ${cursor?.i ?? null}::int IS NULL
          OR ver < ${cursor?.i ?? null}::int
        )
      ORDER BY ver DESC
      LIMIT ${limit + 1}
    `,
  ]);

  const versions = (rows as VersionRow[]).slice(0, limit);
  const next = (rows as VersionRow[]).length > limit ? versions[versions.length - 1] : null;

  return c.json({
    versions,
    cursor: next ? encodeCursor({ t: next.created_at, i: next.ver }) : null,
  }, 200);
});

entitiesRouter.openapi(getVersionRoute, async (c) => {
  const sql = createSql(c.env);
  const actorId = c.get("actor")?.id ?? "";
  const entityId = c.req.param("id");
  const loaded = await loadVisibleEntity(c.env, actorId, entityId);
  requireVisibleEntity(loaded.entity, loaded.exists);
  const ver = Number.parseInt(c.req.param("ver"), 10);
  if (!Number.isInteger(ver) || ver < 1) {
    throw new ApiError(400, "invalid_path_param", "Invalid version");
  }

  const [, rows] = await sql.transaction([
    sql`SELECT set_config('app.actor_id', ${actorId}, true)`,
    sql`
      SELECT entity_id, ver, properties, edited_by, note, created_at
      FROM entity_versions
      WHERE entity_id = ${entityId} AND ver = ${ver}
      LIMIT 1
    `,
  ]);

  const version = (rows as VersionRow[])[0];
  if (!version) {
    throw new ApiError(404, "not_found", "Version not found");
  }

  return c.json(version, 200);
});
