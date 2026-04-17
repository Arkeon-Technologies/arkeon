// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * text.chunk_extract handler: extracts from one chunk of a large document.
 * Stores ExtractPlan in job result. When the last sibling completes,
 * claims finalization → merge all plans → pipeline tail.
 */

import { LlmClient } from "../lib/llm";
import { resolveLlmConfig, getExtractionConfig } from "../lib/config";
import { appendLog } from "../lib/logger";
import type { JobRecord } from "../queue";
import { setJobStatus } from "../queue";
import type { SqlClient } from "../../lib/sql";
import type { DocumentSurvey, SpaceExtractionConfig } from "../lib/types";

import { extractFromChunk, type EntitySummary } from "./extract";
import { claimFinalization, runGroupFinalization } from "./finalize";

export async function handleTextChunkExtract(job: JobRecord, _sql: SqlClient): Promise<void> {
  const jobId = job.id as string;
  const entityId = job.entity_id as string;
  const parentJobId = job.parent_job_id as string;
  const metadata = (job.metadata ?? {}) as Record<string, unknown>;
  const chunkText = metadata.chunk_text as string;
  const chunkOrdinal = metadata.chunk_ordinal as number;
  const totalChunks = metadata.total_chunks as number;
  const survey = metadata.survey as DocumentSurvey;
  const readLevel = metadata.read_level as number | undefined;
  const writeLevel = metadata.write_level as number | undefined;
  const ownerId = metadata.owner_id as string | undefined;
  const permissions = metadata.permissions as Array<{ grantee_type: string; grantee_id: string; role: string }> | undefined;
  const spaceId = metadata.space_id as string | undefined;
  const spaceExtractionConfig = metadata.space_extraction_config as SpaceExtractionConfig | undefined;
  const scoutedEntities = metadata.scouted_entities as EntitySummary[] | undefined;

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
  }, extractionConfig, spaceExtractionConfig, scoutedEntities);

  appendLog(jobId, "llm_response", {
    stage: "chunk_extract",
    chunk: chunkOrdinal,
    entities: extractResult.data.entities.length,
    relationships: extractResult.data.relationships.length,
  }, extractResult.usage);

  // Store plan and mark completed
  await setJobStatus(jobId, "completed", {
    result: {
      plan: extractResult.data,
      groupOrdinal: chunkOrdinal,
    },
    model: extractResult.usage.model,
    tokens_in: extractResult.usage.tokensIn,
    tokens_out: extractResult.usage.tokensOut,
    llm_calls: 1,
  });

  console.log(`[knowledge:queue] text.chunk_extract ${jobId} completed (chunk ${chunkOrdinal + 1}/${totalChunks})`);

  // Try to claim and run finalization
  const claimed = await claimFinalization(parentJobId, "text.chunk_extract");
  if (claimed) {
    console.log(`[knowledge:queue] All ${totalChunks} chunks complete, finalizing`);
    await runGroupFinalization(parentJobId, "text.chunk_extract", {
      jobId: parentJobId,
      documentId: entityId,
      spaceId,
      readLevel,
      writeLevel,
      ownerId,
      permissions,
    });
  }
}
