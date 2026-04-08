/**
 * Ingest handler: the entry point for all knowledge extraction.
 * Routes content and fans out to typed child jobs.
 *
 * Small doc → creates one text.extract child job
 * Large doc → surveys, chunks, creates N text.chunk_extract child jobs
 */

import { LlmClient } from "../lib/llm";
import { resolveLlmConfig, getExtractionConfig } from "../lib/config";
import { getEntity, updateEntity, getEntityPermissions } from "../lib/arke-client";
import { appendLog } from "../lib/logger";
import type { JobRecord } from "../queue";
import { createJob, setJobStatus } from "../queue";
import type { SqlClient } from "../../lib/sql";

import { routeContent } from "./route";
import { estimateTokens, chunkText, CHUNK_THRESHOLD_TOKENS } from "./chunk";
import { surveyDocument } from "./survey";
import { writeChunkEntities } from "./write";

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

  const arkeId = entity.arke_id ?? entity.network_id;
  if (!arkeId) {
    throw new Error(`Entity ${entityId} has no arke_id`);
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

  // Common metadata inherited by all child jobs
  const inheritedMeta = {
    arke_id: arkeId,
    read_level: readLevel,
    write_level: writeLevel,
    owner_id: ownerId,
    permissions,
    space_id: spaceId,
  };

  // Route content
  const contentResult = await routeContent(entity);
  const text = contentResult.text;

  if (!text || text.trim().length < 10) {
    throw new Error(`Entity ${entityId} has no meaningful text content`);
  }
  appendLog(jobId, "info", `Routed ${text.length} chars of text (mime: ${contentResult.mimeType ?? "inline"})`);

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
      metadata: { text, ...inheritedMeta },
    });

    await setJobStatus(jobId, "waiting");
  } else {
    // --- Large document: survey, chunk, fan out ---
    appendLog(jobId, "info", `Large document (~${tokens} tokens), chunking`);

    // Survey
    const extractorConfig = await resolveLlmConfig("extractor");
    const extractorLlm = new LlmClient(extractorConfig);

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

    // Create chunk entities in the graph (for provenance)
    const parentLabel = entity.properties?.label ?? `Entity ${entityId}`;
    const chunkWrite = await writeChunkEntities(chunks, entityId, parentLabel, arkeId, { spaceId, readLevel, writeLevel });
    appendLog(jobId, "info", `Created ${chunkWrite.chunkIds.length} chunk entities`);

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
          chunk_entity_ids: chunkWrite.chunkIds,
          ...inheritedMeta,
        },
      });
      if (childId) childJobIds.push(childId);
    }

    appendLog(jobId, "info", `Created ${childJobIds.length} chunk extraction jobs`);

    // Store metadata on parent for finalization
    await sql.query(
      `UPDATE knowledge_jobs SET metadata = $1 WHERE id = $2`,
      [JSON.stringify({ arke_id: arkeId, chunk_entity_ids: chunkWrite.chunkIds }), jobId],
    );

    await setJobStatus(jobId, "waiting");
  }
}
