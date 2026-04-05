import { createRoute, z } from "@hono/zod-openapi";

import { ApiError } from "../lib/errors";
import { requireActor, parseJsonBody } from "../lib/http";
import { createRouter } from "../lib/openapi";
import { encrypt, keyHint } from "../lib/crypto";
import { enqueueInvocation, enqueueBatch, getQueuePosition, getQueueStats } from "../lib/invocation-queue";
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
  description:
    "Queues a worker invocation. Returns 202 with an invocation ID by default. " +
    "Pass ?wait=true to block until the invocation completes (returns 200 with full result).",
  "x-arke-auth": "required",
  "x-arke-related": [
    "GET /actors/{id}",
    "GET /workers/{id}",
    "GET /workers/invocations/{invocationId}",
  ],
  "x-arke-rules": ["Requires owner, system admin, or invoker permission grant"],
  request: {
    params: entityIdParams("Worker actor ULID"),
    query: z.object({
      wait: z
        .string()
        .optional()
        .describe("If 'true', block until invocation completes and return the full result"),
    }),
    body: {
      required: true,
      content: jsonContent(
        z.object({
          prompt: z.string().min(1).max(100000).describe("The task prompt for the worker"),
          store_log: z.boolean().optional().describe("Override log storage (default: true, respects worker's log_level setting)"),
        }),
      ),
    },
  },
  responses: {
    200: {
      description: "Worker invocation result (when ?wait=true)",
      content: jsonContent(
        z.object({
          invocation_id: z.number().int(),
          success: z.boolean(),
          result: z.any().nullable().describe("Structured result output from the worker"),
          iterations: z.number().int(),
          usage: z.object({
            input_tokens: z.number().int(),
            output_tokens: z.number().int(),
            total_tokens: z.number().int(),
            llm_calls: z.number().int(),
            tool_calls: z.number().int(),
          }),
        }),
      ),
    },
    202: {
      description: "Invocation queued",
      content: jsonContent(
        z.object({
          invocation_id: z.number().int(),
          status: z.literal("queued"),
        }),
      ),
    },
    ...errorResponses([400, 401, 403, 404, 503]),
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
  "x-arke-rules": ["Only the worker owner or a system admin may access"],
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
  "x-arke-rules": ["Only the worker owner or a system admin may update"],
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
          log_level: z.enum(["full", "errors_only", "none"]).optional().describe("Log verbosity for invocations (default: full)"),
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
  const wait = c.req.query("wait") === "true";

  if (!body.prompt || typeof body.prompt !== "string") {
    throw new ApiError(400, "missing_required_field", "prompt is required");
  }

  // Owner or invoker permission check
  await requireWorkerInvoke(sql, actor, workerId);

  // Read nesting context from headers (set by parent sandbox env vars)
  const parentInvocationId = c.req.header("x-arke-parent-invocation")
    ? Number(c.req.header("x-arke-parent-invocation"))
    : null;
  const depth = c.req.header("x-arke-invocation-depth")
    ? Number(c.req.header("x-arke-invocation-depth")) + 1
    : 0;

  const { invocationId, promise } = await enqueueInvocation(
    workerId,
    actor.id,
    "http",
    body.prompt,
    body.store_log,
    parentInvocationId,
    depth,
  );

  if (wait) {
    const result = await promise;
    return c.json(
      {
        invocation_id: invocationId,
        success: result.success,
        result: result.result,
        iterations: result.iterations,
        usage: {
          input_tokens: result.usage.inputTokens,
          output_tokens: result.usage.outputTokens,
          total_tokens: result.usage.totalTokens,
          llm_calls: result.usage.llmCalls,
          tool_calls: result.usage.toolCalls,
        },
      },
      200,
    );
  }

  return c.json(
    {
      invocation_id: invocationId,
      status: "queued" as const,
    },
    202,
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
  if (typeof body.log_level === "string") props.log_level = body.log_level;
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
  status: z.enum(["queued", "running", "completed", "failed", "cancelled"]),
  prompt: z.string(),
  success: z.boolean().nullable(),
  result: z.any().nullable(),
  iterations: z.number().int(),
  error_message: z.string().nullable(),
  log: z.any().nullable(),
  input_tokens: z.number().int().nullable(),
  output_tokens: z.number().int().nullable(),
  total_tokens: z.number().int().nullable(),
  llm_calls_count: z.number().int().nullable(),
  tool_calls_count: z.number().int().nullable(),
  parent_invocation_id: z.number().int().nullable(),
  depth: z.number().int(),
  batch_id: z.string().nullable(),
  batch_seq: z.number().int().nullable(),
  queued_at: DateTimeSchema,
  started_at: DateTimeSchema.nullable(),
  completed_at: DateTimeSchema.nullable(),
  duration_ms: z.number().int().nullable(),
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
  "x-arke-rules": ["Only the worker owner or a system admin may view invocations"],
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
  "x-arke-rules": ["Only the worker owner or a system admin may view invocations"],
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

const getInvocationRoute = createRoute({
  method: "get",
  path: "/invocations/{invocationId}",
  operationId: "getWorkerInvocation",
  tags: ["Workers"],
  summary: "Get a worker invocation by ID (poll for status)",
  description:
    "Retrieve the current state of a worker invocation. Use this to poll for completion " +
    "after a 202 response from the invoke endpoint. Includes queue_position when status is 'queued'.",
  "x-arke-auth": "required",
  "x-arke-related": ["POST /workers/{id}/invoke"],
  "x-arke-rules": ["Only the worker owner or a system admin may view invocations"],
  request: {
    params: z.object({
      invocationId: z.string().regex(/^\d+$/).describe("Invocation ID"),
    }),
  },
  responses: {
    200: {
      description: "Invocation details",
      content: jsonContent(
        InvocationSchema.extend({
          queue_position: z.number().int().nullable().describe("Position in queue (1-based), null if not queued"),
        }),
      ),
    },
    ...errorResponses([401, 404]),
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

workersRouter.openapi(getInvocationRoute, async (c) => {
  const actor = requireActor(c);
  const invocationId = Number(c.req.param("invocationId"));
  const sql = createSql();

  const [,,,,, rows] = await sql.transaction([
    ...setActorContext(sql, actor),
    sql.query(
      `SELECT * FROM worker_invocations WHERE id = $1`,
      [invocationId],
    ),
  ]);

  const invocation = (rows as Array<Record<string, unknown>>)[0];
  if (!invocation) {
    throw new ApiError(404, "not_found", "Invocation not found");
  }

  const queuePosition = invocation.status === "queued"
    ? getQueuePosition(invocationId)
    : null;

  return c.json({ ...invocation, queue_position: queuePosition }, 200);
});

// --- Invocation tree route ---

const getInvocationTreeRoute = createRoute({
  method: "get",
  path: "/invocations/{invocationId}/tree",
  operationId: "getInvocationTree",
  tags: ["Workers"],
  summary: "Get the full invocation tree from a root invocation",
  description:
    "Retrieves all invocations in the tree rooted at the given invocation ID using a recursive query. " +
    "Returns a flat array ordered by depth then timestamp, with parent_invocation_id for client-side tree building.",
  "x-arke-auth": "required",
  "x-arke-related": ["GET /workers/invocations/{invocationId}"],
  "x-arke-rules": ["Only the worker owner or a system admin may view invocation trees"],
  request: {
    params: z.object({
      invocationId: z.string().regex(/^\d+$/).describe("Root invocation ID"),
    }),
  },
  responses: {
    200: {
      description: "Invocation tree",
      content: jsonContent(z.object({ invocations: z.array(InvocationSchema) })),
    },
    ...errorResponses([401, 404]),
  },
});

workersRouter.openapi(getInvocationTreeRoute, async (c) => {
  const actor = requireActor(c);
  const invocationId = Number(c.req.param("invocationId"));
  const sql = createSql();

  const [,,,,, rows] = await sql.transaction([
    ...setActorContext(sql, actor),
    sql.query(
      `WITH RECURSIVE tree AS (
        SELECT * FROM worker_invocations WHERE id = $1
        UNION ALL
        SELECT wi.* FROM worker_invocations wi
        INNER JOIN tree t ON wi.parent_invocation_id = t.id
      )
      SELECT * FROM tree ORDER BY depth, ts`,
      [invocationId],
    ),
  ]);

  const invocations = rows as Array<Record<string, unknown>>;
  if (invocations.length === 0) {
    throw new ApiError(404, "not_found", "Invocation not found");
  }

  return c.json({ invocations }, 200);
});

// --- Batch invocation routes ---

const BatchItemSchema = z.object({
  worker_id: UlidSchema.describe("Worker actor ULID to invoke"),
  prompt: z.string().min(1).max(100000).describe("Task prompt for this step"),
  store_log: z.boolean().optional().describe("Override log storage (default: true)"),
});

const invokeBatchRoute = createRoute({
  method: "post",
  path: "/invoke-batch",
  operationId: "invokeBatch",
  tags: ["Workers"],
  summary: "Submit a sequential batch of worker invocations",
  description:
    "Creates a batch of invocations that execute sequentially — each item starts only after " +
    "the previous one completes. Returns immediately with the batch ID and all invocation IDs. " +
    "Poll GET /workers/batch/{batchId} to track progress.",
  "x-arke-auth": "required",
  "x-arke-related": [
    "GET /workers/batch/{batchId}",
    "GET /workers/invocations/{invocationId}",
    "POST /workers/{id}/invoke",
  ],
  "x-arke-rules": [
    "Requires invoke permission on every worker in the batch",
  ],
  request: {
    body: {
      required: true,
      content: jsonContent(
        z.object({
          items: z.array(BatchItemSchema).min(1).max(50).describe("Ordered list of invocations to execute sequentially"),
          on_fail: z.enum(["continue", "cancel"]).default("continue").describe("What to do when an item fails: 'continue' runs the next item, 'cancel' cancels all remaining"),
        }),
      ),
    },
  },
  responses: {
    202: {
      description: "Batch queued",
      content: jsonContent(
        z.object({
          batch_id: z.string(),
          on_fail: z.enum(["continue", "cancel"]),
          invocations: z.array(
            z.object({
              invocation_id: z.number().int(),
              worker_id: UlidSchema,
              batch_seq: z.number().int(),
              status: z.literal("queued"),
            }),
          ),
        }),
      ),
    },
    ...errorResponses([400, 401, 403, 404, 503]),
  },
});

const getBatchRoute = createRoute({
  method: "get",
  path: "/batch/{batchId}",
  operationId: "getBatch",
  tags: ["Workers"],
  summary: "Get the status of a sequential batch",
  description:
    "Returns all invocations in the batch ordered by sequence, with aggregate progress.",
  "x-arke-auth": "required",
  "x-arke-related": [
    "POST /workers/invoke-batch",
    "GET /workers/invocations/{invocationId}",
  ],
  "x-arke-rules": [],
  request: {
    params: z.object({
      batchId: z.string().describe("Batch ID returned from invoke-batch"),
    }),
  },
  responses: {
    200: {
      description: "Batch status",
      content: jsonContent(
        z.object({
          batch_id: z.string(),
          on_fail: z.enum(["continue", "cancel"]),
          status: z.enum(["queued", "running", "completed", "failed"]),
          progress: z.object({
            total: z.number().int(),
            completed: z.number().int(),
            failed: z.number().int(),
            cancelled: z.number().int(),
            running: z.number().int(),
            queued: z.number().int(),
          }),
          invocations: z.array(InvocationSchema),
        }),
      ),
    },
    ...errorResponses([401, 404]),
  },
});

workersRouter.openapi(invokeBatchRoute, async (c) => {
  const actor = requireActor(c);
  const body = await parseJsonBody<{
    items: Array<{ worker_id: string; prompt: string; store_log?: boolean }>;
    on_fail?: "continue" | "cancel";
  }>(c);
  const sql = createSql();

  if (!Array.isArray(body.items) || body.items.length === 0) {
    throw new ApiError(400, "invalid_body", "items must be a non-empty array");
  }
  if (body.items.length > 50) {
    throw new ApiError(400, "invalid_body", "Maximum 50 items per batch");
  }

  const onFail = body.on_fail === "cancel" ? "cancel" as const : "continue" as const;

  // Validate invoke permission for all workers before creating any records
  const uniqueWorkerIds = [...new Set(body.items.map((i) => i.worker_id))];
  await Promise.all(
    uniqueWorkerIds.map((wid) => requireWorkerInvoke(sql, actor, wid)),
  );

  const result = await enqueueBatch(
    body.items.map((i) => ({
      workerId: i.worker_id,
      prompt: i.prompt,
      storeLogs: i.store_log,
    })),
    actor.id,
    "http",
    onFail,
  );

  return c.json(
    {
      batch_id: result.batchId,
      on_fail: onFail,
      invocations: result.invocations.map((inv, idx) => ({
        invocation_id: inv.invocationId,
        worker_id: body.items[idx].worker_id,
        batch_seq: inv.batchSeq,
        status: "queued" as const,
      })),
    },
    202,
  );
});

workersRouter.openapi(getBatchRoute, async (c) => {
  const actor = requireActor(c);
  const batchId = c.req.param("batchId");
  const sql = createSql();

  const [,,,,, rows] = await sql.transaction([
    ...setActorContext(sql, actor),
    sql.query(
      `SELECT * FROM worker_invocations
       WHERE batch_id = $1
       ORDER BY batch_seq`,
      [batchId],
    ),
  ]);

  const invocations = rows as Array<Record<string, unknown>>;
  if (invocations.length === 0) {
    throw new ApiError(404, "not_found", "Batch not found");
  }

  const onFail = (invocations[0].batch_on_fail as string) === "cancel" ? "cancel" as const : "continue" as const;

  // Compute aggregate progress
  const progress = { total: 0, completed: 0, failed: 0, cancelled: 0, running: 0, queued: 0 };
  for (const inv of invocations) {
    progress.total++;
    const s = inv.status as string;
    if (s === "completed") progress.completed++;
    else if (s === "failed") progress.failed++;
    else if (s === "cancelled") progress.cancelled++;
    else if (s === "running") progress.running++;
    else progress.queued++;
  }

  // Derive batch-level status
  let batchStatus: "queued" | "running" | "completed" | "failed";
  if (progress.running > 0 || (progress.queued > 0 && progress.completed + progress.failed > 0)) {
    batchStatus = "running";
  } else if (progress.queued === progress.total) {
    batchStatus = "queued";
  } else if (progress.failed > 0) {
    batchStatus = "failed";
  } else {
    batchStatus = "completed";
  }

  return c.json(
    {
      batch_id: batchId,
      on_fail: onFail,
      status: batchStatus,
      progress,
      invocations,
    },
    200,
  );
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
  "x-arke-rules": ["Only the worker owner or a system admin may view permissions"],
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
  "x-arke-rules": ["Only the worker owner or a system admin may grant permissions"],
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
  "x-arke-rules": ["Only the worker owner or a system admin may revoke permissions"],
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
