import { createRoute, z } from "@hono/zod-openapi";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Agent } from "../../../runtime/src/agent.js";

import { ApiError } from "../lib/errors";
import { requireActor, parseJsonBody } from "../lib/http";
import { createRouter } from "../lib/openapi";
import { decrypt, encrypt, keyHint } from "../lib/crypto";
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

  const worker = await requireWorker(sql, actor, workerId);
  const props = worker.properties as unknown as WorkerProperties;

  if (!props.llm?.api_key_encrypted || !props.arke_key_encrypted) {
    throw new ApiError(400, "invalid_body", "Worker is missing encryption keys — recreate it");
  }

  const llmApiKey = await decrypt(props.llm.api_key_encrypted);
  const arkeApiKey = await decrypt(props.arke_key_encrypted);
  const apiBaseUrl = process.env.API_BASE_URL ?? `http://localhost:${process.env.PORT ?? 8000}`;

  const workspace = mkdtempSync(join(tmpdir(), `arke-worker-${workerId}-`));

  // Build system prompt with network access info
  const fullSystemPrompt = [
    props.system_prompt,
    "",
    "You have access to the Arke network.",
    `Environment variables $ARKE_API_URL and $ARKE_API_KEY are set.`,
    `For direct API access: curl -H "Authorization: ApiKey $ARKE_API_KEY" $ARKE_API_URL/llms.txt`,
    "When done, call the done tool with a summary.",
  ].join("\n");

  const agent = new Agent({
    name: props.name ?? workerId,
    systemPrompt: fullSystemPrompt,
    llm: {
      baseUrl: props.llm.base_url,
      apiKey: llmApiKey,
      model: props.llm.model,
    },
    sandbox: {
      workspaceDir: workspace,
      memoryMb: props.resource_limits?.memory_mb ?? 256,
      cpuPercent: props.resource_limits?.cpu_percent ?? 50,
      maxPids: props.resource_limits?.max_pids ?? 128,
      env: {
        ARKE_API_URL: apiBaseUrl,
        ARKE_API_KEY: arkeApiKey,
      },
    },
    maxIterations: props.max_iterations ?? 50,
  });

  const timeoutMs = props.resource_limits?.timeout_ms ?? 300_000;

  try {
    const result = await Promise.race([
      agent.run(body.prompt),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new ApiError(408, "timeout", "Worker execution timed out")),
          timeoutMs,
        ),
      ),
    ]);

    return c.json(
      {
        success: result.success,
        summary: result.summary,
        iterations: result.iterations,
      },
      200,
    );
  } finally {
    try {
      rmSync(workspace, { recursive: true, force: true });
    } catch {
      // Best effort cleanup
    }
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

  return c.json(
    {
      actor: updated,
      config: redactProperties(updated.properties),
    },
    200,
  );
});
