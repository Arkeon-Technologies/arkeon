// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Ingest handler: the entry point for all knowledge extraction.
 * Routes content and fans out to typed child jobs.
 *
 * Small doc → creates one text.extract child job
 * Large doc → surveys, chunks, creates N text.chunk_extract child jobs
 *
 * If the source entity is in a space with properties.extraction,
 * that config overrides the global extraction settings.
 */

import { LlmClient } from "../lib/llm";
import { resolveLlmConfig, getExtractionConfig } from "../lib/config";
import { getEntity, getSpace, updateEntity, getEntityPermissions } from "../lib/arke-client";
import { appendLog } from "../lib/logger";
import type { JobRecord } from "../queue";
import { createJob, setJobStatus } from "../queue";
import type { SqlClient } from "../../lib/sql";
import type { SpaceExtractionConfig } from "../lib/types";

import { routeContent } from "./route";
import { estimateTokens, chunkText, CHUNK_THRESHOLD_TOKENS } from "./chunk";
import { surveyDocument } from "./survey";
import { writeSourceEntities } from "./write";
import { scoutEntities } from "./extract";

export async function handleIngest(job: JobRecord, sql: SqlClient): Promise<void> {
  const jobId = job.id as string;
  const entityId = job.entity_id as string;
  const entityVer = job.entity_ver as number;
  const trigger = job.trigger as string;
  const triggeredBy = job.triggered_by as string | null;

  appendLog(jobId, "info", `Fetching entity ${entityId}`);
  const entity = await getEntity(entityId);
  if (!entity) {
    throw new Error(`Entity ${entityId} not found`);
  }

  // Inherit access control from source entity
  const readLevel = entity.read_level as number | undefined;
  const writeLevel = entity.write_level as number | undefined;

  // Read source entity's ownership + permission grants via API
  const { owner_id: ownerId, permissions } = await getEntityPermissions(entityId);

  // Get extraction config
  const extractionConfig = await getExtractionConfig();

  // Determine space_id: if scope_to_space is on, use the entity's first space
  let spaceId: string | undefined;
  if (extractionConfig.scope_to_space) {
    const spaceIds = entity.space_ids as string[] | undefined;
    if (spaceIds && spaceIds.length > 0) {
      spaceId = spaceIds[0];
    }
  }

  // Read space-level extraction config if in a space
  let spaceExtractionConfig: SpaceExtractionConfig | undefined;
  if (spaceId) {
    try {
      const space = await getSpace(spaceId);
      if (space?.properties?.extraction) {
        spaceExtractionConfig = space.properties.extraction as SpaceExtractionConfig;
        appendLog(jobId, "info", `Using space extraction config from space ${spaceId}`);
      }
    } catch (err) {
      console.warn(`[knowledge:ingest] Failed to read space ${spaceId}:`, err instanceof Error ? err.message : err);
    }
  }

  // Common metadata inherited by all child jobs
  const inheritedMeta = {
    read_level: readLevel,
    write_level: writeLevel,
    owner_id: ownerId,
    permissions,
    space_id: spaceId,
    space_extraction_config: spaceExtractionConfig,
  };

  // Route content
  const contentResult = await routeContent(entity);

  // PDF: route to specialized pdf.extract handler
  if (contentResult.mimeType === "application/pdf" && contentResult.sourceKey) {
    appendLog(jobId, "info", `PDF detected (key: ${contentResult.sourceKey}), creating pdf.extract job`);
    await createJob({
      entityId,
      entityVer,
      trigger: "system",
      triggeredBy: triggeredBy ?? undefined,
      jobType: "pdf.extract",
      parentJobId: jobId,
      metadata: {
        content_key: contentResult.sourceKey,
        ...inheritedMeta,
      },
    });
    await setJobStatus(jobId, "waiting");
    return;
  }

  // PPTX: route to specialized pptx.extract handler
  const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  if (contentResult.mimeType === PPTX_MIME && contentResult.sourceKey) {
    appendLog(jobId, "info", `PPTX detected (key: ${contentResult.sourceKey}), creating pptx.extract job`);
    await createJob({
      entityId,
      entityVer,
      trigger: "system",
      triggeredBy: triggeredBy ?? undefined,
      jobType: "pptx.extract",
      parentJobId: jobId,
      metadata: {
        content_key: contentResult.sourceKey,
        ...inheritedMeta,
      },
    });
    await setJobStatus(jobId, "waiting");
    return;
  }

  // DOCX: route to specialized docx.extract handler
  const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (contentResult.mimeType === DOCX_MIME && contentResult.sourceKey) {
    appendLog(jobId, "info", "Detected DOCX, creating docx.extract job");
    await createJob({
      entityId,
      entityVer,
      trigger: "system",
      triggeredBy: triggeredBy ?? undefined,
      jobType: "docx.extract",
      parentJobId: jobId,
      metadata: { content_key: contentResult.sourceKey, ...inheritedMeta },
    });
    await setJobStatus(jobId, "waiting");
    return;
  }

  const text = contentResult.text;

  if (!text || text.trim().length < 10) {
    throw new Error(`Entity ${entityId} has no meaningful text content`);
  }
  appendLog(jobId, "info", `Routed ${text.length} chars of text (mime: ${contentResult.mimeType ?? "inline"})`);

  // Scout for existing entities in the graph to enable cross-document connectivity
  const extractorConfig = await resolveLlmConfig("extractor");
  const extractorLlm = new LlmClient(extractorConfig);

  appendLog(jobId, "info", "Scouting for existing graph entities");
  let scoutedEntities: Array<{ id: string; label: string; type: string; description: string }> = [];
  try {
    const scoutResult = await scoutEntities(extractorLlm, text, spaceId);
    scoutedEntities = scoutResult.entities;
    if (scoutedEntities.length > 0) {
      appendLog(jobId, "info", `Found ${scoutedEntities.length} existing entities for context`);
    }
  } catch (err) {
    console.warn(`[knowledge:ingest] Scout failed, continuing without context:`, err instanceof Error ? err.message : err);
  }

  const targetChunkChars = extractionConfig.target_chunk_chars;
  const chunkThresholdTokens = Math.ceil(targetChunkChars / 4);

  const tokens = estimateTokens(text);

  if (tokens <= chunkThresholdTokens) {
    // --- Small document: fan out to a single text.extract job ---
    appendLog(jobId, "info", `Small document (~${tokens} tokens), creating text.extract job`);

    await createJob({
      entityId,
      entityVer,
      trigger: "system",
      triggeredBy: triggeredBy ?? undefined,
      jobType: "text.extract",
      parentJobId: jobId,
      metadata: { text, scouted_entities: scoutedEntities, ...inheritedMeta },
    });

    await setJobStatus(jobId, "waiting");
  } else {
    // --- Large document: survey, chunk, fan out ---
    appendLog(jobId, "info", `Large document (~${tokens} tokens), chunking`);

    appendLog(jobId, "info", "Surveying document");
    const surveyResult = await surveyDocument(extractorLlm, text);
    appendLog(jobId, "llm_response", {
      stage: "survey",
      title: surveyResult.data.title,
      document_type: surveyResult.data.document_type,
    }, surveyResult.usage);

    // Persist survey
    try {
      await updateEntity(entityId, {
        ver: entity.ver,
        properties: { ...entity.properties, survey: surveyResult.data },
      });
    } catch (err) {
      console.warn(`[knowledge:ingest] Failed to persist survey on ${entityId}:`, err instanceof Error ? err.message : err);
    }

    // Chunk with configured target size
    const chunks = chunkText(text, { targetChars: targetChunkChars });
    appendLog(jobId, "info", `Split into ${chunks.length} chunks`);

    // Create source entities in the graph (for provenance)
    const parentLabel = entity.properties?.label ?? `Entity ${entityId}`;
    const sourceWrite = await writeSourceEntities(
      chunks.map((c) => ({
        label: `Chunk ${c.ordinal + 1} of ${parentLabel}`,
        type: "text_chunk",
        ordinal: c.ordinal,
        text: c.text,
        properties: { start_offset: c.startOffset, end_offset: c.endOffset },
      })),
      entityId,
      { spaceId, readLevel, writeLevel },
    );
    appendLog(jobId, "info", `Created ${sourceWrite.sourceEntityIds.length} source entities`);

    // Fan out: create a text.chunk_extract job per chunk
    const childJobIds: string[] = [];
    for (const chunk of chunks) {
      const childId = await createJob({
        entityId,
        entityVer,
        trigger: "system",
        triggeredBy: triggeredBy ?? undefined,
        jobType: "text.chunk_extract",
        parentJobId: jobId,
        metadata: {
          chunk_ordinal: chunk.ordinal,
          total_chunks: chunks.length,
          chunk_text: chunk.text,
          survey: surveyResult.data,
          source_entity_ids: sourceWrite.sourceEntityIds,
          scouted_entities: scoutedEntities,
          ...inheritedMeta,
        },
      });
      if (childId) childJobIds.push(childId);
    }

    appendLog(jobId, "info", `Created ${childJobIds.length} chunk extraction jobs`);

    // Store metadata on parent for finalization
    await sql.query(
      `UPDATE knowledge_jobs SET metadata = $1 WHERE id = $2`,
      [JSON.stringify({ source_entity_ids: sourceWrite.sourceEntityIds }), jobId],
    );

    await setJobStatus(jobId, "waiting");
  }
}
