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

export function buildOpsFromPlan(
  plan: ExtractPlan,
  documentId: string,
  opts?: WriteOpts,
): OpsEnvelopeInput {
  const ops: Array<Record<string, unknown>> = [];

  for (const entity of plan.entities) {
    ops.push({
      op: "entity",
      ref: `@${entity.ref}`,
      type: entity.type,
      label: entity.label,
      description: entity.description,
      source_document_id: documentId,
    });
  }

  for (const rel of plan.relationships) {
    ops.push({
      op: "relate",
      source: `@${rel.source_ref}`,
      target: `@${rel.target_ref}`,
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
): Promise<WriteResult> {
  let envelope = buildOpsFromPlan(plan, documentId, opts);
  let lastError: unknown = null;

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

      return writeResult;
    } catch (err) {
      lastError = err;
      const parsed = parseOpsError(err);

      // Non-retryable
      if (NON_RETRYABLE_CODES.has(parsed.code)) {
        throw err;
      }

      if (attempt >= MAX_RETRIES) break;

      // Simple retry (no LLM needed)
      if (parsed.code === "cas_conflict" || parsed.status >= 500) {
        const backoff = parsed.status >= 500 ? 1000 * (attempt + 1) : 100;
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }

      // LLM-assisted fix
      if (parsed.code === "ops_validation_failed" || parsed.code === "target_not_found") {
        try {
          const fixedOps = await llmFixOps(llm, envelope.ops, parsed.details);
          envelope = { ...envelope, ops: fixedOps };
          continue;
        } catch (fixErr) {
          console.warn(`[knowledge:write] LLM fix failed:`, fixErr instanceof Error ? fixErr.message : fixErr);
          throw err;
        }
      }

      // Unknown error — don't retry
      throw err;
    }
  }

  throw lastError;
}

// ---------------------------------------------------------------------------
// Source entity creation (for chunks — unchanged)
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
  const results = await parallelLimit(
    sources, async (source) => {
      const id = await createEntity({
        type: source.type,
        space_id: opts?.spaceId,
        read_level: opts?.readLevel,
        write_level: opts?.writeLevel,
        permissions: opts?.permissions,
        properties: {
          label: source.label,
          ...(source.text != null ? { text: source.text } : {}),
          ordinal: source.ordinal,
          source_document_id: parentEntityId,
          ...source.properties,
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
