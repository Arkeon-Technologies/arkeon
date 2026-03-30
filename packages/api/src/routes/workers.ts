import { createRoute, z } from "@hono/zod-openapi";

import { ApiError } from "../lib/errors";
import { requireActor, parseJsonBody } from "../lib/http";
import { createRouter } from "../lib/openapi";
import { encrypt, keyHint } from "../lib/crypto";
import { invokeWorker } from "../lib/worker-invoke";
import { syncWorkerSchedule } from "../lib/scheduler";
import {
  ActorSchema,
  ClassificationLevel,
  WorkerConfigSchema,
  entityIdParams,
  errorResponses,
  jsonContent,
  JsonObjectSchema,
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
  const body = await parseJsonBody<{ prompt: string }>(c);
  const sql = createSql();

  if (!body.prompt || typeof body.prompt !== "string") {
    throw new ApiError(400, "missing_required_field", "prompt is required");
  }

  // Owner check
  const worker = await requireWorker(sql, actor, workerId);

  try {
    const result = await invokeWorker(workerId, body.prompt);
    return c.json(result, 200);
  } catch (err) {
    if (err instanceof Error && err.message.includes("timed out")) {
      throw new ApiError(408, "timeout", "Worker execution timed out");
    }
    throw err;
  }
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

  const [,,,, rows] = await sql.transaction([
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
