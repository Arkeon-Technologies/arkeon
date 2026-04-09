/**
 * Shared extraction pipeline tail: materialize → resolve → write → dedupe.
 * Every job type prepares an ExtractPlan and hands off here.
 */

import { LlmClient, type LlmUsage } from "../lib/llm";
import { resolveLlmConfig, getExtractionConfig } from "../lib/config";
import { appendLog } from "../lib/logger";
import type { ExtractPlan } from "../lib/types";

import { materializeShellEntities } from "./materialize";
import { resolveEntities } from "./resolve";
import { rewritePlanToCanonical } from "./rewrite";
import { writeSubgraph } from "./write";
import { dedupeEntities } from "./dedupe";
import { withResolveWriteLock } from "./lock";

export interface PipelineOpts {
  jobId: string;
  documentId: string;
  arkeId: string;
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
  const { jobId, documentId, arkeId, spaceId } = opts;

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

  // Materialize
  const materializedPlan = materializeShellEntities(plan);
  appendLog(jobId, "info", `After materialize: ${materializedPlan.entities.length} entities, ${materializedPlan.relationships.length} relationships`);

  // Resolve (outside lock)
  const resolverConfig = await resolveLlmConfig("resolver");
  const resolverLlm = new LlmClient(resolverConfig);

  appendLog(jobId, "info", "Resolving against existing graph");
  const resolveResult = await resolveEntities(resolverLlm, materializedPlan, arkeId, spaceId);
  for (const u of resolveResult.usage) { trackUsage(u); appendLog(jobId, "llm_response", { stage: "resolve" }, u); }
  const matched = resolveResult.decisions.filter((d) => d.same_as_ids?.length > 0).length;
  appendLog(jobId, "info", `Resolved: ${matched} matched, ${materializedPlan.entities.length - matched} new`);
  const { entities, relationships } = rewritePlanToCanonical(materializedPlan, resolveResult.decisions);

  // Write (inside lock)
  const writeResult = await withResolveWriteLock(async () => {
    appendLog(jobId, "info", "Writing to graph");
    const wr = await writeSubgraph(entities, relationships, documentId, arkeId, {
      spaceId: opts.spaceId,
      readLevel: opts.readLevel,
      writeLevel: opts.writeLevel,
      ownerId: opts.ownerId,
      permissions: opts.permissions,
    });
    appendLog(jobId, "info", `Written: ${wr.createdEntityIds.length} entities, ${wr.createdRelationshipIds.length} relationships`);
    return wr;
  });

  // Dedupe (outside lock)
  const extractionConfig = await getExtractionConfig();
  let mergedCount = 0;
  if (writeResult.createdEntityIds.length > 0) {
    appendLog(jobId, "info", "Deduplicating");
    const dedupeResult = await dedupeEntities(resolverLlm, writeResult.createdEntityIds, arkeId, spaceId, { concurrency: extractionConfig.max_concurrency });
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
    createdRelationships: writeResult.createdRelationshipIds.length,
    potentialDuplicates: mergedCount,
    createdEntityIds: writeResult.createdEntityIds,
    refToId: writeResult.refToId,
    usage: { model, tokensIn, tokensOut, llmCalls },
  };
}
