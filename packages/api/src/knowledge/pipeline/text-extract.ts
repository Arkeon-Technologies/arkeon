/**
 * text.extract handler: full extraction pipeline for small documents.
 * extract → materialize → [lock] resolve → write [unlock] → dedupe
 */

import { LlmClient, type LlmUsage } from "../lib/llm";
import { resolveLlmConfig, getExtractionConfig } from "../lib/config";
import { appendLog } from "../lib/logger";
import type { JobRecord } from "../queue";
import { setJobStatus, tryFinalizeParent } from "../queue";
import type { SqlClient } from "../../lib/sql";

import { extractFromDocument } from "./extract";
import { materializeShellEntities } from "./materialize";
import { resolveEntities } from "./resolve";
import { rewritePlanToCanonical } from "./rewrite";
import { writeSubgraph } from "./write";
import { dedupeEntities } from "./dedupe";
import { withResolveWriteLock } from "./lock";

export async function handleTextExtract(job: JobRecord, _sql: SqlClient): Promise<void> {
  const jobId = job.id as string;
  const entityId = job.entity_id as string;
  const parentJobId = job.parent_job_id as string | null;
  const metadata = (job.metadata ?? {}) as Record<string, unknown>;
  const text = metadata.text as string;
  const arkeId = metadata.arke_id as string;
  const readLevel = metadata.read_level as number | undefined;
  const writeLevel = metadata.write_level as number | undefined;
  const ownerId = metadata.owner_id as string | undefined;
  const permissions = metadata.permissions as Array<{ grantee_type: string; grantee_id: string; role: string }> | undefined;
  const spaceId = metadata.space_id as string | undefined;

  if (!text) throw new Error("No text in job metadata");
  if (!arkeId) throw new Error("No arke_id in job metadata");

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

  // Extract
  const extractorConfig = await resolveLlmConfig("extractor");
  const extractorLlm = new LlmClient(extractorConfig);
  const extractionConfig = await getExtractionConfig();

  appendLog(jobId, "info", `Extracting from ${text.length} chars`);
  const extractResult = await extractFromDocument(extractorLlm, text, extractionConfig);
  trackUsage(extractResult.usage);
  appendLog(jobId, "llm_response", {
    stage: "extract",
    entities: extractResult.data.entities.length,
    relationships: extractResult.data.relationships.length,
  }, extractResult.usage);

  if (extractResult.data.entities.length === 0) {
    appendLog(jobId, "info", "No entities extracted");
    await setJobStatus(jobId, "completed", {
      result: { createdEntities: 0, createdRelationships: 0, potentialDuplicates: 0 },
      model, tokens_in: tokensIn, tokens_out: tokensOut, llm_calls: llmCalls,
    });
    if (parentJobId) await tryFinalizeParent(parentJobId);
    return;
  }

  // Materialize
  const materializedPlan = materializeShellEntities(extractResult.data);
  appendLog(jobId, "info", `After materialize: ${materializedPlan.entities.length} entities, ${materializedPlan.relationships.length} relationships`);

  // Resolve → Write (locked)
  const resolverConfig = await resolveLlmConfig("resolver");
  const resolverLlm = new LlmClient(resolverConfig);

  // Resolve OUTSIDE the lock (search + LLM judge calls)
  appendLog(jobId, "info", "Resolving against existing graph");
  const resolveResult = await resolveEntities(resolverLlm, materializedPlan, arkeId, spaceId);
  for (const u of resolveResult.usage) { trackUsage(u); appendLog(jobId, "llm_response", { stage: "resolve" }, u); }
  const matched = resolveResult.decisions.filter((d) => d.same_as_ids?.length > 0).length;
  appendLog(jobId, "info", `Resolved: ${matched} matched, ${materializedPlan.entities.length - matched} new`);
  const { entities, relationships } = rewritePlanToCanonical(materializedPlan, resolveResult.decisions);

  // Only lock the write phase
  const writeResult = await withResolveWriteLock(async () => {
    appendLog(jobId, "info", "Writing to graph");
    const wr = await writeSubgraph(entities, relationships, entityId, arkeId, { spaceId, readLevel, writeLevel, ownerId, permissions });
    appendLog(jobId, "info", `Written: ${wr.createdEntityIds.length} entities, ${wr.createdRelationshipIds.length} relationships`);
    return wr;
  });

  // Dedupe (outside lock)
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

  await setJobStatus(jobId, "completed", {
    result: {
      documentId: entityId,
      extractedEntities: materializedPlan.entities.length,
      extractedRelationships: materializedPlan.relationships.length,
      createdEntities: writeResult.createdEntityIds.length,
      createdRelationships: writeResult.createdRelationshipIds.length,
      potentialDuplicates: mergedCount,
    },
    model, tokens_in: tokensIn, tokens_out: tokensOut, llm_calls: llmCalls,
  });

  console.log(`[knowledge:queue] text.extract ${jobId} completed: ${writeResult.createdEntityIds.length} entities, ${writeResult.createdRelationshipIds.length} rels`);

  if (parentJobId) await tryFinalizeParent(parentJobId);
}
