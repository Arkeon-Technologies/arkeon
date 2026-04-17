// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Write extracted entities and relationships to the graph via POST /ops.
 * Uses upsert_on: ["label", "type"] for deterministic deduplication.
 * source.entity_id auto-creates extracted_from edges for provenance.
 *
 * Also handles creating chunk entities for large-document extraction
 * (writeSourceEntities) which still uses individual API calls.
 */

import {
  createEntity,
  createRelationship,
  transferOwnership,
  submitOpsEnvelope,
  ArkeError,
  type OpsEnvelopeInput,
  type OpsResult,
} from "../lib/arke-client";
import { withAdminSql } from "../lib/admin-sql";
import { LlmClient } from "../lib/llm";
import type { ExtractPlan, WriteResult } from "../lib/types";

const WRITE_CONCURRENCY = 10;

async function parallelLimit<T, R>(items: T[], fn: (item: T) => Promise<R>, limit: number): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += limit) {
    const chunk = items.slice(i, i + limit);
    const chunkResults = await Promise.all(chunk.map(fn));
    results.push(...chunkResults);
  }
  return results;
}

export interface WriteOpts {
  spaceId?: string;
  readLevel?: number;
  writeLevel?: number;
  ownerId?: string;
  permissions?: Array<{ grantee_type: string; grantee_id: string; role: string }>;
}

// ---------------------------------------------------------------------------
// Build ops envelope from ExtractPlan
// ---------------------------------------------------------------------------

// ULID pattern: 26 uppercase Crockford base32 characters
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

/** Exported for testing */
export function isUlid(ref: string): boolean {
  return ULID_RE.test(ref);
}

export function buildOpsFromPlan(
  plan: ExtractPlan,
  documentId: string,
  opts?: WriteOpts,
  /** Set of known existing entity IDs (from scout). ULID refs not in this set are treated as new entities to prevent hallucinated refs from silently dropping. */
  knownEntityIds?: Set<string>,
): OpsEnvelopeInput {
  const ops: Array<Record<string, unknown>> = [];

  for (const entity of plan.entities) {
    // Skip entities that reference existing graph entities (ULID refs from scout).
    // Only skip if the ID is in the known set — a hallucinated ULID-shaped ref
    // that isn't in knownEntityIds gets treated as a new entity with @ref.
    if (isUlid(entity.ref) && knownEntityIds?.has(entity.ref)) {
      continue;
    }

    ops.push({
      op: "entity",
      ref: `@${entity.ref}`,
      ...entity.properties,
      type: entity.type,
      label: entity.label,
      description: entity.description,
      source_document_id: documentId,
    });
  }

  for (const rel of plan.relationships) {
    // Use raw ULID for known existing entities, @ref for new local entities
    const sourceIsKnown = isUlid(rel.source_ref) && knownEntityIds?.has(rel.source_ref);
    const targetIsKnown = isUlid(rel.target_ref) && knownEntityIds?.has(rel.target_ref);
    const source = sourceIsKnown ? rel.source_ref : `@${rel.source_ref}`;
    const target = targetIsKnown ? rel.target_ref : `@${rel.target_ref}`;

    ops.push({
      op: "relate",
      ...rel.properties,
      source,
      target,
      predicate: rel.predicate,
      ...(rel.source_span ? { span: rel.source_span } : {}),
      ...(rel.detail ? { detail: rel.detail } : {}),
      source_document_id: documentId,
    });
  }

  return {
    format: "arke.ops/v1",
    defaults: {
      space_id: opts?.spaceId,
      upsert_on: ["label", "type"],
      read_level: opts?.readLevel,
      write_level: opts?.writeLevel,
      permissions: opts?.permissions,
    },
    source: { entity_id: documentId },
    ops,
  };
}

// ---------------------------------------------------------------------------
// Map OpsResult back to WriteResult
// ---------------------------------------------------------------------------

function mapOpsResult(result: OpsResult): WriteResult {
  const refToId: Record<string, string> = {};
  const createdEntityIds: string[] = [];
  const updatedEntityIds: string[] = [];
  const createdRelationshipIds: string[] = [];

  for (const entity of result.entities) {
    const ref = entity.ref.startsWith("@") ? entity.ref.slice(1) : entity.ref;
    refToId[ref] = entity.id;
    if (entity.action === "created") {
      createdEntityIds.push(entity.id);
    } else {
      updatedEntityIds.push(entity.id);
    }
  }

  for (const edge of result.edges) {
    createdRelationshipIds.push(edge.id);
  }

  return { createdEntityIds, updatedEntityIds, createdRelationshipIds, refToId };
}

// ---------------------------------------------------------------------------
// Error classification for retry
// ---------------------------------------------------------------------------

interface OpsError {
  code: string;
  status: number;
  message: string;
  details: any;
}

function parseOpsError(err: unknown): OpsError {
  if (err instanceof ArkeError) {
    return {
      code: err.code ?? "unknown",
      status: err.status,
      message: err.message,
      details: err.details ?? {},
    };
  }
  return {
    code: "unknown",
    status: 500,
    message: err instanceof Error ? err.message : String(err),
    details: {},
  };
}

const NON_RETRYABLE_CODES = new Set(["forbidden", "invalid_classification"]);

// ---------------------------------------------------------------------------
// LLM-assisted ops fix
// ---------------------------------------------------------------------------

const FIX_OPS_PROMPT = `You are fixing a failed ops batch for a knowledge graph.

The following ops batch was submitted but failed. Fix the errors and return only the corrected ops array.

Rules:
- Fix only the specific errors listed
- Do not add new entities or relationships unless an error requires it
- For target_not_found: remove the relate op that references the missing entity
- For unresolved_ref: ensure the referenced entity op exists before the relate op, or remove the dangling relate op
- For duplicate_ref: rename the duplicate ref to be unique
- For self_reference: the source and target of a relate op cannot resolve to the same entity. Either remove the op entirely or change one side to reference a different entity
- For invalid_ref_format: the ref doesn't match the @local or ULID pattern — either drop the op or replace the ref with a valid one
- For missing_required_field: add the missing field with a reasonable value, or drop the op if the field can't be inferred
- Return JSON: { "ops": [...corrected ops...] }`;

async function llmFixOps(
  llm: LlmClient,
  ops: Array<Record<string, unknown>>,
  errorDetails: any,
): Promise<Array<Record<string, unknown>>> {
  const result = await llm.chatJson<{ ops: Array<Record<string, unknown>> }>(
    FIX_OPS_PROMPT,
    JSON.stringify({ errors: errorDetails, ops }, null, 2),
    { maxTokens: 16_384 },
  );

  if (!Array.isArray(result.data?.ops)) {
    throw new Error("LLM fix did not return a valid ops array");
  }
  return result.data.ops;
}

// ---------------------------------------------------------------------------
// Submit ops with retry loop
// ---------------------------------------------------------------------------

const MAX_RETRIES = 2;

export async function submitOpsWithRetry(
  plan: ExtractPlan,
  documentId: string,
  opts: WriteOpts | undefined,
  llm: LlmClient,
  knownEntityIds?: Set<string>,
): Promise<WriteResult> {
  let envelope = buildOpsFromPlan(plan, documentId, opts, knownEntityIds);
  let lastError: unknown = null;

  // Per-job retry telemetry — so we can see how hard each write is working
  const attemptHistory: Array<{
    attempt: number;
    outcome: "success" | "non_retryable" | "retried_backoff" | "retried_llm_fix" | "retried_llm_fix_exhausted" | "non_retryable_unknown" | "abandoned_max_attempts";
    errorCode?: string;
    errorCount?: number;
    fixDelta?: { opsBefore: number; opsAfter: number };
  }> = [];
  const startedAt = Date.now();

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await submitOpsEnvelope(envelope);
      const writeResult = mapOpsResult(result);

      // Transfer ownership from service actor to source document's owner
      if (opts?.ownerId && writeResult.createdEntityIds.length > 0) {
        await parallelLimit(
          writeResult.createdEntityIds,
          (id) => transferOwnership(id, opts.ownerId!).catch((err) => {
            console.warn(`[knowledge:write] Failed to transfer ownership for ${id}:`, err instanceof Error ? err.message : err);
          }),
          WRITE_CONCURRENCY,
        );
      }

      attemptHistory.push({ attempt, outcome: "success" });
      if (attempt > 0) {
        const dur = Date.now() - startedAt;
        console.warn(`[knowledge:write:retry] doc=${documentId} SUCCESS after ${attempt + 1} attempts (${dur}ms)  history=${JSON.stringify(attemptHistory)}`);
      }
      return writeResult;
    } catch (err) {
      lastError = err;
      const parsed = parseOpsError(err);

      // Non-retryable
      if (NON_RETRYABLE_CODES.has(parsed.code)) {
        attemptHistory.push({ attempt, outcome: "non_retryable", errorCode: parsed.code });
        console.warn(`[knowledge:write:retry] doc=${documentId} GAVE UP on attempt ${attempt} (non-retryable code=${parsed.code})  history=${JSON.stringify(attemptHistory)}`);
        throw err;
      }

      if (attempt >= MAX_RETRIES) {
        attemptHistory.push({ attempt, outcome: "abandoned_max_attempts", errorCode: parsed.code });
        break;
      }

      // Simple retry (no LLM needed)
      if (parsed.code === "cas_conflict" || parsed.status >= 500) {
        const backoff = parsed.status >= 500 ? 1000 * (attempt + 1) : 100;
        attemptHistory.push({ attempt, outcome: "retried_backoff", errorCode: parsed.code });
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }

      // LLM-assisted fix
      if (parsed.code === "ops_validation_failed" || parsed.code === "target_not_found") {
        const errs = (parsed.details?.errors ?? []) as Array<Record<string, unknown>>;

        // Log the specific errors + the ops that triggered them (LLM's prior output)
        console.warn(`[knowledge:write:retry] doc=${documentId} attempt ${attempt} validation failed — ${errs.length} error(s), code=${parsed.code}:`);
        for (const e of errs.slice(0, 10)) {
          const idx = e.op_index as number | undefined;
          const op = typeof idx === "number" ? envelope.ops[idx] : undefined;
          console.warn(`    [${e.code}] field=${e.field} offending=${JSON.stringify(e.offending_value)} msg="${e.message}"`);
          if (op) console.warn(`      prior_op: ${JSON.stringify(op).slice(0, 400)}`);
        }
        if (errs.length > 10) console.warn(`    ... (${errs.length - 10} more errors elided)`);

        try {
          const opsBefore = envelope.ops.length;
          const fixedOps = await llmFixOps(llm, envelope.ops, parsed.details);
          const opsAfter = fixedOps.length;
          console.warn(`[knowledge:write:retry] doc=${documentId} fix-LLM returned ${opsAfter} ops (was ${opsBefore}, Δ=${opsAfter - opsBefore})`);
          envelope = { ...envelope, ops: fixedOps };
          attemptHistory.push({
            attempt,
            outcome: "retried_llm_fix",
            errorCode: parsed.code,
            errorCount: errs.length,
            fixDelta: { opsBefore, opsAfter },
          });
          continue;
        } catch (fixErr) {
          attemptHistory.push({ attempt, outcome: "retried_llm_fix_exhausted", errorCode: parsed.code, errorCount: errs.length });
          console.warn(`[knowledge:write:retry] doc=${documentId} LLM fix FAILED on attempt ${attempt}: ${fixErr instanceof Error ? fixErr.message : fixErr}  history=${JSON.stringify(attemptHistory)}`);
          throw err;
        }
      }

      // Unknown error — don't retry
      attemptHistory.push({ attempt, outcome: "non_retryable_unknown", errorCode: parsed.code });
      console.warn(`[knowledge:write:retry] doc=${documentId} unknown error on attempt ${attempt}, not retrying (code=${parsed.code})  history=${JSON.stringify(attemptHistory)}`);
      throw err;
    }
  }

  // Fell out of the loop — we exhausted attempts without success or an immediate throw
  const dur = Date.now() - startedAt;
  console.warn(`[knowledge:write:retry] doc=${documentId} EXHAUSTED after ${MAX_RETRIES + 1} attempts (${dur}ms)  history=${JSON.stringify(attemptHistory)}`);

  throw lastError;
}

// ---------------------------------------------------------------------------
// Source entity creation (for chunks — idempotent via delete-and-recreate)
// ---------------------------------------------------------------------------

export interface SourceEntityDef {
  label: string;
  type: string;
  ordinal: number;
  text?: string;
  properties?: Record<string, unknown>;
}

export async function writeSourceEntities(
  sources: SourceEntityDef[],
  parentEntityId: string,
  opts?: WriteOpts,
): Promise<{ sourceEntityIds: string[] }> {
  // Delete any existing chunks for this parent before creating new ones.
  // This makes chunk creation idempotent — re-ingesting the same doc
  // replaces chunks instead of duplicating them. FK ON DELETE CASCADE
  // cleans up relationships, activity, and versions automatically.
  const deleted = await withAdminSql(async (sql) => {
    const rows = await sql.query(
      `DELETE FROM entities
       WHERE type = 'text_chunk'
         AND properties->>'source_document_id' = $1
       RETURNING id`,
      [parentEntityId],
    );
    return rows.length;
  });
  if (deleted > 0) {
    console.log(`[knowledge:write] Deleted ${deleted} stale chunk(s) for parent ${parentEntityId}`);
  }

  const results = await parallelLimit(
    sources, async (source) => {
      const id = await createEntity({
        type: source.type,
        space_id: opts?.spaceId,
        read_level: opts?.readLevel,
        write_level: opts?.writeLevel,
        permissions: opts?.permissions,
        properties: {
          ...source.properties,
          label: source.label,
          ...(source.text != null ? { text: source.text } : {}),
          ordinal: source.ordinal,
          source_document_id: parentEntityId,
        },
      });

      if (id) {
        await createRelationship(id, {
          predicate: "part_of",
          target_id: parentEntityId,
          space_id: opts?.spaceId,
        }).catch(() => {});
      }

      return id;
    }, WRITE_CONCURRENCY);

  if (opts?.ownerId) {
    const ids = results.filter((id): id is string => !!id);
    await parallelLimit(
      ids, (id) => transferOwnership(id, opts.ownerId!).catch(() => {}),
      WRITE_CONCURRENCY,
    );
  }

  return { sourceEntityIds: results.filter((id): id is string => !!id) };
}
