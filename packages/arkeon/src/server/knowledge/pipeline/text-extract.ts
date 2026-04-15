// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * text.extract handler: extraction for small documents.
 * extract → runExtractionPipeline (materialize → ops upsert → dedupe)
 */

import { LlmClient, type LlmUsage } from "../lib/llm";
import { resolveLlmConfig, getExtractionConfig } from "../lib/config";
import { appendLog } from "../lib/logger";
import type { JobRecord } from "../queue";
import { setJobStatus, tryFinalizeParent } from "../queue";
import type { SqlClient } from "../../lib/sql";
import type { SpaceExtractionConfig } from "../lib/types";

import { extractFromDocument, scoutEntities, type EntitySummary } from "./extract";
import { runExtractionPipeline } from "./run-pipeline";

export async function handleTextExtract(job: JobRecord, _sql: SqlClient): Promise<void> {
  const jobId = job.id as string;
  const entityId = job.entity_id as string;
  const parentJobId = job.parent_job_id as string | null;
  const metadata = (job.metadata ?? {}) as Record<string, unknown>;
  const text = metadata.text as string;
  const readLevel = metadata.read_level as number | undefined;
  const writeLevel = metadata.write_level as number | undefined;
  const ownerId = metadata.owner_id as string | undefined;
  const permissions = metadata.permissions as Array<{ grantee_type: string; grantee_id: string; role: string }> | undefined;
  const spaceId = metadata.space_id as string | undefined;
  const spaceExtractionConfig = metadata.space_extraction_config as SpaceExtractionConfig | undefined;
  const scoutedEntities = metadata.scouted_entities as EntitySummary[] | undefined;

  if (!text) throw new Error("No text in job metadata");

  // Extract
  const extractorConfig = await resolveLlmConfig("extractor");
  const extractorLlm = new LlmClient(extractorConfig);
  const extractionConfig = await getExtractionConfig();

  // Scout for existing entities if not already scouted at ingest level
  let existingEntities = scoutedEntities;
  if (!existingEntities) {
    appendLog(jobId, "info", "Scouting for existing graph entities");
    const scoutResult = await scoutEntities(extractorLlm, text, spaceId);
    existingEntities = scoutResult.entities;
    if (existingEntities.length > 0) {
      appendLog(jobId, "info", `Found ${existingEntities.length} existing entities for context`);
    }
  }

  appendLog(jobId, "info", `Extracting from ${text.length} chars`);
  const extractResult = await extractFromDocument(extractorLlm, text, extractionConfig, spaceExtractionConfig, existingEntities);
  appendLog(jobId, "llm_response", {
    stage: "extract",
    entities: extractResult.data.entities.length,
    relationships: extractResult.data.relationships.length,
  }, extractResult.usage);

  // Pipeline tail
  const pipelineResult = await runExtractionPipeline(extractResult.data, {
    jobId,
    documentId: entityId,
    spaceId,
    readLevel,
    writeLevel,
    ownerId,
    permissions,
  });

  // Merge extraction + pipeline usage
  const totalTokensIn = extractResult.usage.tokensIn + pipelineResult.usage.tokensIn;
  const totalTokensOut = extractResult.usage.tokensOut + pipelineResult.usage.tokensOut;
  const totalLlmCalls = 1 + pipelineResult.usage.llmCalls;
  const model = extractResult.usage.model || pipelineResult.usage.model;

  await setJobStatus(jobId, "completed", {
    result: {
      documentId: entityId,
      extractedEntities: pipelineResult.extractedEntities,
      extractedRelationships: pipelineResult.extractedRelationships,
      createdEntities: pipelineResult.createdEntities,
      createdRelationships: pipelineResult.createdRelationships,
      mergedDuplicates: pipelineResult.mergedDuplicates,
    },
    model, tokens_in: totalTokensIn, tokens_out: totalTokensOut, llm_calls: totalLlmCalls,
  });

  console.log(`[knowledge:queue] text.extract ${jobId} completed: ${pipelineResult.createdEntities} entities, ${pipelineResult.createdRelationships} rels`);

  if (parentJobId) await tryFinalizeParent(parentJobId);
}
