import { createRoute, z } from "@hono/zod-openapi";
import { AwsClient } from "aws4fetch";

import { computeCidFromBytes, isValidCid, MAX_FILE_SIZE } from "../lib/cid";
import { ApiError } from "../lib/errors";
import { requireActor, parseJsonBody } from "../lib/http";
import { fanOutNotifications } from "../lib/notifications";
import { createRouter } from "../lib/openapi";
import {
  DateTimeSchema,
  EntityIdParam,
  errorResponses,
  jsonContent,
  pathParam,
  queryParam,
} from "../lib/schemas";
import { createSql } from "../lib/sql";
import type { AppBindings } from "../types";

type ContentEntry = {
  cid: string;
  size: number;
  content_type: string;
  filename?: string;
  uploaded_at: string;
};

type EntityRow = {
  id: string;
  ver: number;
  kind: string;
  type: string;
  owner_id: string;
  view_access: string;
  commons_id: string | null;
  properties: Record<string, unknown>;
};

function getContentMap(properties: Record<string, unknown>): Record<string, ContentEntry> {
  const content = properties.content;
  if (!content || typeof content !== "object" || Array.isArray(content)) {
    return {};
  }
  return content as Record<string, ContentEntry>;
}

function isValidContentKey(key: string): boolean {
  return /^[A-Za-z0-9._-]{1,128}$/.test(key);
}

function getPresignConfig(env: AppBindings["Bindings"]) {
  const accountId = env.R2_ACCOUNT_ID;
  const bucketName = env.R2_BUCKET_NAME;
  const accessKeyId = env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY;

  if (!accountId || !bucketName || !accessKeyId || !secretAccessKey) {
    throw new ApiError(501, "not_implemented", "Presigned uploads require R2 S3 signing credentials");
  }

  return { accountId, bucketName, accessKeyId, secretAccessKey };
}

async function createPresignedUploadUrl(
  env: AppBindings["Bindings"],
  entityId: string,
  cid: string,
  contentType: string,
  expiresInSeconds = 900,
) {
  const { accountId, bucketName, accessKeyId, secretAccessKey } = getPresignConfig(env);
  const client = new AwsClient({ accessKeyId, secretAccessKey });
  const r2Key = `${entityId}/${cid}`;
  const url = new URL(`https://${accountId}.r2.cloudflarestorage.com/${bucketName}/${r2Key}`);
  url.searchParams.set("X-Amz-Expires", String(expiresInSeconds));

  const signedRequest = await client.sign(url.toString(), {
    method: "PUT",
    headers: { "Content-Type": contentType },
    aws: { signQuery: true },
  });

  return {
    upload_url: signedRequest.url,
    r2_key: r2Key,
    expires_at: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
  };
}

async function loadVisibleEntity(
  env: AppBindings["Bindings"],
  actorId: string,
  entityId: string,
): Promise<{ entity: EntityRow | null; exists: boolean }> {
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
  const entity = (entityRows as EntityRow[])[0] ?? null;
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

function requireVisibleEntity(entity: EntityRow | null, exists: boolean) {
  if (entity) {
    return entity;
  }
  if (exists) {
    throw new ApiError(403, "forbidden", "Forbidden");
  }
  throw new ApiError(404, "not_found", "Entity not found");
}

async function ensureEditAccess(
  env: AppBindings["Bindings"],
  actorId: string,
  entityId: string,
): Promise<{ entity: EntityRow | null; exists: boolean }> {
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
            OR e.edit_access = 'public'
            OR (
              e.edit_access = 'collaborators'
              AND EXISTS (
                SELECT 1 FROM entity_access ea
                WHERE ea.entity_id = e.id
                  AND ea.actor_id = current_actor_id()
                  AND ea.access_type IN ('edit', 'admin')
              )
            )
          )
        LIMIT 1
      `,
      [entityId],
    ),
    sql`SELECT entity_exists(${entityId}) AS exists`,
  ]);

  return {
    entity: (rows as EntityRow[])[0] ?? null,
    exists: Boolean((existsRows as Array<{ exists: boolean }>)[0]?.exists),
  };
}

async function updateContentMetadata(options: {
  env: AppBindings["Bindings"];
  actorId: string;
  entity: EntityRow;
  expectedVer: number;
  properties: Record<string, unknown>;
  action: string;
  detail: Record<string, unknown>;
  note?: string | null;
}) {
  const sql = createSql(options.env);
  const now = new Date().toISOString();
  const [, updateRows] = await sql.transaction([
    sql`SELECT set_config('app.actor_id', ${options.actorId}, true)`,
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
      [
        JSON.stringify(options.properties),
        options.actorId,
        options.note ?? null,
        now,
        options.entity.id,
        options.expectedVer,
      ],
    ),
  ]);

  const updated = (updateRows as EntityRow[])[0];
  if (!updated) {
    throw new ApiError(409, "cas_conflict", "Version mismatch", {
      entity_id: options.entity.id,
      expected_ver: options.expectedVer,
    });
  }
  const nextVer = updated.ver;

  await sql.transaction([
    sql`SELECT set_config('app.actor_id', ${options.actorId}, true)`,
    sql.query(
      `
        INSERT INTO entity_versions (entity_id, ver, properties, edited_by, note, created_at)
        SELECT id, ver, properties, edited_by, note, $2::timestamptz
        FROM entities
        WHERE id = $1
      `,
      [options.entity.id, now],
    ),
    sql.query(
      `
        INSERT INTO entity_activity (entity_id, commons_id, actor_id, action, detail, ts)
        SELECT id, commons_id, $2, $3, $4::jsonb, $5::timestamptz
        FROM entities
        WHERE id = $1
      `,
      [
        options.entity.id,
        options.actorId,
        options.action,
        JSON.stringify({ ...options.detail, ver: nextVer }),
        now,
      ],
    ),
  ]);

  return { updated, nextVer, ts: now };
}

const uploadContentRoute = createRoute({
  method: "post",
  path: "/{id}/content",
  operationId: "uploadEntityContent",
  tags: ["Content"],
  summary: "Upload a file directly to an entity",
  "x-arke-auth": "required",
  "x-arke-related": ["GET /entities/{id}/content", "POST /entities/{id}/content/upload-url"],
  request: {
    params: z.object({
      id: pathParam("id", EntityIdParam, "Entity ULID"),
    }),
    query: z.object({
      key: queryParam(
        "key",
        z.string().min(1).max(128),
        "Content key (alphanumeric, max 128 chars)",
      ),
      ver: queryParam("ver", z.coerce.number().int(), "Expected current version (CAS token). Server increments ver on success."),
      filename: queryParam("filename", z.string().min(1).max(255).optional(), "Optional display filename"),
    }),
  },
  responses: {
    200: {
      description: "Content uploaded",
      content: jsonContent(
        z.object({
          cid: z.string(),
          size: z.number().int(),
          key: z.string(),
          ver: z.number().int(),
        }),
      ),
    },
    ...errorResponses([400, 401, 403, 404, 409, 413]),
  },
});

const uploadUrlRoute = createRoute({
  method: "post",
  path: "/{id}/content/upload-url",
  operationId: "createContentUploadUrl",
  tags: ["Content"],
  summary: "Get a presigned S3 URL for large file upload",
  "x-arke-auth": "required",
  "x-arke-related": ["POST /entities/{id}/content/complete"],
  request: {
    params: z.object({
      id: pathParam("id", EntityIdParam, "Entity ULID"),
    }),
    body: {
      required: true,
      content: jsonContent(
        z.object({
          cid: z.string().describe("BLAKE3 content hash (compute client-side)"),
          content_type: z.string().max(255).describe("MIME type"),
          size: z.number().int().nonnegative().describe("File size in bytes"),
        }),
      ),
    },
  },
  responses: {
    200: {
      description: "Presigned upload URL",
      content: jsonContent(
        z.object({
          upload_url: z.string(),
          r2_key: z.string(),
          expires_at: DateTimeSchema,
        }),
      ),
    },
    ...errorResponses([400, 401, 403, 413, 501]),
  },
});

const completeUploadRoute = createRoute({
  method: "post",
  path: "/{id}/content/complete",
  operationId: "completeContentUpload",
  tags: ["Content"],
  summary: "Finalize a presigned upload",
  "x-arke-auth": "required",
  "x-arke-related": ["POST /entities/{id}/content/upload-url"],
  request: {
    params: z.object({
      id: pathParam("id", EntityIdParam, "Entity ULID"),
    }),
    body: {
      required: true,
      content: jsonContent(
        z.object({
          key: z.string().min(1).max(128).describe("Content key"),
          cid: z.string().describe("BLAKE3 hash"),
          size: z.number().int().nonnegative().describe("File size"),
          content_type: z.string().max(255).describe("MIME type"),
          ver: z.number().int().describe("Expected current version (CAS token). Server increments ver on success."),
          filename: z.string().min(1).max(255).optional().describe("Optional display filename"),
        }),
      ),
    },
  },
  responses: {
    200: {
      description: "Upload finalized",
      content: jsonContent(
        z.object({
          cid: z.string(),
          size: z.number().int(),
          key: z.string(),
          ver: z.number().int(),
        }),
      ),
    },
    ...errorResponses([400, 401, 403, 404, 409, 501]),
  },
});

const getContentRoute = createRoute({
  method: "get",
  path: "/{id}/content",
  operationId: "getEntityContent",
  tags: ["Content"],
  summary: "Download a file from an entity",
  "x-arke-auth": "optional",
  "x-arke-related": ["POST /entities/{id}/content", "DELETE /entities/{id}/content"],
  request: {
    params: z.object({
      id: pathParam("id", EntityIdParam, "Entity ULID"),
    }),
    query: z.object({
      key: queryParam("key", z.string().optional(), "Content key (returns first key if omitted)"),
      cid: queryParam("cid", z.string().optional(), "Lookup by CID instead of key"),
    }),
  },
  responses: {
    200: {
      description: "Raw file bytes",
      content: {
        "application/octet-stream": {
          schema: z.string().openapi({ type: "string", format: "binary" }),
        },
      },
    },
    ...errorResponses([400, 403, 404]),
  },
});

const deleteContentRoute = createRoute({
  method: "delete",
  path: "/{id}/content",
  operationId: "deleteEntityContent",
  tags: ["Content"],
  summary: "Delete a file from an entity",
  "x-arke-auth": "required",
  "x-arke-related": ["GET /entities/{id}/content"],
  request: {
    params: z.object({
      id: pathParam("id", EntityIdParam, "Entity ULID"),
    }),
    query: z.object({
      key: queryParam("key", z.string().optional(), "Content key to delete"),
      cid: queryParam("cid", z.string().optional(), "CID to delete"),
      ver: queryParam("ver", z.coerce.number().int(), "Expected current version (CAS token). Server increments ver on success."),
    }),
  },
  responses: {
    204: {
      description: "Content deleted",
    },
    ...errorResponses([400, 401, 403, 404, 409]),
  },
});

const renameContentRoute = createRoute({
  method: "patch",
  path: "/{id}/content",
  operationId: "renameEntityContent",
  tags: ["Content"],
  summary: "Rename a content key",
  "x-arke-auth": "required",
  request: {
    params: z.object({
      id: pathParam("id", EntityIdParam, "Entity ULID"),
    }),
    body: {
      required: true,
      content: jsonContent(
        z.object({
          from: z.string().min(1).max(128).describe("Current content key"),
          to: z.string().min(1).max(128).describe("New content key"),
          ver: z.number().int().describe("Expected current version (CAS token). Server increments ver on success."),
        }),
      ),
    },
  },
  responses: {
    200: {
      description: "Content key renamed",
      content: jsonContent(z.object({ ok: z.boolean(), ver: z.number().int() })),
    },
    ...errorResponses([400, 401, 403, 404, 409]),
  },
});

export const contentRouter = createRouter();

contentRouter.openapi(uploadContentRoute, async (c) => {
  const actor = requireActor(c);
  const entityId = c.req.param("id");
  const key = c.req.query("key");
  const filename = c.req.query("filename");
  const verRaw = c.req.query("ver");
  const expectedVer = verRaw ? Number.parseInt(verRaw, 10) : NaN;
  const contentType = c.req.header("content-type");
  const lengthHeader = c.req.header("content-length");
  const declaredLength = lengthHeader ? Number.parseInt(lengthHeader, 10) : null;

  if (!key || !isValidContentKey(key)) {
    throw new ApiError(400, "invalid_query", "Invalid content key");
  }
  if (filename !== undefined && (filename.length < 1 || filename.length > 255)) {
    throw new ApiError(400, "invalid_query", "Invalid filename");
  }
  if (!Number.isInteger(expectedVer)) {
    throw new ApiError(400, "missing_required_field", "Missing ver");
  }
  if (!contentType) {
    throw new ApiError(400, "missing_required_header", "Missing Content-Type");
  }
  if (declaredLength !== null && (!Number.isInteger(declaredLength) || declaredLength < 0)) {
    throw new ApiError(400, "invalid_header", "Invalid Content-Length");
  }
  if (declaredLength !== null && declaredLength > MAX_FILE_SIZE) {
    throw new ApiError(413, "file_too_large", "File exceeds 500 MB limit");
  }

  const editable = await ensureEditAccess(c.env, actor.id, entityId);
  const entity = requireVisibleEntity(editable.entity, editable.exists);

  if (entity.ver !== expectedVer) {
    throw new ApiError(409, "cas_conflict", "Version mismatch", {
      entity_id: entityId,
      expected_ver: expectedVer,
      actual_ver: entity.ver,
    });
  }

  const bytes = new Uint8Array(await c.req.raw.arrayBuffer());
  if (bytes.byteLength > MAX_FILE_SIZE) {
    throw new ApiError(413, "file_too_large", "File exceeds 500 MB limit");
  }

  const cid = await computeCidFromBytes(bytes);
  await c.env.FILES_BUCKET.put(`${entityId}/${cid}`, bytes, {
    httpMetadata: { contentType },
    customMetadata: { cid, entity_id: entityId, key },
  });

  const properties = { ...(entity.properties ?? {}) } as Record<string, unknown>;
  const contentMap = { ...getContentMap(properties) };
  contentMap[key] = {
    cid,
    size: bytes.byteLength,
    content_type: contentType,
    ...(filename ? { filename } : {}),
    uploaded_at: new Date().toISOString(),
  };
  properties.content = contentMap;

  const { nextVer, ts } = await updateContentMetadata({
    env: c.env,
    actorId: actor.id,
    entity,
    expectedVer,
    properties,
    action: "content_uploaded",
    detail: {
      key,
      cid,
      size: bytes.byteLength,
      content_type: contentType,
      ...(filename ? { filename } : {}),
    },
  });

  c.executionCtx.waitUntil(
    fanOutNotifications(c.env, {
      entity_id: entityId,
      commons_id: entity.commons_id,
      actor_id: actor.id,
      action: "content_uploaded",
      detail: { key, cid, size: bytes.byteLength, content_type: contentType, ...(filename ? { filename } : {}) },
      ts,
    }),
  );

  return c.json({
    cid,
    size: bytes.byteLength,
    key,
    ver: nextVer,
  }, 200);
});

contentRouter.openapi(uploadUrlRoute, async (c) => {
  const actor = requireActor(c);
  const entityId = c.req.param("id");
  const body = await parseJsonBody<Record<string, unknown>>(c);
  if (
    typeof body.cid !== "string" ||
    typeof body.content_type !== "string" ||
    typeof body.size !== "number"
  ) {
    throw new ApiError(400, "invalid_body", "Invalid upload-url payload");
  }
  if (!isValidCid(body.cid)) {
    throw new ApiError(400, "invalid_body", "Invalid CID");
  }
  if (!body.content_type || body.content_type.length > 255) {
    throw new ApiError(400, "invalid_body", "Invalid content_type");
  }
  if (!Number.isInteger(body.size) || body.size < 0) {
    throw new ApiError(400, "invalid_body", "Invalid size");
  }
  if (body.size > MAX_FILE_SIZE) {
    throw new ApiError(413, "file_too_large", "File exceeds 500 MB limit");
  }

  const editable = await ensureEditAccess(c.env, actor.id, entityId);
  requireVisibleEntity(editable.entity, editable.exists);

  return c.json(await createPresignedUploadUrl(c.env, entityId, body.cid, body.content_type), 200);
});

contentRouter.openapi(completeUploadRoute, async (c) => {
  const actor = requireActor(c);
  const entityId = c.req.param("id");
  const body = await parseJsonBody<Record<string, unknown>>(c);
  if (
    typeof body.key !== "string" ||
    typeof body.cid !== "string" ||
    typeof body.size !== "number" ||
    typeof body.content_type !== "string" ||
    typeof body.ver !== "number"
  ) {
    throw new ApiError(400, "invalid_body", "Invalid complete payload");
  }
  if (!isValidContentKey(body.key)) {
    throw new ApiError(400, "invalid_body", "Invalid content key");
  }
  if (!isValidCid(body.cid)) {
    throw new ApiError(400, "invalid_body", "Invalid CID");
  }
  if (!Number.isInteger(body.size) || body.size < 0 || body.size > MAX_FILE_SIZE) {
    throw new ApiError(400, "invalid_body", "Invalid size");
  }
  if (!body.content_type || body.content_type.length > 255) {
    throw new ApiError(400, "invalid_body", "Invalid content_type");
  }
  if (
    body.filename !== undefined &&
    (typeof body.filename !== "string" || body.filename.length < 1 || body.filename.length > 255)
  ) {
    throw new ApiError(400, "invalid_body", "Invalid filename");
  }

  getPresignConfig(c.env);

  const editable = await ensureEditAccess(c.env, actor.id, entityId);
  const entity = requireVisibleEntity(editable.entity, editable.exists);
  if (entity.ver !== body.ver) {
    throw new ApiError(409, "cas_conflict", "Version mismatch", {
      entity_id: entityId,
      expected_ver: body.ver,
      actual_ver: entity.ver,
    });
  }

  const object = await c.env.FILES_BUCKET.head(`${entityId}/${body.cid}`);
  if (!object) {
    throw new ApiError(400, "upload_not_found", "Upload not found at the expected CID");
  }
  if (object.size !== body.size) {
    throw new ApiError(409, "upload_mismatch", "Uploaded object size does not match request", {
      expected_size: body.size,
      actual_size: object.size,
    });
  }
  const actualContentType = object.httpMetadata?.contentType ?? "application/octet-stream";
  if (actualContentType !== body.content_type) {
    throw new ApiError(409, "upload_mismatch", "Uploaded object content_type does not match request", {
      expected_content_type: body.content_type,
      actual_content_type: actualContentType,
    });
  }

  const properties = { ...(entity.properties ?? {}) } as Record<string, unknown>;
  const contentMap = { ...getContentMap(properties) };
  contentMap[body.key] = {
    cid: body.cid,
    size: body.size,
    content_type: body.content_type,
    ...(typeof body.filename === "string" ? { filename: body.filename } : {}),
    uploaded_at: new Date().toISOString(),
  };
  properties.content = contentMap;

  const { nextVer, ts } = await updateContentMetadata({
    env: c.env,
    actorId: actor.id,
    entity,
    expectedVer: body.ver,
    properties,
    action: "content_uploaded",
    detail: {
      key: body.key,
      cid: body.cid,
      size: body.size,
      content_type: body.content_type,
      ...(typeof body.filename === "string" ? { filename: body.filename } : {}),
      transport: "presigned",
    },
  });

  c.executionCtx.waitUntil(
    fanOutNotifications(c.env, {
      entity_id: entityId,
      commons_id: entity.commons_id,
      actor_id: actor.id,
      action: "content_uploaded",
      detail: {
        key: body.key,
        cid: body.cid,
        size: body.size,
        content_type: body.content_type,
        ...(typeof body.filename === "string" ? { filename: body.filename } : {}),
        transport: "presigned",
      },
      ts,
    }),
  );

  return c.json({
    cid: body.cid,
    size: body.size,
    key: body.key,
    ver: nextVer,
  }, 200);
});

contentRouter.openapi(getContentRoute, async (c) => {
  const actorId = c.get("actor")?.id ?? "";
  const entityId = c.req.param("id");
  const key = c.req.query("key");
  const cid = c.req.query("cid");

  if (cid && !isValidCid(cid)) {
    throw new ApiError(400, "invalid_query", "Invalid CID");
  }

  const loaded = await loadVisibleEntity(c.env, actorId, entityId);
  const entity = requireVisibleEntity(loaded.entity, loaded.exists);
  const contentMap = getContentMap(entity.properties ?? {});

  const entry = cid
    ? Object.values(contentMap).find((value) => value.cid === cid)
    : key
      ? contentMap[key]
      : contentMap[Object.keys(contentMap).sort()[0] ?? ""];

  if (!entry || typeof entry.cid !== "string") {
    throw new ApiError(404, "file_not_found", "Content not found");
  }

  const object = await c.env.FILES_BUCKET.get(`${entityId}/${entry.cid}`);
  if (!object?.body) {
    throw new ApiError(404, "file_not_found", "Content not found");
  }

  const headers = new Headers();
  headers.set("content-type", typeof entry.content_type === "string" ? entry.content_type : "application/octet-stream");
  headers.set("cache-control", "private, max-age=3600");
  if (typeof entry.size === "number") {
    headers.set("content-length", String(entry.size));
  }
  if (typeof entry.filename === "string") {
    headers.set("content-disposition", `attachment; filename="${entry.filename}"`);
  }

  return new Response(object.body, { status: 200, headers });
});

contentRouter.openapi(deleteContentRoute, async (c) => {
  const actor = requireActor(c);
  const entityId = c.req.param("id");
  const key = c.req.query("key");
  const cid = c.req.query("cid");
  const verRaw = c.req.query("ver");
  const expectedVer = verRaw ? Number.parseInt(verRaw, 10) : NaN;
  if (!Number.isInteger(expectedVer)) {
    throw new ApiError(400, "missing_required_field", "Missing ver");
  }
  if (!key && !cid) {
    throw new ApiError(400, "invalid_query", "Specify key or cid");
  }
  if (cid && !isValidCid(cid)) {
    throw new ApiError(400, "invalid_query", "Invalid CID");
  }

  const editable = await ensureEditAccess(c.env, actor.id, entityId);
  const entity = requireVisibleEntity(editable.entity, editable.exists);
  if (entity.ver !== expectedVer) {
    throw new ApiError(409, "cas_conflict", "Version mismatch", {
      entity_id: entityId,
      expected_ver: expectedVer,
      actual_ver: entity.ver,
    });
  }

  const properties = { ...(entity.properties ?? {}) } as Record<string, unknown>;
  const contentMap = { ...getContentMap(properties) };
  let removedKey: string | null = null;
  let removedCid: string | null = null;

  if (key && contentMap[key]) {
    removedKey = key;
    removedCid = contentMap[key]?.cid ?? null;
    delete contentMap[key];
  } else if (cid) {
    for (const [entryKey, entry] of Object.entries(contentMap)) {
      if (entry.cid === cid) {
        removedKey = entryKey;
        removedCid = entry.cid;
        delete contentMap[entryKey];
        break;
      }
    }
  }

  if (!removedKey) {
    throw new ApiError(404, "file_not_found", "Content not found");
  }

  properties.content = contentMap;
  const { nextVer, ts } = await updateContentMetadata({
    env: c.env,
    actorId: actor.id,
    entity,
    expectedVer,
    properties,
    action: "content_deleted",
    detail: { key: removedKey, cid: removedCid },
  });

  c.executionCtx.waitUntil(
    fanOutNotifications(c.env, {
      entity_id: entityId,
      commons_id: entity.commons_id,
      actor_id: actor.id,
      action: "content_deleted",
      detail: { key: removedKey, cid: removedCid, ver: nextVer },
      ts,
    }),
  );

  return new Response(null, { status: 204 });
});

contentRouter.openapi(renameContentRoute, async (c) => {
  const actor = requireActor(c);
  const entityId = c.req.param("id");
  const body = await parseJsonBody<Record<string, unknown>>(c);
  if (typeof body.from !== "string" || typeof body.to !== "string" || typeof body.ver !== "number") {
    throw new ApiError(400, "invalid_body", "Invalid content rename body");
  }
  if (!isValidContentKey(body.from) || !isValidContentKey(body.to)) {
    throw new ApiError(400, "invalid_body", "Invalid content key");
  }

  const editable = await ensureEditAccess(c.env, actor.id, entityId);
  const entity = requireVisibleEntity(editable.entity, editable.exists);
  if (entity.ver !== body.ver) {
    throw new ApiError(409, "cas_conflict", "Version mismatch", {
      entity_id: entityId,
      expected_ver: body.ver,
      actual_ver: entity.ver,
    });
  }

  const properties = { ...(entity.properties ?? {}) } as Record<string, unknown>;
  const contentMap = { ...getContentMap(properties) };
  if (!contentMap[body.from]) {
    throw new ApiError(404, "file_not_found", "Content key not found");
  }
  if (body.from !== body.to && contentMap[body.to]) {
    throw new ApiError(409, "already_exists", "Target content key already exists");
  }

  contentMap[body.to] = contentMap[body.from];
  delete contentMap[body.from];
  properties.content = contentMap;

  const { updated, ts } = await updateContentMetadata({
    env: c.env,
    actorId: actor.id,
    entity,
    expectedVer: body.ver,
    properties,
    action: "content_renamed",
    detail: { from: body.from, to: body.to, cid: contentMap[body.to]?.cid },
  });

  c.executionCtx.waitUntil(
    fanOutNotifications(c.env, {
      entity_id: entityId,
      commons_id: entity.commons_id,
      actor_id: actor.id,
      action: "content_renamed",
      detail: { from: body.from, to: body.to, cid: contentMap[body.to]?.cid, ver: updated.ver },
      ts,
    }),
  );

  return c.json({ ok: true, ver: updated.ver }, 200);
});
