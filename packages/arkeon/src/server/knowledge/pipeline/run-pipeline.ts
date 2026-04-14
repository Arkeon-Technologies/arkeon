// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared extraction pipeline tail: materialize → ops submit (with retry) → dedupe.
 * Every job type prepares an ExtractPlan and hands off here.
 *
 * The resolve and rewrite steps have been replaced by deterministic upsert
 * via POST /ops with upsert_on: ["label", "type"]. Post-write LLM dedupe
 * remains for fuzzy matching.
 */

import { LlmClient, type LlmUsage } from "../lib/llm";
import { resolveLlmConfig, getExtractionConfig } from "../lib/config";
import { appendLog } from "../lib/logger";
import type { ExtractPlan } from "../lib/types";

import { materializeShellEntities } from "./materialize";
import { submitOpsWithRetry } from "./write";
import { dedupeEntities } from "./dedupe";

export interface PipelineOpts {
  jobId: string;
  documentId: string;
  spaceId?: string;
  readLevel?: number;
  writeLevel?: number;
  ownerId?: string;
  permissions?: Array<{ grantee_type: string; grantee_id: string; role: string }>;
}

export interface PipelineResult {
  extractedEntities: number;
  extractedRelationships: number;
  createdEntities: number;
  updatedEntities: number;
  createdRelationships: number;
  potentialDuplicates: number;
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
  potentialDuplicates: 0,
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

  let tokensIn = 0;
  let tokensOut = 0;
  let llmCalls = 0;
  let model = "";

  function trackUsage(usage: LlmUsage) {
    if (!model && usage.model) model = usage.model;
    tokensIn += usage.tokensIn;
    tokensOut += usage.tokensOut;
    llmCalls++;
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
  }, resolverLlm);
  appendLog(jobId, "info", `Written: ${writeResult.createdEntityIds.length} created, ${writeResult.updatedEntityIds.length} updated, ${writeResult.createdRelationshipIds.length} relationships`);

  // Dedupe (post-write LLM fuzzy matching)
  const extractionConfig = await getExtractionConfig();
  let mergedCount = 0;
  if (writeResult.createdEntityIds.length > 0) {
    appendLog(jobId, "info", "Deduplicating");
    const dedupeResult = await dedupeEntities(resolverLlm, writeResult.createdEntityIds, spaceId, { concurrency: extractionConfig.max_concurrency });
    for (const u of dedupeResult.usage) { trackUsage(u); appendLog(jobId, "llm_response", { stage: "dedupe" }, u); }
    mergedCount = dedupeResult.duplicates.length;
    if (mergedCount > 0) {
      appendLog(jobId, "info", `Found ${mergedCount} potential duplicates`);
    }
  }

  return {
    extractedEntities: materializedPlan.entities.length,
    extractedRelationships: materializedPlan.relationships.length,
    createdEntities: writeResult.createdEntityIds.length,
    updatedEntities: writeResult.updatedEntityIds.length,
    createdRelationships: writeResult.createdRelationshipIds.length,
    potentialDuplicates: mergedCount,
    createdEntityIds: writeResult.createdEntityIds,
    refToId: writeResult.refToId,
    usage: { model, tokensIn, tokensOut, llmCalls },
  };
}
