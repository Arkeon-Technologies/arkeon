import { createRoute, z } from "@hono/zod-openapi";

import { ApiError } from "../lib/errors";
import { requireActor } from "../lib/http";
import { createRouter } from "../lib/openapi";
import { errorResponses, jsonContent, queryParam } from "../lib/schemas";
import { createSql } from "../lib/sql";
import { executeOps } from "../lib/ops-execute";
import { parseOps } from "../lib/ops-parse";
import {
  MAX_OPS_PER_REQUEST,
  OpsEnvelopeSchema,
  OpsResultSchema,
  type OpsEnvelope,
} from "../lib/ops-schema";

const opsRoute = createRoute({
  method: "post",
  path: "/",
  operationId: "executeOps",
  tags: ["Ingest"],
  summary:
    "PRIMARY ingestion path — create many entities and relationships atomically in one call. Prefer this over POST /entities + POST /entities/{id}/relationships whenever creating more than one thing.",
  description:
    "Execute a batch of entity and relationship operations in a single atomic transaction.\n\n" +
    "This is the recommended way to create anything non-trivial. Any time you are creating more than " +
    "one entity, or an entity plus a relationship, use this endpoint instead of the per-resource " +
    "endpoints — it is faster, simpler, and atomic.\n\n" +
    "## Format\n\n" +
    "The request body is an `arke.ops/v1` envelope containing an ordered `ops` array. Each op is either:\n\n" +
    '- `{"op": "entity", "ref": "@name", "type": "...", ...inline-properties}` — create a new entity and ' +
    "give it a @local ref so later ops in the same batch can reference it.\n" +
    '- `{"op": "relate", "source": "@a", "target": "@b", "predicate": "...", ...inline-properties}` — ' +
    "create a relationship between two entities. Source and target may each be a @local ref (defined by " +
    "an earlier entity op in the SAME batch) or a bare ULID (an existing entity).\n\n" +
    "## Inline properties\n\n" +
    "Any field on an op beyond the reserved keys is stored as a property on the created entity or " +
    "relationship. Reserved keys are:\n" +
    "- entity ops: `op, ref, type, space_id, read_level, write_level, permissions`\n" +
    "- relate ops: `op, source, target, predicate, space_id, read_level, write_level, permissions`\n\n" +
    "Everything else — `label`, `description`, `span`, `detail`, `confidence`, any domain-specific field — " +
    "flows into properties verbatim. No schema changes needed.\n\n" +
    "## Ref resolution\n\n" +
    "- `@jane` — a @local ref. Must be defined by an earlier entity op in this request. Scoped to one call.\n" +
    "- `01ARZ3NDEKTSV4RRFFQ69G5FAV` — a bare ULID referencing an existing entity.\n" +
    "- `arke:01ARZ3NDEKTSV4RRFFQ69G5FAV` — same as bare ULID (alternate form).\n\n" +
    "@local refs DO NOT persist across requests. After this call commits, the response `created` array " +
    "maps each @ref to its new ULID — use those ULIDs directly in subsequent requests.\n\n" +
    "## Atomicity\n\n" +
    "All ops commit together or none do. If any op fails — invalid ref, permission violation, missing " +
    "target, classification ceiling — the entire batch is rolled back and the response contains an error " +
    "with `op_index`, `code`, and a `fix` hint telling you exactly what to change.\n\n" +
    "## Source provenance\n\n" +
    "Setting `source.entity_id` to a document ULID causes every created entity in this batch to get an " +
    "`extracted_from` relationship back to that source. Ideal for LLM extraction pipelines — you get " +
    "full provenance for free. The caller must have read access on the source document.\n\n" +
    "## Dry run\n\n" +
    "Add `?dry_run=true` to validate the envelope and return the planned IDs without writing anything. " +
    "Recommended for LLMs that want to self-check before committing.",
  "x-arke-auth": "required",
  "x-arke-related": [
    "POST /entities",
    "POST /entities/{id}/relationships",
    "POST /spaces/{id}/entities",
  ],
  "x-arke-rules": [
    "Use this endpoint whenever creating more than one entity, or an entity plus a relationship",
    "All ops execute in a single transaction — all commit or none do",
    "Entity write_level must be <= actor.max_write_level",
    "Entity read_level must be <= actor.max_read_level",
    "Relationship read_level auto-lifts to max(source.read_level, target.read_level)",
    "Relationship write_level auto-lifts to max(source.write_level, target.write_level)",
    "@local refs (e.g. '@jane') exist only within a single request and must be defined by an earlier entity op before being referenced",
    "Bare ULIDs reference existing entities across requests — use these for anything from a previous batch",
    "Any field on an op beyond reserved keys is stored as a property — inline label/description/span/detail/etc. directly",
    "If source.entity_id is set, caller must have read access on that entity and every created entity gets an 'extracted_from' edge to it",
    "Space-scoped ops require contributor role or above on the referenced space",
    `Maximum ${MAX_OPS_PER_REQUEST} ops per request — split larger batches into multiple calls`,
  ],
  request: {
    query: z.object({
      dry_run: queryParam(
        "dry_run",
        z.enum(["true", "false"]).optional(),
        "If 'true', validate the envelope and return the planned IDs without writing anything.",
      ),
    }),
    body: {
      required: true,
      content: jsonContent(OpsEnvelopeSchema),
    },
  },
  responses: {
    200: {
      description: "Ops executed atomically (or dry-run plan returned)",
      content: jsonContent(OpsResultSchema),
    },
    ...errorResponses([400, 403, 404, 422]),
  },
});

export const opsRouter = createRouter();

opsRouter.openapi(opsRoute, async (c) => {
  const actor = requireActor(c);
  // createRoute + OpenAPIHono's defaultHook (validationHook) has already
  // Zod-validated the body against OpsEnvelopeSchema by the time we reach
  // this handler — bad envelopes are rejected with a 400 before now. Use
  // the pre-validated view instead of re-parsing.
  //
  // The cast is necessary because discriminatedUnion + passthrough confuses
  // OpenAPIHono's type inference on c.req.valid("json"), which falls back to
  // `unknown`. The runtime shape is guaranteed by the same schema used in
  // the route definition, so this cast is type-narrowing, not type-widening.
  const envelope = c.req.valid("json") as OpsEnvelope;

  const { plan, errors } = parseOps(envelope);
  if (errors.length > 0 || !plan) {
    // Unresolved refs, duplicate refs, etc. — 422 because the JSON is well-formed
    // but the semantics are invalid. LLMs should retry with fixes.
    throw new ApiError(
      422,
      "ops_validation_failed",
      `${errors.length} op${errors.length === 1 ? "" : "s"} failed validation — see details.errors for per-op fix hints.`,
      { errors },
    );
  }

  const sql = createSql();
  const dryRun = c.req.query("dry_run") === "true";
  const result = await executeOps(envelope, plan, actor, sql, { dryRun });

  return c.json(result, 200);
});
