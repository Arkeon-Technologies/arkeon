// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared extraction pipeline tail: materialize → ops submit (with retry) → consolidate.
 * Every job type prepares an ExtractPlan and hands off here.
 *
 * The resolve and rewrite steps have been replaced by deterministic upsert
 * via POST /ops with upsert_on: ["label", "type"]. Post-write deduplication
 * is handled by a debounced space-level consolidation job (see consolidate.ts).
 */

import { LlmClient } from "../lib/llm";
import { resolveLlmConfig } from "../lib/config";
import { appendLog } from "../lib/logger";
import type { ExtractPlan } from "../lib/types";

import { materializeShellEntities } from "./materialize";
import { submitOpsWithRetry } from "./write";

export interface PipelineOpts {
  jobId: string;
  documentId: string;
  spaceId?: string;
  readLevel?: number;
  writeLevel?: number;
  ownerId?: string;
  permissions?: Array<{ grantee_type: string; grantee_id: string; role: string }>;
  /** Known existing entity IDs from scout — used to validate ULID refs in the extraction plan */
  knownEntityIds?: Set<string>;
}

export interface PipelineResult {
  extractedEntities: number;
  extractedRelationships: number;
  createdEntities: number;
  updatedEntities: number;
  createdRelationships: number;
  mergedDuplicates: number;
  createdEntityIds: string[];
  refToId: Record<string, string>;
  usage: { model: string; tokensIn: number; tokensOut: number; llmCalls: number };
}

const ZERO_RESULT: PipelineResult = {
  extractedEntities: 0,
  extractedRelationships: 0,
  createdEntities: 0,
  updatedEntities: 0,
  createdRelationships: 0,
  mergedDuplicates: 0,
  createdEntityIds: [],
  refToId: {},
  usage: { model: "", tokensIn: 0, tokensOut: 0, llmCalls: 0 },
};

/**
 * Run the extraction pipeline tail on an ExtractPlan.
 * Does NOT manage job status — callers handle setJobStatus/tryFinalizeParent.
 */
export async function runExtractionPipeline(
  plan: ExtractPlan,
  opts: PipelineOpts,
): Promise<PipelineResult> {
  const { jobId, documentId, spaceId } = opts;

  if (plan.entities.length === 0) {
    appendLog(jobId, "info", "No entities in plan, skipping pipeline");
    return ZERO_RESULT;
  }

  // Materialize shell entities
  const materializedPlan = materializeShellEntities(plan);
  appendLog(jobId, "info", `After materialize: ${materializedPlan.entities.length} entities, ${materializedPlan.relationships.length} relationships`);

  // Submit ops with upsert + retry
  const resolverConfig = await resolveLlmConfig("resolver");
  const resolverLlm = new LlmClient(resolverConfig);

  appendLog(jobId, "info", "Writing to graph via ops upsert");
  const writeResult = await submitOpsWithRetry(materializedPlan, documentId, {
    spaceId: opts.spaceId,
    readLevel: opts.readLevel,
    writeLevel: opts.writeLevel,
    ownerId: opts.ownerId,
    permissions: opts.permissions,
  }, resolverLlm, opts.knownEntityIds);
  appendLog(jobId, "info", `Written: ${writeResult.createdEntityIds.length} created, ${writeResult.updatedEntityIds.length} updated, ${writeResult.createdRelationshipIds.length} relationships`);

  // Trigger space-level consolidation instead of per-entity dedupe.
  // The consolidate job debounces and batches all recently extracted
  // entities in the space for holistic merge analysis.
  if (writeResult.createdEntityIds.length > 0 && spaceId) {
    const { ensureConsolidateJob } = await import("../queue");
    appendLog(jobId, "info", `Triggering consolidation for space ${spaceId}`);
    await ensureConsolidateJob(spaceId);
  }

  return {
    extractedEntities: materializedPlan.entities.length,
    extractedRelationships: materializedPlan.relationships.length,
    createdEntities: writeResult.createdEntityIds.length,
    updatedEntities: writeResult.updatedEntityIds.length,
    createdRelationships: writeResult.createdRelationshipIds.length,
    // mergedDuplicates is always 0 here — dedup now runs in a separate
    // consolidate job (per-space, debounced) which tracks its own merge
    // counts and LLM usage in its own job result.
    mergedDuplicates: 0,
    createdEntityIds: writeResult.createdEntityIds,
    refToId: writeResult.refToId,
    // No LLM calls in this pipeline tail anymore. The extract step (caller)
    // tracks its own usage; consolidation tracks its own.
    usage: { model: "", tokensIn: 0, tokensOut: 0, llmCalls: 0 },
  };
}
