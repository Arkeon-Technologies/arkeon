import { createRoute, z } from "@hono/zod-openapi";

import { encodeCursor } from "../lib/cursor";
import { parseProjection, projectEntity } from "../lib/entity-projection";
import {
  assertBodyObject,
  type EntityRecord,
  validateAccessValue,
} from "../lib/entities";
import { ApiError } from "../lib/errors";
import { requireActor, parseCursorParam, parseJsonBody, parseLimit, parseOptionalTimestamp } from "../lib/http";
import { generateUlid } from "../lib/ids";
import { buildEntityListingQuery, mergeFilters, parseOrder, parseSort } from "../lib/listing";
import { createRouter } from "../lib/openapi";
import {
  ContributeAccessPolicy,
  DateTimeSchema,
  EditAccessPolicy,
  EntityIdParam,
  EntitySchema,
  ProjectionQuery,
  ViewAccessPolicy,
  cursorResponseSchema,
  entityIdParams,
  errorResponses,
  filterQuerySchema,
  jsonContent,
  paginationQuerySchema,
  queryParam,
} from "../lib/schemas";
import { createSql } from "../lib/sql";
import type { AppBindings } from "../types";

type ActivityRow = {
  id: number;
  entity_id: string;
  actor_id: string;
  action: string;
  detail: unknown;
  ts: string;
};

const COMMONS_SORTS = ["updated_at", "created_at", "entity_count", "last_activity_at"];
const ENTITY_SORTS = ["updated_at", "created_at"];

async function loadVisibleCommons(
  env: AppBindings["Bindings"],
  actorId: string,
  commonsId: string,
): Promise<{ commons: EntityRecord | null; exists: boolean }> {
  const sql = createSql(env);
  const [, rows, existsRows, grantRows] = await sql.transaction([
    sql`SELECT set_config('app.actor_id', ${actorId}, true)`,
    sql.query(
      `
        SELECT *
        FROM entities
        WHERE id = $1
          AND kind = 'commons'
        LIMIT 1
      `,
      [commonsId],
    ),
    sql`SELECT entity_exists(${commonsId}) AS exists`,
    actorId
      ? sql.query(
          `
            SELECT 1
            FROM entity_access
            WHERE entity_id = $1
              AND actor_id = $2
            LIMIT 1
          `,
          [commonsId, actorId],
        )
      : sql`SELECT 1 WHERE false`,
  ]);
  const commons = (rows as EntityRecord[])[0] ?? null;
  const canView = Boolean(
    commons &&
    (
      commons.view_access === "public" ||
      commons.owner_id === actorId ||
      (grantRows as Array<{ "?column?": number }>).length > 0
    ),
  );

  return {
    commons: canView ? commons : null,
    exists: Boolean((existsRows as Array<{ exists: boolean }>)[0]?.exists),
  };
}

function requireVisibleCommons(commons: EntityRecord | null, exists: boolean) {
  if (commons) {
    return commons;
  }
  if (exists) {
    throw new ApiError(403, "forbidden", "Forbidden");
  }
  throw new ApiError(404, "not_found", "Commons not found");
}

const CommonsActivitySchema = z.object({
  id: z.number().int(),
  entity_id: EntityIdParam,
  actor_id: EntityIdParam,
  action: z.string(),
  detail: z.any(),
  ts: DateTimeSchema,
});

const listCommonsRoute = createRoute({
  method: "get",
  path: "/",
  operationId: "listCommons",
  tags: ["Commons"],
  summary: "List all commons (collections)",
  "x-arke-auth": "optional",
  "x-arke-related": ["POST /commons", "GET /commons/{id}"],
  request: {
    query: filterQuerySchema(
      ["updated_at", "created_at", "entity_count", "last_activity_at"],
      "updated_at",
    )
      .merge(ProjectionQuery)
      .merge(paginationQuerySchema(50, 200))
      .extend({
        q: queryParam("q", z.string().optional(), "Full-text search query"),
      }),
  },
  responses: {
    200: {
      description: "Commons listing",
      content: jsonContent(cursorResponseSchema("commons", EntitySchema)),
    },
    ...errorResponses([400, 403, 404]),
  },
});

const createCommonsRoute = createRoute({
  method: "post",
  path: "/",
  operationId: "createCommons",
  tags: ["Commons"],
  summary: "Create a new commons (collection)",
  "x-arke-auth": "required",
  "x-arke-related": ["GET /commons/{id}", "GET /commons/{id}/entities"],
  request: {
    body: {
      required: true,
      content: jsonContent(
        z.object({
          properties: z.record(z.string(), z.any()).describe("Commons properties"),
          commons_id: EntityIdParam.optional().describe("Parent commons ULID"),
          type: z.string().optional().describe("Commons type (default: commons)"),
          view_access: ViewAccessPolicy.optional(),
          edit_access: EditAccessPolicy.optional(),
          contribute_access: ContributeAccessPolicy.optional(),
        }),
      ),
    },
  },
  responses: {
    201: {
      description: "Commons created",
      content: jsonContent(z.object({ commons: EntitySchema })),
    },
    ...errorResponses([400, 401, 403, 404]),
  },
});

const getCommonsRoute = createRoute({
  method: "get",
  path: "/{id}",
  operationId: "getCommons",
  tags: ["Commons"],
  summary: "Fetch a single commons by ID",
  "x-arke-auth": "optional",
  "x-arke-related": ["PUT /commons/{id}", "GET /commons/{id}/entities"],
  request: {
    params: entityIdParams("Commons ULID"),
    query: ProjectionQuery,
  },
  responses: {
    200: {
      description: "Commons details",
      content: jsonContent(z.object({ commons: EntitySchema })),
    },
    304: {
      description: "Not modified",
    },
    ...errorResponses([400, 403, 404]),
  },
});

const updateCommonsRoute = createRoute({
  method: "put",
  path: "/{id}",
  operationId: "updateCommons",
  tags: ["Commons"],
  summary: "Update commons properties or move to new parent",
  "x-arke-auth": "required",
  "x-arke-related": ["GET /commons/{id}"],
  request: {
    params: entityIdParams("Commons ULID"),
    body: {
      required: true,
      content: jsonContent(
        z.object({
          ver: z.number().int().describe("Expected current version (CAS token). Server increments ver on success."),
          properties: z.record(z.string(), z.any()).optional().describe("New properties"),
          commons_id: EntityIdParam.optional().describe("Move to new parent commons"),
          tombstone: z.boolean().optional().describe("Soft-delete the commons"),
          note: z.string().optional().describe("Edit note"),
        }),
      ),
    },
  },
  responses: {
    200: {
      description: "Commons updated",
      content: jsonContent(z.object({ commons: EntitySchema })),
    },
    ...errorResponses([400, 401, 403, 404, 409]),
  },
});

const deleteCommonsRoute = createRoute({
  method: "delete",
  path: "/{id}",
  operationId: "deleteCommons",
  tags: ["Commons"],
  summary: "Delete a commons (owner only)",
  "x-arke-auth": "required",
  request: {
    params: entityIdParams("Commons ULID"),
  },
  responses: {
    204: {
      description: "Commons deleted",
    },
    ...errorResponses([401, 403, 404]),
  },
});

const listCommonsEntitiesRoute = createRoute({
  method: "get",
  path: "/{id}/entities",
  operationId: "listCommonsEntities",
  tags: ["Commons"],
  summary: "List entities within a commons",
  "x-arke-auth": "optional",
  "x-arke-related": ["POST /entities", "GET /commons/{id}"],
  request: {
    params: entityIdParams("Commons ULID"),
    query: filterQuerySchema(["updated_at", "created_at"], "updated_at")
      .merge(ProjectionQuery)
      .merge(paginationQuerySchema(50, 200))
      .extend({
        q: queryParam("q", z.string().optional(), "Full-text search"),
      }),
  },
  responses: {
    200: {
      description: "Entities in the commons",
      content: jsonContent(cursorResponseSchema("entities", EntitySchema)),
    },
    ...errorResponses([400, 403, 404]),
  },
});

const listChildCommonsRoute = createRoute({
  method: "get",
  path: "/{id}/commons",
  operationId: "listChildCommons",
  tags: ["Commons"],
  summary: "List child commons within a commons",
  "x-arke-auth": "optional",
  request: {
    params: entityIdParams("Commons ULID"),
    query: filterQuerySchema(["updated_at", "created_at"], "updated_at")
      .merge(ProjectionQuery)
      .merge(paginationQuerySchema(50, 200))
      .extend({
        q: queryParam("q", z.string().optional(), "Full-text search"),
      }),
  },
  responses: {
    200: {
      description: "Child commons",
      content: jsonContent(cursorResponseSchema("commons", EntitySchema)),
    },
    ...errorResponses([400, 403, 404]),
  },
});

const commonsFeedRoute = createRoute({
  method: "get",
  path: "/{id}/feed",
  operationId: "listCommonsFeed",
  tags: ["Commons"],
  summary: "Activity feed scoped to a specific commons",
  "x-arke-auth": "optional",
  "x-arke-related": ["GET /activity"],
  request: {
    params: entityIdParams("Commons ULID"),
    query: paginationQuerySchema(50, 200).extend({
      action: queryParam("action", z.string().optional(), "Filter by action type"),
      since: queryParam("since", DateTimeSchema.optional(), "ISO 8601 — only events after this time"),
    }),
  },
  responses: {
    200: {
      description: "Commons activity feed",
      content: jsonContent(cursorResponseSchema("activity", CommonsActivitySchema)),
    },
    ...errorResponses([400, 403, 404]),
  },
});

export const commonsRouter = createRouter();

commonsRouter.openapi(listCommonsRoute, async (c) => {
  const sql = createSql(c.env);
  const actorId = c.get("actor")?.id ?? "";
  const limit = parseLimit(c, { defaultValue: 50, maxValue: 200 });
  const projection = parseProjection(c.req.query("view"), c.req.query("fields"));
  const cursor = parseCursorParam(c);
  const sort = parseSort(c.req.query("sort"), COMMONS_SORTS, "updated_at");
  const order = parseOrder(c.req.query("order"));
  const listing = buildEntityListingQuery({
    q: c.req.query("q"),
    filter: mergeFilters("kind:commons", c.req.query("filter")),
    limit,
    cursor,
    sort,
    order,
  });

  const [, rows] = await sql.transaction([
    sql`SELECT set_config('app.actor_id', ${actorId}, true)`,
    sql.query(listing.query, listing.params),
  ]);

  const commons = (rows as EntityRecord[]).slice(0, limit);
  const next = (rows as EntityRecord[]).length > limit ? commons[commons.length - 1] : null;

  return c.json({
    commons: commons.map((row) => projectEntity(row, projection)),
    cursor: next ? encodeCursor({ t: (next[sort] ?? next.updated_at) as string | Date, i: next.id }) : null,
  }, 200);
});

commonsRouter.openapi(createCommonsRoute, async (c) => {
  const actor = requireActor(c);
  const body = await parseJsonBody<Record<string, unknown>>(c);
  const properties = assertBodyObject(body.properties, "properties");
  const id = generateUlid();
  const now = new Date().toISOString();
  const commonsId =
    typeof body.commons_id === "string" ? body.commons_id : c.env.ROOT_COMMONS_ID;
  const type = typeof body.type === "string" ? body.type : "commons";
  const viewAccess = validateAccessValue(body.view_access, "view_access") ?? "public";
  const editAccess = validateAccessValue(body.edit_access, "edit_access") ?? "collaborators";
  const contributeAccess =
    validateAccessValue(body.contribute_access, "contribute_access") ?? "public";
  const sql = createSql(c.env);

  const [, insertedRows, versionRows, activityRows, parentRows] = await sql.transaction([
    sql`SELECT set_config('app.actor_id', ${actor.id}, true)`,
    sql.query(
      `
        INSERT INTO entities (
          id, kind, type, ver, properties, owner_id, view_access, edit_access,
          contribute_access, commons_id, edited_by, note, created_at, updated_at
        )
        SELECT $1, 'commons', $2, 1, $3::jsonb, $4, $5, $6, $7, $8, $4, NULL, $9::timestamptz, $9::timestamptz
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
        type,
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
      [id, actor.id, JSON.stringify({ kind: "commons", type }), now],
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

  return c.json({ commons: inserted }, 201);
});

commonsRouter.openapi(getCommonsRoute, async (c) => {
  const actorId = c.get("actor")?.id ?? "";
  const projection = parseProjection(c.req.query("view"), c.req.query("fields"));
  const commonsId = c.req.param("id");
  const { commons, exists } = await loadVisibleCommons(c.env, actorId, commonsId);
  const row = requireVisibleCommons(commons, exists);

  const ifNoneMatch = c.req.header("if-none-match")?.replaceAll("\"", "");
  if (ifNoneMatch && ifNoneMatch === String(row.ver)) {
    return new Response(null, {
      status: 304,
      headers: { ETag: `"${row.ver}"` },
    });
  }

  c.header("etag", `"${row.ver}"`);
  return c.json({ commons: projectEntity(row, projection) }, 200);
});

commonsRouter.openapi(updateCommonsRoute, async (c) => {
  const actor = requireActor(c);
  const commonsId = c.req.param("id");
  const body = await parseJsonBody<Record<string, unknown>>(c);
  const expectedVer = typeof body.ver === "number" ? body.ver : null;
  if (expectedVer === null) {
    throw new ApiError(400, "missing_required_field", "Missing ver");
  }

  const properties =
    body.properties === undefined ? undefined : assertBodyObject(body.properties, "properties");
  const newParentId =
    body.commons_id === undefined ? undefined : typeof body.commons_id === "string" ? body.commons_id : null;
  if (body.commons_id !== undefined && newParentId === null) {
    throw new ApiError(400, "invalid_body", "Invalid commons_id");
  }

  const tombstone = body.tombstone === true;
  const note = body.note === undefined ? null : typeof body.note === "string" ? body.note : null;
  if (!properties && newParentId === undefined && !tombstone) {
    throw new ApiError(400, "invalid_body", "No changes requested");
  }

  const current = requireVisibleCommons(
    ...(await (async () => {
      const loaded = await loadVisibleCommons(c.env, actor.id, commonsId);
      return [loaded.commons, loaded.exists] as const;
    })()),
  );

  if (newParentId && newParentId !== current.commons_id) {
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
        [newParentId],
      ),
      sqlCheck`SELECT entity_exists(${newParentId}) AS exists`,
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
  const contentChanged = tombstone || Boolean(properties);
  const nextVer = contentChanged ? current.ver + 1 : current.ver;
  const now = new Date().toISOString();
  const nextProperties = tombstone ? {} : properties ?? current.properties;
  const nextCommonsId = newParentId ?? current.commons_id;

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
        JSON.stringify(nextProperties),
        nextCommonsId,
        nextVer,
        contentChanged,
        actor.id,
        note,
        now,
        commonsId,
        expectedVer,
      ],
    ),
  ]);

  const updated = (updateRows as EntityRecord[])[0];
  if (!updated) {
    if (current.ver !== expectedVer) {
      throw new ApiError(409, "cas_conflict", "Version mismatch", {
        entity_id: commonsId,
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
        [commonsId],
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
            [commonsId, now],
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
        commonsId,
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
              : { from: current.commons_id, to: nextCommonsId },
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

  return c.json({ commons: updated }, 200);
});

commonsRouter.openapi(deleteCommonsRoute, async (c) => {
  const actor = requireActor(c);
  const commonsId = c.req.param("id");
  const { commons, exists } = await loadVisibleCommons(c.env, actor.id, commonsId);
  const row = requireVisibleCommons(commons, exists);
  if (row.owner_id !== actor.id) {
    throw new ApiError(403, "forbidden", "Forbidden");
  }

  const now = new Date().toISOString();
  const parentCommonsId = row.commons_id;
  const sql = createSql(c.env);
  await sql.transaction([
    sql`SELECT set_config('app.actor_id', ${actor.id}, true)`,
    sql`DELETE FROM entities WHERE id = ${commonsId}`,
    // Log on the parent commons (the deleted entity's own activity cascades away)
    ...(parentCommonsId
      ? [
          sql.query(
            `
              INSERT INTO entity_activity (entity_id, commons_id, actor_id, action, detail, ts)
              VALUES ($1, $2, $3, 'entity_deleted', $4::jsonb, $5::timestamptz)
            `,
            [
              parentCommonsId,
              parentCommonsId,
              actor.id,
              JSON.stringify({
                deleted_id: commonsId,
                kind: "commons",
                type: row.type,
                label: (row.properties as Record<string, unknown>)?.label ?? null,
              }),
              now,
            ],
          ),
        ]
      : []),
  ]);

  return new Response(null, { status: 204 });
});

commonsRouter.openapi(listCommonsEntitiesRoute, async (c) => {
  const actorId = c.get("actor")?.id ?? "";
  const commonsId = c.req.param("id");
  const loaded = await loadVisibleCommons(c.env, actorId, commonsId);
  requireVisibleCommons(loaded.commons, loaded.exists);

  const sql = createSql(c.env);
  const limit = parseLimit(c, { defaultValue: 50, maxValue: 200 });
  const projection = parseProjection(c.req.query("view"), c.req.query("fields"));
  const cursor = parseCursorParam(c);
  const sort = parseSort(c.req.query("sort"), ENTITY_SORTS, "updated_at");
  const order = parseOrder(c.req.query("order"));
  const listing = buildEntityListingQuery({
    q: c.req.query("q"),
    filter: mergeFilters(`kind:entity,commons_id:${commonsId}`, c.req.query("filter")),
    limit,
    cursor,
    sort,
    order,
  });

  const [, rows] = await sql.transaction([
    sql`SELECT set_config('app.actor_id', ${actorId}, true)`,
    sql.query(listing.query, listing.params),
  ]);
  const entities = (rows as EntityRecord[]).slice(0, limit);
  const next = (rows as EntityRecord[]).length > limit ? entities[entities.length - 1] : null;

  return c.json({
    entities: entities.map((row) => projectEntity(row, projection)),
    cursor: next ? encodeCursor({ t: (next[sort] ?? next.updated_at) as string | Date, i: next.id }) : null,
  }, 200);
});

commonsRouter.openapi(listChildCommonsRoute, async (c) => {
  const actorId = c.get("actor")?.id ?? "";
  const commonsId = c.req.param("id");
  const loaded = await loadVisibleCommons(c.env, actorId, commonsId);
  requireVisibleCommons(loaded.commons, loaded.exists);

  const sql = createSql(c.env);
  const limit = parseLimit(c, { defaultValue: 50, maxValue: 200 });
  const projection = parseProjection(c.req.query("view"), c.req.query("fields"));
  const cursor = parseCursorParam(c);
  const sort = parseSort(c.req.query("sort"), ENTITY_SORTS, "updated_at");
  const order = parseOrder(c.req.query("order"));
  const listing = buildEntityListingQuery({
    q: c.req.query("q"),
    filter: mergeFilters(`kind:commons,commons_id:${commonsId}`, c.req.query("filter")),
    limit,
    cursor,
    sort,
    order,
  });

  const [, rows] = await sql.transaction([
    sql`SELECT set_config('app.actor_id', ${actorId}, true)`,
    sql.query(listing.query, listing.params),
  ]);
  const commons = (rows as EntityRecord[]).slice(0, limit);
  const next = (rows as EntityRecord[]).length > limit ? commons[commons.length - 1] : null;

  return c.json({
    commons: commons.map((row) => projectEntity(row, projection)),
    cursor: next ? encodeCursor({ t: (next[sort] ?? next.updated_at) as string | Date, i: next.id }) : null,
  }, 200);
});

commonsRouter.openapi(commonsFeedRoute, async (c) => {
  const sql = createSql(c.env);
  const limit = parseLimit(c, { defaultValue: 50, maxValue: 200 });
  const action = c.req.query("action");
  const since = parseOptionalTimestamp(c.req.query("since"), "since");
  const cursor = parseCursorParam(c);
  const commonsId = c.req.param("id");

  const [, rows] = await sql.transaction([
    sql`SELECT set_config('app.actor_id', '', true)`,
    sql.query(
      `
        SELECT id, entity_id, actor_id, action, detail, ts
        FROM entity_activity
        WHERE commons_id = $1
          AND ($2::text IS NULL OR action = $2)
          AND ($3::timestamptz IS NULL OR ts > $3::timestamptz)
          AND ($4::timestamptz IS NULL OR (ts, id) < ($4::timestamptz, $5::bigint))
        ORDER BY ts DESC, id DESC
        LIMIT $6
      `,
      [commonsId, action ?? null, since, cursor?.t ?? null, cursor?.i ?? null, limit + 1],
    ),
  ]);

  const activity = (rows as ActivityRow[]).slice(0, limit);
  const next = (rows as ActivityRow[]).length > limit ? activity[activity.length - 1] : null;

  return c.json({
    activity,
    cursor: next ? encodeCursor({ t: next.ts as string | Date, i: next.id }) : null,
  }, 200);
});
