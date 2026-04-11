// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Knowledge extraction API routes.
 * Mounted at /knowledge/* on the main API.
 *
 * Permissions:
 *   Config (GET/PUT/DELETE) — admin only
 *   Ingest (POST)           — any authenticated actor
 *   Jobs (GET list)         — admin sees all, others see own triggered jobs
 *   Jobs (GET detail)       — admin or the triggering actor
 *   Usage (GET)             — admin only
 */

import { createRoute, z } from "@hono/zod-openapi";
import { createRouter } from "../lib/openapi";
import { requireActor, requireAdmin } from "../lib/http";
import { ApiError } from "../lib/errors";
import { createSql } from "../lib/sql";
import { setActorContext } from "../lib/actor-context";
import {
  listLlmConfigs,
  saveLlmConfig,
  deleteLlmConfig,
  getExtractionConfig,
  saveExtractionConfig,
} from "./lib/config";
import { withAdminSql } from "./lib/admin-sql";
import { getJobLogs, getTokenUsage } from "./lib/logger";
import { createJob } from "./queue";

export const knowledgeRouter = createRouter();

// ---------------------------------------------------------------------------
// GET /knowledge/config — admin only
// ---------------------------------------------------------------------------

const getConfigRoute = createRoute({
  method: "get",
  path: "/config",
  operationId: "getKnowledgeConfig",
  tags: ["Knowledge"],
  summary: "Get knowledge extraction configuration",
  "x-arke-rules": ["Admin only"],
  responses: {
    200: {
      description: "LLM configs and extraction rules",
      content: { "application/json": { schema: z.object({ llm: z.array(z.any()), extraction: z.any() }) } },
    },
  },
});

knowledgeRouter.openapi(getConfigRoute, async (c) => {
  requireAdmin(c);
  const llm = await listLlmConfigs();
  const extraction = await getExtractionConfig();
  return c.json({ llm, extraction });
});

// ---------------------------------------------------------------------------
// PUT /knowledge/config — admin only
// ---------------------------------------------------------------------------

const llmConfigValueSchema = z.object({
  provider: z.string(),
  // Required: every provider must declare its OpenAI-compatible base URL.
  // No defaults — see packages/api/src/knowledge/lib/config.ts.
  base_url: z.string().url(),
  // Optional only on update: lets callers tweak model/base_url without
  // re-supplying the key. resolveLlmConfig refuses to return a config
  // unless a key has been stored at some point.
  api_key: z.string().optional(),
  model: z.string(),
  max_tokens: z.number().optional(),
});

const putConfigBodySchema = z.object({
  llm: z.record(z.string(), llmConfigValueSchema).optional(),
  extraction: z.object({
    entity_types: z.array(z.string()).optional(),
    strict_entity_types: z.boolean().optional(),
    predicates: z.array(z.string()).optional(),
    strict_predicates: z.boolean().optional(),
    custom_instructions: z.string().nullable().optional(),
    max_concurrency: z.number().min(1).max(50).optional(),
    target_chunk_chars: z.number().min(2000).max(100000).optional(),
    scope_to_space: z.boolean().optional(),
  }).optional(),
});

const putConfigRoute = createRoute({
  method: "put",
  path: "/config",
  operationId: "updateKnowledgeConfig",
  tags: ["Knowledge"],
  summary: "Update knowledge extraction configuration",
  "x-arke-rules": ["Admin only"],
  request: {
    body: { content: { "application/json": { schema: putConfigBodySchema } } },
  },
  responses: {
    200: {
      description: "Updated configuration",
      content: { "application/json": { schema: z.object({ llm: z.array(z.any()), extraction: z.any() }) } },
    },
  },
});

knowledgeRouter.openapi(putConfigRoute, async (c) => {
  requireAdmin(c);
  const body = c.req.valid("json");

  if (body.llm) {
    for (const [id, config] of Object.entries(body.llm) as [string, z.infer<typeof llmConfigValueSchema>][]) {
      await saveLlmConfig(id, {
        provider: config.provider,
        base_url: config.base_url,
        api_key: config.api_key,
        model: config.model,
        max_tokens: config.max_tokens,
      });
    }
  }

  if (body.extraction) {
    await saveExtractionConfig(body.extraction);
  }

  const llm = await listLlmConfigs();
  const extraction = await getExtractionConfig();
  return c.json({ llm, extraction });
});

// ---------------------------------------------------------------------------
// DELETE /knowledge/config/:id — admin only
// ---------------------------------------------------------------------------

const deleteConfigRoute = createRoute({
  method: "delete",
  path: "/config/{id}",
  operationId: "deleteKnowledgeLlmConfig",
  tags: ["Knowledge"],
  summary: "Delete an LLM configuration",
  "x-arke-rules": ["Admin only"],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: { description: "Deleted", content: { "application/json": { schema: z.object({ deleted: z.boolean() }) } } },
  },
});

knowledgeRouter.openapi(deleteConfigRoute, async (c) => {
  requireAdmin(c);
  const { id } = c.req.valid("param");
  const deleted = await deleteLlmConfig(id);
  return c.json({ deleted });
});

// ---------------------------------------------------------------------------
// POST /knowledge/ingest — any authenticated actor
// ---------------------------------------------------------------------------

const ingestBodySchema = z.object({
  entity_ids: z.array(z.string()).min(1).max(100),
});

const ingestRoute = createRoute({
  method: "post",
  path: "/ingest",
  operationId: "ingestKnowledge",
  tags: ["Knowledge"],
  summary: "Manually trigger knowledge extraction for entities. Not needed after upload — content uploads are auto-ingested. Use this to re-extract or retry.",
  "x-arke-rules": ["Requires authentication", "Entities must be visible to the requesting actor"],
  request: {
    body: { content: { "application/json": { schema: ingestBodySchema } } },
  },
  responses: {
    200: {
      description: "Jobs created",
      content: {
        "application/json": {
          schema: z.object({
            jobs: z.array(z.object({
              entity_id: z.string(),
              job_id: z.string().nullable(),
              status: z.enum(["queued", "duplicate"]),
            })),
          }),
        },
      },
    },
  },
});

knowledgeRouter.openapi(ingestRoute, async (c) => {
  const actor = requireActor(c);
  const { entity_ids } = c.req.valid("json");
  const sql = createSql();

  const jobs: Array<{ entity_id: string; job_id: string | null; status: "queued" | "duplicate" }> = [];

  for (const entityId of entity_ids) {
    const results = await sql.transaction([
      ...setActorContext(sql, actor),
      sql`SELECT id, ver FROM entities WHERE id = ${entityId} AND kind = 'entity'`,
    ]);
    const [entity] = results[results.length - 1] as Array<Record<string, unknown>>;

    if (!entity) {
      throw new ApiError(404, "not_found", `Entity ${entityId} not found`);
    }

    const jobId = await createJob({ entityId, entityVer: entity.ver as number, trigger: "manual", triggeredBy: actor.id });
    jobs.push({
      entity_id: entityId,
      job_id: jobId,
      status: jobId ? "queued" : "duplicate",
    });
  }

  return c.json({ jobs });
});

// ---------------------------------------------------------------------------
// GET /knowledge/jobs — admin sees all, others see own
// ---------------------------------------------------------------------------

const listJobsRoute = createRoute({
  method: "get",
  path: "/jobs",
  operationId: "listKnowledgeJobs",
  tags: ["Knowledge"],
  summary: "List knowledge extraction jobs",
  "x-arke-rules": ["Admin sees all jobs", "Non-admin sees only jobs they triggered"],
  request: {
    query: z.object({
      status: z.enum(["pending", "processing", "completed", "failed"]).optional(),
      entity_id: z.string().optional(),
      limit: z.string().optional(),
      offset: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "Job list",
      content: { "application/json": { schema: z.object({ jobs: z.array(z.any()), total: z.number() }) } },
    },
  },
});

knowledgeRouter.openapi(listJobsRoute, async (c) => {
  const actor = requireActor(c);
  const { status, entity_id, limit: limitStr, offset: offsetStr } = c.req.valid("query");
  const sql = createSql();
  const limit = Math.min(Number(limitStr) || 50, 100);
  const offset = Number(offsetStr) || 0;

  const conditions: string[] = [];
  const params: unknown[] = [];

  // Non-admin users can only see jobs they triggered
  if (!actor.isAdmin) {
    params.push(actor.id);
    conditions.push(`triggered_by = $${params.length}`);
  }

  if (status) {
    params.push(status);
    conditions.push(`status = $${params.length}`);
  }
  if (entity_id) {
    params.push(entity_id);
    conditions.push(`entity_id = $${params.length}`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const jobParams = [...params, limit, offset];

  // setActorContext + count + select all run on the same connection so
  // RLS sees the actor GUCs set in the same transaction. Separate awaits
  // would each get a fresh pooled connection — see admin-sql.ts.
  const txResults = await sql.transaction([
    ...setActorContext(sql, actor),
    sql.query(`SELECT COUNT(*)::int AS total FROM knowledge_jobs ${where}`, params),
    sql.query(
      `SELECT id, entity_id, entity_ver, status, trigger, triggered_by, job_type, parent_job_id,
              attempts, result, error, model, tokens_in, tokens_out, llm_calls,
              created_at, started_at, completed_at
       FROM knowledge_jobs ${where}
       ORDER BY created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      jobParams,
    ),
  ]);

  const countRow = (txResults[txResults.length - 2] as Array<{ total: number }>)[0];
  const jobs = txResults[txResults.length - 1] as Array<Record<string, unknown>>;

  return c.json({
    jobs: jobs.map((j) => ({
      id: j.id,
      entity_id: j.entity_id,
      entity_ver: j.entity_ver,
      status: j.status,
      trigger: j.trigger,
      triggered_by: j.triggered_by,
      job_type: j.job_type,
      parent_job_id: j.parent_job_id,
      attempts: j.attempts,
      result: j.result,
      error: j.error,
      model: j.model,
      tokens_in: j.tokens_in,
      tokens_out: j.tokens_out,
      llm_calls: j.llm_calls,
      created_at: j.created_at,
      started_at: j.started_at,
      completed_at: j.completed_at,
    })),
    total: (countRow?.total as number) ?? 0,
  });
});

// ---------------------------------------------------------------------------
// GET /knowledge/jobs/:id — admin or triggering actor
// ---------------------------------------------------------------------------

const getJobRoute = createRoute({
  method: "get",
  path: "/jobs/{id}",
  operationId: "getKnowledgeJob",
  tags: ["Knowledge"],
  summary: "Get knowledge extraction job details with logs",
  "x-arke-rules": ["Admin or triggering actor only"],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "Job with logs",
      content: { "application/json": { schema: z.object({ job: z.any(), logs: z.array(z.any()) }) } },
    },
  },
});

knowledgeRouter.openapi(getJobRoute, async (c) => {
  const actor = requireActor(c);
  const { id } = c.req.valid("param");

  // Look up the job in admin context so we can return a precise 403 to a
  // non-admin asking about someone else's job (instead of a leaky 404).
  // Without the admin context the RLS policy on knowledge_jobs would
  // already filter the row out, and the app-layer check below would be
  // dead code. The actual visibility decision lives in this handler.
  const job = await withAdminSql(async (sql) => {
    const rows = await sql.query(
      `SELECT id, entity_id, entity_ver, status, trigger, triggered_by, job_type, parent_job_id,
              attempts, max_attempts, result, error, model, tokens_in, tokens_out, llm_calls,
              created_at, started_at, completed_at
       FROM knowledge_jobs
       WHERE id = $1`,
      [id],
    );
    return rows[0] as Record<string, unknown> | undefined;
  });

  if (!job) {
    throw new ApiError(404, "not_found", `Job ${id} not found`);
  }

  // Non-admin can only see their own jobs
  if (!actor.isAdmin && job.triggered_by !== actor.id) {
    throw new ApiError(403, "forbidden", "You can only view jobs you triggered");
  }

  const logs = await getJobLogs(id);

  return c.json({ job, logs });
});

// ---------------------------------------------------------------------------
// GET /knowledge/usage — admin only
// ---------------------------------------------------------------------------

const usageRoute = createRoute({
  method: "get",
  path: "/usage",
  operationId: "getKnowledgeUsage",
  tags: ["Knowledge"],
  summary: "Get knowledge extraction token usage",
  "x-arke-rules": ["Admin only"],
  request: {
    query: z.object({
      from: z.string().optional(),
      to: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "Token usage summary",
      content: { "application/json": { schema: z.any() } },
    },
  },
});

knowledgeRouter.openapi(usageRoute, async (c) => {
  requireAdmin(c);
  const { from, to } = c.req.valid("query");
  const now = new Date();
  const fromDate = from ?? new Date(now.getTime() - 30 * 86400000).toISOString().slice(0, 10);
  const toDate = to ?? now.toISOString().slice(0, 10);

  const usage = await getTokenUsage({ from: fromDate, to: toDate });
  return c.json(usage);
});
