/**
 * text.chunk_extract handler: extracts from one chunk of a large document.
 * When the last sibling chunk completes, triggers merge → resolve → write → dedupe.
 */

import { LlmClient, type LlmUsage } from "../lib/llm";
import { resolveLlmConfig, getExtractionConfig } from "../lib/config";
import { appendLog } from "../lib/logger";
import type { JobRecord } from "../queue";
import { setJobStatus, tryFinalizeParent } from "../queue";
import type { SqlClient } from "../../lib/sql";
import type { ExtractPlan, DocumentSurvey } from "../lib/types";
import type { ChatJsonResult } from "../lib/llm";

import { extractFromChunk } from "./extract";
import { mergeChunkPlans } from "./merge";
import { materializeShellEntities } from "./materialize";
import { resolveEntities } from "./resolve";
import { rewritePlanToCanonical } from "./rewrite";
import { writeSubgraph, writeChunkProvenance } from "./write";
import { dedupeEntities } from "./dedupe";
import { withResolveWriteLock } from "./lock";

export async function handleTextChunkExtract(job: JobRecord, sql: SqlClient): Promise<void> {
  const jobId = job.id as string;
  const entityId = job.entity_id as string;
  const parentJobId = job.parent_job_id as string;
  const metadata = (job.metadata ?? {}) as Record<string, unknown>;
  const chunkText = metadata.chunk_text as string;
  const chunkOrdinal = metadata.chunk_ordinal as number;
  const totalChunks = metadata.total_chunks as number;
  const survey = metadata.survey as DocumentSurvey;
  const arkeId = metadata.arke_id as string;
  const readLevel = metadata.read_level as number | undefined;
  const writeLevel = metadata.write_level as number | undefined;
  const ownerId = metadata.owner_id as string | undefined;
  const permissions = metadata.permissions as Array<{ grantee_type: string; grantee_id: string; role: string }> | undefined;
  const spaceId = metadata.space_id as string | undefined;

  if (!chunkText) throw new Error("No chunk_text in job metadata");
  if (!parentJobId) throw new Error("No parent_job_id for chunk_extract job");

  // Extract from this chunk
  const extractorConfig = await resolveLlmConfig("extractor");
  const extractorLlm = new LlmClient(extractorConfig);
  const extractionConfig = await getExtractionConfig();

  appendLog(jobId, "info", `Extracting chunk ${chunkOrdinal + 1}/${totalChunks} (${chunkText.length} chars)`);
  const extractResult = await extractFromChunk(extractorLlm, chunkText, {
    survey,
    chunkOrdinal,
    totalChunks,
  }, extractionConfig);

  appendLog(jobId, "llm_response", {
    stage: "chunk_extract",
    chunk: chunkOrdinal,
    entities: extractResult.data.entities.length,
    relationships: extractResult.data.relationships.length,
  }, extractResult.usage);

  // Store extraction result and mark completed
  await setJobStatus(jobId, "completed", {
    result: {
      plan: extractResult.data,
      chunkOrdinal,
    },
    model: extractResult.usage.model,
    tokens_in: extractResult.usage.tokensIn,
    tokens_out: extractResult.usage.tokensOut,
    llm_calls: 1,
  });

  console.log(`[knowledge:queue] text.chunk_extract ${jobId} completed (chunk ${chunkOrdinal + 1}/${totalChunks})`);

  // Atomic gate: only one chunk can claim the finalization
  const [claimed] = await sql.query(
    `UPDATE knowledge_jobs SET status = 'finalizing'
     WHERE id = $1 AND status = 'waiting'
     RETURNING id`,
    [parentJobId],
  );

  if (claimed) {
    // Check all chunks are actually done
    const [counts] = await sql.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
         COUNT(*)::int AS total
       FROM knowledge_jobs
       WHERE parent_job_id = $1 AND job_type = 'text.chunk_extract'`,
      [parentJobId],
    );

    if ((counts.completed as number) === (counts.total as number)) {
      // All chunks done — this job triggers finalization
      console.log(`[knowledge:queue] All ${totalChunks} chunks complete, finalizing`);
      await finalizeChunkedExtraction(parentJobId, entityId, arkeId, sql, { spaceId, readLevel, writeLevel, ownerId, permissions });
    } else {
      // Not all done yet — release the gate back to waiting
      await sql.query(`UPDATE knowledge_jobs SET status = 'waiting' WHERE id = $1`, [parentJobId]);
    }
  }
}

/**
 * Merge all chunk extraction results and run resolve → write → dedupe.
 * Called by the last chunk_extract job to complete.
 */
async function finalizeChunkedExtraction(
  parentJobId: string,
  entityId: string,
  arkeId: string,
  sql: SqlClient,
  opts?: { spaceId?: string; readLevel?: number; writeLevel?: number; ownerId?: string; permissions?: Array<{ grantee_type: string; grantee_id: string; role: string }> },
): Promise<void> {
  const extractionConfig = await getExtractionConfig();

  // Fetch all chunk results ordered by ordinal
  const chunkJobs = await sql.query(
    `SELECT result, metadata FROM knowledge_jobs
     WHERE parent_job_id = $1 AND job_type = 'text.chunk_extract' AND status = 'completed'
     ORDER BY (metadata->>'chunk_ordinal')::int`,
    [parentJobId],
  );

  // Build ChatJsonResult array for mergeChunkPlans
  const chunkResults: ChatJsonResult<ExtractPlan>[] = chunkJobs.map((j) => {
    const result = j.result as { plan: ExtractPlan; chunkOrdinal: number };
    return {
      data: result.plan,
      usage: { model: "", tokensIn: 0, tokensOut: 0 }, // usage already tracked per-chunk
    };
  });

  appendLog(parentJobId, "info", `Merging ${chunkResults.length} chunk extraction results`);

  // Merge
  const mergeResult = mergeChunkPlans(chunkResults);
  const extractedPlan = mergeResult.plan;
  appendLog(parentJobId, "info", `Merged: ${extractedPlan.entities.length} entities, ${extractedPlan.relationships.length} relationships`);

  if (extractedPlan.entities.length === 0) {
    await tryFinalizeParent(parentJobId);
    return;
  }

  // Materialize
  const materializedPlan = materializeShellEntities(extractedPlan);
  appendLog(parentJobId, "info", `After materialize: ${materializedPlan.entities.length} entities, ${materializedPlan.relationships.length} relationships`);

  // Resolve LLM for resolve + dedupe
  const resolverConfig = await resolveLlmConfig("resolver");
  const resolverLlm = new LlmClient(resolverConfig);

  let tokensIn = 0;
  let tokensOut = 0;
  let llmCalls = 0;
  let model = "";
  function trackUsage(u: LlmUsage) {
    if (!model && u.model) model = u.model;
    tokensIn += u.tokensIn;
    tokensOut += u.tokensOut;
    llmCalls++;
  }

  // Resolve OUTSIDE the lock (search + LLM judge calls)
  appendLog(parentJobId, "info", "Resolving against existing graph");
  const resolveResult = await resolveEntities(resolverLlm, materializedPlan, arkeId, opts?.spaceId);
  for (const u of resolveResult.usage) { trackUsage(u); appendLog(parentJobId, "llm_response", { stage: "resolve" }, u); }
  const matched = resolveResult.decisions.filter((d) => d.same_as_ids?.length > 0).length;
  appendLog(parentJobId, "info", `Resolved: ${matched} matched, ${materializedPlan.entities.length - matched} new`);
  const { entities, relationships } = rewritePlanToCanonical(materializedPlan, resolveResult.decisions);

  // Only lock the write phase
  const writeResult = await withResolveWriteLock(async () => {
    appendLog(parentJobId, "info", "Writing to graph");
    const wr = await writeSubgraph(entities, relationships, entityId, arkeId, opts);
    appendLog(parentJobId, "info", `Written: ${wr.createdEntityIds.length} entities, ${wr.createdRelationshipIds.length} relationships`);

    // Chunk provenance
    const parentMeta = (await sql.query(`SELECT metadata FROM knowledge_jobs WHERE id = $1`, [parentJobId]))[0];
    const chunkEntityIds = ((parentMeta?.metadata as any)?.chunk_entity_ids ?? []) as string[];
    if (mergeResult.refToChunkOrdinal && chunkEntityIds.length > 0) {
      appendLog(parentJobId, "info", "Writing chunk provenance");
      await writeChunkProvenance(wr.refToId, mergeResult.refToChunkOrdinal, chunkEntityIds);
    }

    return wr;
  });

  // Dedupe (outside lock)
  let mergedCount = 0;
  if (writeResult.createdEntityIds.length > 0) {
    appendLog(parentJobId, "info", "Deduplicating");
    const dedupeResult = await dedupeEntities(resolverLlm, writeResult.createdEntityIds, arkeId, opts?.spaceId, { concurrency: extractionConfig.max_concurrency });
    for (const u of dedupeResult.usage) { trackUsage(u); appendLog(parentJobId, "llm_response", { stage: "dedupe" }, u); }
    mergedCount = dedupeResult.duplicates.length;
  }

  // Aggregate token usage from all chunk children + finalization
  const chunkTokens = await sql.query(
    `SELECT COALESCE(SUM(tokens_in), 0)::int AS tin, COALESCE(SUM(tokens_out), 0)::int AS tout, COALESCE(SUM(llm_calls), 0)::int AS calls
     FROM knowledge_jobs WHERE parent_job_id = $1 AND job_type = 'text.chunk_extract'`,
    [parentJobId],
  );
  const ct = chunkTokens[0] ?? {};
  const totalTokensIn = ((ct.tin as number) ?? 0) + tokensIn;
  const totalTokensOut = ((ct.tout as number) ?? 0) + tokensOut;
  const totalLlmCalls = ((ct.calls as number) ?? 0) + llmCalls;

  // Set parent to completed with final results (don't use tryFinalizeParent — it would overwrite)
  await setJobStatus(parentJobId, "completed", {
    result: {
      documentId: entityId,
      extractedEntities: materializedPlan.entities.length,
      extractedRelationships: materializedPlan.relationships.length,
      createdEntities: writeResult.createdEntityIds.length,
      createdRelationships: writeResult.createdRelationshipIds.length,
      potentialDuplicates: mergedCount,
      chunksCreated: chunkResults.length,
    },
    model: model || undefined,
    tokens_in: totalTokensIn,
    tokens_out: totalTokensOut,
    llm_calls: totalLlmCalls,
  });

  console.log(`[knowledge:queue] Finalized chunked extraction for ${parentJobId}: ${writeResult.createdEntityIds.length} entities, ${writeResult.createdRelationshipIds.length} rels`);
}
