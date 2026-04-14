// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * docx.extract handler: extracts text and images from DOCX files.
 *
 * 1. Parse DOCX with mammoth → markdown text + embedded images
 * 2. Process embedded images via vision LLM (describePageImage)
 * 3. Merge image descriptions into text
 * 4. Route enriched text to existing pipeline:
 *    - Small → text.extract child
 *    - Large → survey, chunk, text.chunk_extract children
 */

import mammoth from "mammoth";
import { LlmClient } from "../lib/llm";
import { resolveLlmConfig, getExtractionConfig } from "../lib/config";
import {
  getEntity,
  getEntityContentBytes,
  updateEntity,
  uploadEntityContent,
} from "../lib/arke-client";
import { appendLog } from "../lib/logger";
import type { JobRecord } from "../queue";
import { createJob, setJobStatus } from "../queue";
import type { SqlClient } from "../../lib/sql";

import { estimateTokens, chunkText } from "./chunk";
import { surveyDocument } from "./survey";
import { writeSourceEntities } from "./write";
import { describePageImage } from "./visual-describe";

interface CollectedImage {
  buffer: Buffer;
  contentType: string;
  altText: string;
}

export async function handleDocxExtract(job: JobRecord, sql: SqlClient): Promise<void> {
  const jobId = job.id as string;
  const entityId = job.entity_id as string;
  const entityVer = job.entity_ver as number;
  const triggeredBy = job.triggered_by as string | null;
  const metadata = (job.metadata ?? {}) as Record<string, unknown>;
  const contentKey = metadata.content_key as string;
  const readLevel = metadata.read_level as number | undefined;
  const writeLevel = metadata.write_level as number | undefined;
  const ownerId = metadata.owner_id as string | undefined;
  const permissions = metadata.permissions as Array<{ grantee_type: string; grantee_id: string; role: string }> | undefined;
  const spaceId = metadata.space_id as string | undefined;
  const spaceExtractionConfig = metadata.space_extraction_config;

  if (!contentKey) throw new Error("No content_key in job metadata");

  // Inherited metadata for child jobs
  const inheritedMeta = {
    read_level: readLevel,
    write_level: writeLevel,
    owner_id: ownerId,
    permissions,
    space_id: spaceId,
    space_extraction_config: spaceExtractionConfig,
  };

  // --- Step 1: Fetch and parse DOCX ---
  appendLog(jobId, "info", `Fetching DOCX content from ${entityId}/${contentKey}`);
  const docxBytes = await getEntityContentBytes(entityId, contentKey);
  appendLog(jobId, "info", `DOCX size: ${(docxBytes.byteLength / 1024).toFixed(1)} KB`);

  // Collect embedded images during mammoth conversion
  const collectedImages: CollectedImage[] = [];

  // mammoth's type declarations omit convertToMarkdown, but it exists at runtime
  const convertToMarkdown = (mammoth as any).convertToMarkdown as typeof mammoth.convertToHtml;

  const result = await convertToMarkdown(
    { buffer: docxBytes },
    {
      convertImage: mammoth.images.imgElement((element) => {
        return element.readAsBuffer().then((imageBuffer) => {
          const index = collectedImages.length;
          collectedImages.push({
            buffer: imageBuffer,
            contentType: element.contentType || "image/png",
            altText: "",
          });
          return { src: `__DOCX_IMAGE_${index}__` };
        });
      }),
    },
  );

  let text = result.value;
  if (result.messages.length > 0) {
    const warnings = result.messages.filter((m: any) => m.type === "warning");
    if (warnings.length > 0) {
      appendLog(jobId, "info", `mammoth warnings: ${warnings.map((w: any) => w.message).join("; ")}`);
    }
  }

  appendLog(jobId, "info", `Extracted ${text.length} chars, ${collectedImages.length} embedded images`);

  // --- Step 2: Process embedded images via vision LLM ---
  let totalVisionTokensIn = 0;
  let totalVisionTokensOut = 0;
  let visionCalls = 0;

  if (collectedImages.length > 0) {
    appendLog(jobId, "info", `Processing ${collectedImages.length} embedded images via vision LLM`);

    // Get current entity version for content uploads (increments per upload)
    let currentVer = entityVer;
    const freshEntity = await getEntity(entityId);
    if (freshEntity?.ver) currentVer = freshEntity.ver as number;

    for (let i = 0; i < collectedImages.length; i++) {
      const img = collectedImages[i];
      const imageKey = `docx_image_${i}`;

      // Upload image to entity storage so describePageImage can fetch it
      const uploadResult = await uploadEntityContent(
        entityId,
        imageKey,
        currentVer,
        new Uint8Array(img.buffer),
        img.contentType,
      );
      currentVer = uploadResult.ver;

      try {
        const describeResult = await describePageImage(
          entityId,
          imageKey,
          img.contentType,
          i + 1,
        );

        // Replace placeholder with description
        const placeholder = `![${img.altText}](__DOCX_IMAGE_${i}__)`;
        const description = describeResult.text;
        text = text.replace(placeholder, description);

        totalVisionTokensIn += describeResult.usage.tokensIn;
        totalVisionTokensOut += describeResult.usage.tokensOut;
        visionCalls++;

        appendLog(jobId, "info", `Described image ${i + 1}/${collectedImages.length}`);
      } catch (err) {
        // If vision fails for one image, replace with alt text and continue
        const placeholder = `![${img.altText}](__DOCX_IMAGE_${i}__)`;
        const fallback = img.altText ? `[Image: ${img.altText}]` : `[Image: embedded image ${i + 1}]`;
        text = text.replace(placeholder, fallback);
        appendLog(jobId, "info", `Vision failed for image ${i + 1}: ${err instanceof Error ? err.message : err}`);
      }
    }

    appendLog(jobId, "info", `Vision processing complete: ${visionCalls} calls`);
  }

  // Clean up any remaining unprocessed placeholders
  text = text.replace(/!\[[^\]]*\]\(__DOCX_IMAGE_\d+__\)/g, "");

  if (!text || text.trim().length < 10) {
    throw new Error(`DOCX extraction produced no meaningful text for entity ${entityId}`);
  }

  // --- Step 3: Route to text extraction pipeline ---
  const extractionConfig = await getExtractionConfig();
  const targetChunkChars = extractionConfig.target_chunk_chars;
  const chunkThresholdTokens = Math.ceil(targetChunkChars / 4);
  const tokens = estimateTokens(text);

  if (tokens <= chunkThresholdTokens) {
    // --- Small document: single text.extract job ---
    appendLog(jobId, "info", `Small DOCX (~${tokens} tokens), creating text.extract job`);

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
    appendLog(jobId, "info", `Large DOCX (~${tokens} tokens), chunking`);

    const extractorConfig = await resolveLlmConfig("extractor");
    const extractorLlm = new LlmClient(extractorConfig);

    appendLog(jobId, "info", "Surveying document");
    const surveyResult = await surveyDocument(extractorLlm, text);
    appendLog(jobId, "llm_response", {
      stage: "survey",
      title: surveyResult.data.title,
      document_type: surveyResult.data.document_type,
    }, surveyResult.usage);

    // Persist survey on entity
    const entity = await getEntity(entityId);
    try {
      await updateEntity(entityId, {
        ver: entity.ver,
        properties: { ...entity.properties, survey: surveyResult.data },
      });
    } catch (err) {
      console.warn(`[knowledge:docx-extract] Failed to persist survey on ${entityId}:`, err instanceof Error ? err.message : err);
    }

    // Chunk
    const chunks = chunkText(text, { targetChars: targetChunkChars });
    appendLog(jobId, "info", `Split into ${chunks.length} chunks`);

    // Create source entities for provenance
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

    // Fan out chunk extraction jobs
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
          ...inheritedMeta,
        },
      });
      if (childId) childJobIds.push(childId);
    }

    appendLog(jobId, "info", `Created ${childJobIds.length} chunk extraction jobs`);

    // Store metadata on parent for finalization
    await sql.query(
      `UPDATE knowledge_jobs SET metadata = $1 WHERE id = $2`,
      [JSON.stringify({
        source_entity_ids: sourceWrite.sourceEntityIds,
        vision_tokens_in: totalVisionTokensIn,
        vision_tokens_out: totalVisionTokensOut,
        vision_calls: visionCalls,
      }), jobId],
    );

    await setJobStatus(jobId, "waiting");
  }
}
