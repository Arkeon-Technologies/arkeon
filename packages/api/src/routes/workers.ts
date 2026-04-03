import { createRoute, z } from "@hono/zod-openapi";

import { ApiError } from "../lib/errors";
import { requireActor, parseJsonBody } from "../lib/http";
import { createRouter } from "../lib/openapi";
import { encrypt, keyHint } from "../lib/crypto";
import { invokeWorker } from "../lib/worker-invoke";
import { recordInvocation } from "../lib/invocation-recorder";
import { syncWorkerSchedule, isSchedulerAvailable } from "../lib/scheduler";
import { encodeCursor } from "../lib/cursor";
import { parseLimit, parseCursorParam } from "../lib/http";
import {
  ActorSchema,
  ClassificationLevel,
  DateTimeSchema,
  UlidSchema,
  WorkerConfigSchema,
  cursorResponseSchema,
  entityIdParams,
  errorResponses,
  jsonContent,
  JsonObjectSchema,
  paginationQuerySchema,
  pathParam,
  EntityIdParam,
} from "../lib/schemas";
import { setActorContext } from "../lib/actor-context";
import { createSql } from "../lib/sql";

type ActorRecord = {
  id: string;
  kind: string;
  max_read_level: number;
  max_write_level: number;
  is_admin: boolean;
  can_publish_public: boolean;
  owner_id: string | null;
  properties: Record<string, unknown>;
  status: string;
  created_at: string;
  updated_at: string;
};

type WorkerProperties = {
  name: string;
  system_prompt: string;
  llm: {
    base_url: string;
    model: string;
    api_key_encrypted: string;
    api_key_hint: string;
  };
  arke_key_encrypted: string;
  arke_key_hint: string;
  max_iterations?: number;
  resource_limits?: {
    memory_mb?: number;
    cpu_percent?: number;
    max_pids?: number;
    timeout_ms?: number;
  };
};

async function requireWorker(
  sql: ReturnType<typeof createSql>,
  actor: { id: string; isAdmin: boolean },
  workerId: string,
): Promise<ActorRecord> {
  const [row] = await sql`
    SELECT * FROM actors
    WHERE id = ${workerId} AND kind = 'worker' AND status = 'active'
    LIMIT 1
  `;
  if (!row) {
    throw new ApiError(404, "not_found", "Worker not found");
  }
  const worker = row as ActorRecord;
  if (worker.owner_id !== actor.id && !actor.isAdmin) {
    throw new ApiError(403, "forbidden", "Only the worker's owner can access it");
  }
  return worker;
}

async function requireWorkerInvoke(
  sql: ReturnType<typeof createSql>,
  actor: { id: string; isAdmin: boolean },
  workerId: string,
): Promise<ActorRecord> {
  const [row] = await sql`
    SELECT * FROM actors
    WHERE id = ${workerId} AND kind = 'worker' AND status = 'active'
    LIMIT 1
  `;
  if (!row) {
    throw new ApiError(404, "not_found", "Worker not found");
  }
  const worker = row as ActorRecord;
  if (worker.owner_id === actor.id || actor.isAdmin) {
    return worker;
  }
  // Check worker_permissions for invoker grant (direct or via group)
  // Use actor_has_worker_role() which is SECURITY DEFINER and bypasses RLS.
  // Only need app.actor_id set for current_actor_id() used inside the function.
  const [, permRow] = await sql.transaction([
    sql`SELECT set_config('app.actor_id', ${actor.id}, true)`,
    sql`SELECT actor_has_worker_role(${workerId}, ARRAY['invoker']) AS has_role`,
  ]);
  const hasRole = (permRow as Array<Record<string, unknown>>)[0]?.has_role;
  if (!hasRole) {
    throw new ApiError(403, "forbidden", "You do not have permission to invoke this worker");
  }
  return worker;
}

function redactProperties(props: Record<string, unknown>): Record<string, unknown> {
  const wp = props as unknown as WorkerProperties;
  return {
    name: wp.name,
    system_prompt: wp.system_prompt,
    llm: wp.llm
      ? {
          base_url: wp.llm.base_url,
          model: wp.llm.model,
          api_key_hint: wp.llm.api_key_hint,
        }
      : null,
    arke_key_hint: wp.arke_key_hint,
    max_iterations: wp.max_iterations,
    schedule: (props as Record<string, unknown>).schedule ?? null,
    scheduled_prompt: (props as Record<string, unknown>).scheduled_prompt ?? null,
    resource_limits: wp.resource_limits,
  };
}

// --- Route definitions ---

const invokeWorkerRoute = createRoute({
  method: "post",
  path: "/{id}/invoke",
  operationId: "invokeWorker",
  tags: ["Workers"],
  summary: "Invoke a worker with a prompt",
  "x-arke-auth": "required",
  "x-arke-related": ["GET /actors/{id}", "GET /workers/{id}"],
  request: {
    params: entityIdParams("Worker actor ULID"),
    body: {
      required: true,
      content: jsonContent(
        z.object({
          prompt: z.string().min(1).max(100000).describe("The task prompt for the worker"),
          store_log: z.boolean().optional().describe("Store full agent log in invocation history (default: false)"),
        }),
      ),
    },
  },
  responses: {
    200: {
      description: "Worker invocation result",
      content: jsonContent(
        z.object({
          success: z.boolean(),
          summary: z.string().nullable(),
          iterations: z.number().int(),
        }),
      ),
    },
    ...errorResponses([400, 401, 403, 404, 408]),
  },
});

const getWorkerRoute = createRoute({
  method: "get",
  path: "/{id}",
  operationId: "getWorker",
  tags: ["Workers"],
  summary: "Get worker configuration (keys redacted)",
  "x-arke-auth": "required",
  "x-arke-related": ["PUT /workers/{id}", "POST /workers/{id}/invoke"],
  request: {
    params: entityIdParams("Worker actor ULID"),
  },
  responses: {
    200: {
      description: "Worker details",
      content: jsonContent(
        z.object({
          actor: ActorSchema,
          config: WorkerConfigSchema,
        }),
      ),
    },
    ...errorResponses([401, 403, 404]),
  },
});

const updateWorkerRoute = createRoute({
  method: "put",
  path: "/{id}",
  operationId: "updateWorker",
  tags: ["Workers"],
  summary: "Update worker configuration",
  "x-arke-auth": "required",
  "x-arke-related": ["GET /workers/{id}"],
  request: {
    params: entityIdParams("Worker actor ULID"),
    body: {
      required: true,
      content: jsonContent(
        z.object({
          name: z.string().min(1).max(200).optional().describe("Worker name"),
          system_prompt: z.string().min(1).max(50000).optional().describe("System prompt"),
          llm: z
            .object({
              base_url: z.string().url().optional(),
              api_key: z.string().min(1).optional().describe("New LLM API key (will be re-encrypted)"),
              model: z.string().min(1).optional(),
            })
            .optional(),
          max_iterations: z.number().int().min(1).max(200).optional(),
          schedule: z.string().nullable().optional().describe("Cron expression (null to remove)"),
          scheduled_prompt: z.string().nullable().optional().describe("Prompt used for scheduled runs"),
          resource_limits: z
            .object({
              memory_mb: z.number().int().min(64).max(2048).optional(),
              cpu_percent: z.number().int().min(10).max(100).optional(),
              max_pids: z.number().int().min(16).max(512).optional(),
              timeout_ms: z.number().int().min(1000).max(600000).optional(),
            })
            .optional(),
        }),
      ),
    },
  },
  responses: {
    200: {
      description: "Worker updated",
      content: jsonContent(
        z.object({
          actor: ActorSchema,
          config: WorkerConfigSchema,
        }),
      ),
    },
    ...errorResponses([400, 401, 403, 404]),
  },
});

// --- Router ---

export const workersRouter = createRouter();

workersRouter.openapi(invokeWorkerRoute, async (c) => {
  const actor = requireActor(c);
  const workerId = c.req.param("id");
  const body = await parseJsonBody<{ prompt: string; store_log?: boolean }>(c);
  const sql = createSql();

  if (!body.prompt || typeof body.prompt !== "string") {
    throw new ApiError(400, "missing_required_field", "prompt is required");
  }

  // Owner or invoker permission check
  await requireWorkerInvoke(sql, actor, workerId);

  const result = await invokeWorker(workerId, body.prompt);

  // Record invocation (fire-and-forget)
  recordInvocation({
    workerId,
    invokerId: actor.id,
    source: "http",
    prompt: body.prompt,
    success: result.success,
    summary: result.summary,
    iterations: result.iterations,
    errorMessage: result.errorMessage,
    log: body.store_log ? result.log : null,
    startedAt: result.startedAt,
    completedAt: result.completedAt,
  });

  return c.json(
    {
      success: result.success,
      summary: result.summary,
      iterations: result.iterations,
    },
    200,
  );
});

workersRouter.openapi(getWorkerRoute, async (c) => {
  const actor = requireActor(c);
  const workerId = c.req.param("id");
  const sql = createSql();

  const worker = await requireWorker(sql, actor, workerId);

  return c.json(
    {
      actor: worker,
      config: redactProperties(worker.properties),
    },
    200,
  );
});

workersRouter.openapi(updateWorkerRoute, async (c) => {
  const actor = requireActor(c);
  const workerId = c.req.param("id");
  const body = await parseJsonBody<Record<string, unknown>>(c);
  const sql = createSql();
  const now = new Date().toISOString();

  const worker = await requireWorker(sql, actor, workerId);
  const props = { ...(worker.properties as Record<string, unknown>) } as Record<string, unknown>;

  // Merge updates into existing properties
  if (typeof body.name === "string") props.name = body.name;
  if (typeof body.system_prompt === "string") props.system_prompt = body.system_prompt;
  if (typeof body.max_iterations === "number") props.max_iterations = body.max_iterations;
  if (body.resource_limits && typeof body.resource_limits === "object") {
    props.resource_limits = { ...(props.resource_limits as object ?? {}), ...body.resource_limits };
  }

  // Schedule fields
  if (body.schedule !== undefined) {
    if (body.schedule === null) {
      delete props.schedule;
      delete props.scheduled_prompt;
    } else if (typeof body.schedule === "string") {
      if (!body.scheduled_prompt || typeof body.scheduled_prompt !== "string") {
        throw new ApiError(400, "missing_required_field", "scheduled_prompt is required when setting a schedule");
      }
      if (!isSchedulerAvailable()) {
        throw new ApiError(503, "scheduler_unavailable", "Scheduling is not available — Redis is not configured on this instance");
      }
      props.schedule = body.schedule;
      props.scheduled_prompt = body.scheduled_prompt;
    }
  } else if (typeof body.scheduled_prompt === "string" && props.schedule) {
    props.scheduled_prompt = body.scheduled_prompt;
  }

  // LLM config: merge fields, re-encrypt if new key provided
  if (body.llm && typeof body.llm === "object") {
    const llmUpdate = body.llm as Record<string, unknown>;
    const existingLlm = (props.llm ?? {}) as Record<string, unknown>;

    if (typeof llmUpdate.base_url === "string") existingLlm.base_url = llmUpdate.base_url;
    if (typeof llmUpdate.model === "string") existingLlm.model = llmUpdate.model;
    if (typeof llmUpdate.api_key === "string") {
      existingLlm.api_key_encrypted = await encrypt(llmUpdate.api_key as string);
      existingLlm.api_key_hint = keyHint(llmUpdate.api_key as string);
    }

    props.llm = existingLlm;
  }

  const [,,,,, rows] = await sql.transaction([
    ...setActorContext(sql, actor),
    sql.query(
      `UPDATE actors SET properties = $1::jsonb, updated_at = $2::timestamptz WHERE id = $3 RETURNING *`,
      [JSON.stringify(props), now, workerId],
    ),
  ]);

  const updated = (rows as ActorRecord[])[0];
  if (!updated) {
    throw new ApiError(500, "internal_error", "Failed to update worker");
  }

  // Sync schedule with BullMQ
  const updatedSchedule = (updated.properties as Record<string, unknown>).schedule as string | undefined;
  const updatedPrompt = (updated.properties as Record<string, unknown>).scheduled_prompt as string | undefined;
  await syncWorkerSchedule(workerId, updatedSchedule ?? null, updatedPrompt ?? null);

  return c.json(
    {
      actor: updated,
      config: redactProperties(updated.properties),
    },
    200,
  );
});

// --- Invocation history routes ---

const InvocationSchema = z.object({
  id: z.number().int(),
  worker_id: z.string(),
  invoker_id: z.string(),
  source: z.enum(["http", "scheduler"]),
  prompt: z.string(),
  success: z.boolean(),
  summary: z.string().nullable(),
  iterations: z.number().int(),
  error_message: z.string().nullable(),
  log: z.any().nullable(),
  started_at: DateTimeSchema,
  completed_at: DateTimeSchema,
  duration_ms: z.number().int(),
  ts: DateTimeSchema,
});

const listInvocationsRoute = createRoute({
  method: "get",
  path: "/{id}/invocations",
  operationId: "listWorkerInvocations",
  tags: ["Workers"],
  summary: "List invocation history for a worker",
  "x-arke-auth": "required",
  "x-arke-related": ["POST /workers/{id}/invoke", "GET /workers/{id}/invocations/latest"],
  request: {
    params: entityIdParams("Worker actor ULID"),
    query: paginationQuerySchema(50, 200),
  },
  responses: {
    200: {
      description: "Invocation list",
      content: jsonContent(cursorResponseSchema("invocations", InvocationSchema)),
    },
    ...errorResponses([401, 403, 404]),
  },
});

const latestInvocationRoute = createRoute({
  method: "get",
  path: "/{id}/invocations/latest",
  operationId: "getLatestWorkerInvocation",
  tags: ["Workers"],
  summary: "Get the most recent invocation for a worker",
  "x-arke-auth": "required",
  "x-arke-related": ["GET /workers/{id}/invocations"],
  request: {
    params: entityIdParams("Worker actor ULID"),
  },
  responses: {
    200: {
      description: "Latest invocation (or null if none)",
      content: jsonContent(z.object({ invocation: InvocationSchema.nullable() })),
    },
    ...errorResponses([401, 403, 404]),
  },
});

workersRouter.openapi(listInvocationsRoute, async (c) => {
  const actor = requireActor(c);
  const workerId = c.req.param("id");
  const sql = createSql();
  const limit = parseLimit(c, { defaultValue: 50, maxValue: 200 });
  const cursor = parseCursorParam(c);

  await requireWorker(sql, actor, workerId);

  const [,,,,, rows] = await sql.transaction([
    ...setActorContext(sql, actor),
    sql.query(
      `SELECT * FROM worker_invocations
       WHERE worker_id = $1
         AND ($2::timestamptz IS NULL OR (ts, id) < ($2::timestamptz, $3::bigint))
       ORDER BY ts DESC, id DESC
       LIMIT $4`,
      [workerId, cursor?.t ?? null, cursor?.i ?? null, limit + 1],
    ),
  ]);

  const invocations = (rows as Array<Record<string, unknown>>).slice(0, limit);
  const next = (rows as Array<Record<string, unknown>>).length > limit
    ? invocations[invocations.length - 1]
    : null;

  return c.json(
    {
      invocations,
      cursor: next
        ? encodeCursor({ t: next.ts as string, i: next.id as number })
        : null,
    },
    200,
  );
});

workersRouter.openapi(latestInvocationRoute, async (c) => {
  const actor = requireActor(c);
  const workerId = c.req.param("id");
  const sql = createSql();

  await requireWorker(sql, actor, workerId);

  const [,,,,, rows] = await sql.transaction([
    ...setActorContext(sql, actor),
    sql.query(
      `SELECT * FROM worker_invocations
       WHERE worker_id = $1
       ORDER BY ts DESC
       LIMIT 1`,
      [workerId],
    ),
  ]);

  const invocation = (rows as Array<Record<string, unknown>>)[0] ?? null;
  return c.json({ invocation }, 200);
});

// --- Permission management routes ---

const WorkerPermissionSchema = z.object({
  worker_id: UlidSchema,
  grantee_type: z.enum(["actor", "group"]),
  grantee_id: z.string(),
  role: z.enum(["invoker"]),
  granted_by: UlidSchema,
  granted_at: DateTimeSchema,
});

const listWorkerPermissionsRoute = createRoute({
  method: "get",
  path: "/{id}/permissions",
  operationId: "listWorkerPermissions",
  tags: ["Workers"],
  summary: "List permissions on a worker",
  "x-arke-auth": "required",
  "x-arke-related": ["POST /workers/{id}/permissions"],
  request: {
    params: entityIdParams("Worker actor ULID"),
  },
  responses: {
    200: {
      description: "Worker permissions",
      content: jsonContent(
        z.object({
          owner_id: UlidSchema.nullable(),
          permissions: z.array(WorkerPermissionSchema),
        }),
      ),
    },
    ...errorResponses([401, 403, 404]),
  },
});

const grantWorkerPermissionRoute = createRoute({
  method: "post",
  path: "/{id}/permissions",
  operationId: "grantWorkerPermission",
  tags: ["Workers"],
  summary: "Grant invocation access on a worker (owner/admin only)",
  "x-arke-auth": "required",
  "x-arke-related": ["GET /workers/{id}/permissions", "DELETE /workers/{id}/permissions/{granteeId}"],
  request: {
    params: entityIdParams("Worker actor ULID"),
    body: {
      required: true,
      content: jsonContent(
        z.object({
          grantee_type: z.enum(["actor", "group"]).default("actor"),
          grantee_id: z.string().describe("Actor or group ULID to grant access to"),
          role: z.enum(["invoker"]).default("invoker"),
        }),
      ),
    },
  },
  responses: {
    201: {
      description: "Permission granted",
      content: jsonContent(z.object({ permission: WorkerPermissionSchema })),
    },
    ...errorResponses([400, 401, 403, 404]),
  },
});

const revokeWorkerPermissionRoute = createRoute({
  method: "delete",
  path: "/{id}/permissions/{granteeId}",
  operationId: "revokeWorkerPermission",
  tags: ["Workers"],
  summary: "Revoke invocation access from an actor or group",
  "x-arke-auth": "required",
  "x-arke-related": ["GET /workers/{id}/permissions"],
  request: {
    params: z.object({
      id: pathParam("id", EntityIdParam, "Worker actor ULID"),
      granteeId: pathParam("granteeId", z.string(), "Grantee actor or group ID"),
    }),
  },
  responses: {
    204: { description: "Permission revoked" },
    ...errorResponses([401, 403, 404]),
  },
});

workersRouter.openapi(listWorkerPermissionsRoute, async (c) => {
  const actor = requireActor(c);
  const workerId = c.req.param("id");
  const sql = createSql();

  const worker = await requireWorker(sql, actor, workerId);

  const [,,,,, rows] = await sql.transaction([
    ...setActorContext(sql, actor),
    sql`SELECT * FROM worker_permissions WHERE worker_id = ${workerId} ORDER BY granted_at`,
  ]);

  return c.json(
    {
      owner_id: worker.owner_id,
      permissions: rows,
    },
    200,
  );
});

workersRouter.openapi(grantWorkerPermissionRoute, async (c) => {
  const actor = requireActor(c);
  const workerId = c.req.param("id");
  const body = await parseJsonBody<Record<string, unknown>>(c);
  const sql = createSql();

  if (!body.grantee_id || typeof body.grantee_id !== "string") {
    throw new ApiError(400, "invalid_body", "Missing grantee_id");
  }

  const granteeType = typeof body.grantee_type === "string" ? body.grantee_type : "actor";
  if (granteeType !== "actor" && granteeType !== "group") {
    throw new ApiError(400, "invalid_body", "grantee_type must be 'actor' or 'group'");
  }

  const role = typeof body.role === "string" ? body.role : "invoker";
  if (role !== "invoker") {
    throw new ApiError(400, "invalid_body", "role must be 'invoker'");
  }

  // Owner/admin check
  await requireWorker(sql, actor, workerId);

  // RLS also enforces this, but the upsert uses ON CONFLICT
  const [,,,,, rows] = await sql.transaction([
    ...setActorContext(sql, actor),
    sql.query(
      `INSERT INTO worker_permissions (worker_id, grantee_type, grantee_id, role, granted_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (worker_id, grantee_type, grantee_id)
       DO UPDATE SET role = EXCLUDED.role, granted_by = EXCLUDED.granted_by, granted_at = NOW()
       RETURNING *`,
      [workerId, granteeType, body.grantee_id, role, actor.id],
    ),
  ]);

  const perm = (rows as Array<Record<string, unknown>>)[0];
  if (!perm) {
    throw new ApiError(403, "forbidden", "Only the worker owner or an admin can grant permissions");
  }

  return c.json({ permission: perm }, 201);
});

workersRouter.openapi(revokeWorkerPermissionRoute, async (c) => {
  const actor = requireActor(c);
  const workerId = c.req.param("id");
  const granteeId = c.req.param("granteeId");
  const sql = createSql();

  // Owner/admin check
  await requireWorker(sql, actor, workerId);

  const [,,,,, rows] = await sql.transaction([
    ...setActorContext(sql, actor),
    sql`DELETE FROM worker_permissions WHERE worker_id = ${workerId} AND grantee_id = ${granteeId} RETURNING worker_id`,
  ]);

  if ((rows as Array<Record<string, unknown>>).length === 0) {
    throw new ApiError(404, "not_found", "Permission not found");
  }

  return new Response(null, { status: 204 });
});
