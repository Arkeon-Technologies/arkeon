// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * pptx.extract handler: parent job for PowerPoint ingestion.
 *
 * Extracts text, tables, notes, and images per slide via python-pptx,
 * creates slide entities, uploads images for slides needing vision,
 * then fans out pptx.slide_group child jobs.
 *
 * All vision LLM calls happen in the children, not here.
 */

import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { LlmClient } from "../lib/llm";
import { resolveLlmConfig, getExtractionConfig } from "../lib/config";
import {
  getEntity,
  getEntityContentBytes,
  uploadEntityContent,
  updateEntity,
} from "../lib/arke-client";
import { appendLog } from "../lib/logger";
import type { JobRecord } from "../queue";
import { createJob, setJobStatus } from "../queue";
import type { SqlClient } from "../../lib/sql";

import { writeSourceEntities } from "./write";
import { surveyDocument } from "./survey";
import { estimateTokens, CHUNK_THRESHOLD_TOKENS } from "./chunk";

const execFileAsync = promisify(execFile);

const SLIDES_PER_GROUP = 5;
const VISION_TEXT_THRESHOLD = 50; // chars below which a slide needs vision

// Resolve path to the Python extraction script
const SCRIPT_PATH = fileURLToPath(
  new URL("../scripts/pptx-extract.py", import.meta.url),
);

// ---------------------------------------------------------------------------
// Types for Python script output
// ---------------------------------------------------------------------------

interface PptxImage {
  filename: string;
  content_type: string;
  path: string;
}

interface PptxSlide {
  slide_number: number;
  text: string;
  notes: string;
  tables: { rows: string[][] }[];
  images: PptxImage[];
}

interface PptxResult {
  slide_count: number;
  slides: PptxSlide[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tableToMarkdown(rows: string[][]): string {
  if (rows.length === 0) return "";
  const header = rows[0];
  const separator = header.map(() => "---");
  const lines = [
    `| ${header.join(" | ")} |`,
    `| ${separator.join(" | ")} |`,
    ...rows.slice(1).map((row) => `| ${row.join(" | ")} |`),
  ];
  return lines.join("\n");
}

function buildSlideText(slide: PptxSlide): string {
  const parts: string[] = [];

  if (slide.text.trim()) {
    parts.push(slide.text.trim());
  }

  if (slide.notes.trim()) {
    parts.push(`Speaker Notes: ${slide.notes.trim()}`);
  }

  for (const table of slide.tables) {
    if (table.rows.length > 0) {
      parts.push(tableToMarkdown(table.rows));
    }
  }

  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handlePptxExtract(
  job: JobRecord,
  sql: SqlClient,
): Promise<void> {
  const jobId = job.id as string;
  const entityId = job.entity_id as string;
  const entityVer = job.entity_ver as number;
  const parentJobId = job.parent_job_id as string;
  const metadata = (job.metadata ?? {}) as Record<string, unknown>;
  const contentKey = metadata.content_key as string;
  const readLevel = metadata.read_level as number | undefined;
  const writeLevel = metadata.write_level as number | undefined;
  const ownerId = metadata.owner_id as string | undefined;
  const permissions = metadata.permissions as
    | Array<{ grantee_type: string; grantee_id: string; role: string }>
    | undefined;
  const spaceId = metadata.space_id as string | undefined;
  const spaceExtractionConfig = metadata.space_extraction_config;

  if (!contentKey) throw new Error("No content_key in pptx.extract metadata");

  const extractionConfig = await getExtractionConfig();
  const inheritedMeta = {
    read_level: readLevel,
    write_level: writeLevel,
    owner_id: ownerId,
    permissions,
    space_id: spaceId,
    space_extraction_config: spaceExtractionConfig,
  };

  // 1. Fetch PPTX bytes
  appendLog(jobId, "info", `Fetching PPTX content (key: ${contentKey})`);
  const pptxBytes = await getEntityContentBytes(entityId, contentKey);

  // 2. Extract via Python script
  const tmpDir = join(tmpdir(), `pptx-${jobId}`);
  let pptxResult: PptxResult;

  await mkdir(tmpDir, { recursive: true });
  try {
    const pptxPath = join(tmpDir, "input.pptx");
    const imageDir = join(tmpDir, "images");
    await mkdir(imageDir, { recursive: true });
    await writeFile(pptxPath, pptxBytes);

    appendLog(jobId, "info", "Extracting slides via python-pptx");
    const { stdout, stderr } = await execFileAsync("python3", [
      SCRIPT_PATH,
      pptxPath,
      "--image-dir",
      imageDir,
    ]);

    if (stderr) {
      console.warn(`[knowledge:pptx] Python stderr: ${stderr}`);
    }

    pptxResult = JSON.parse(stdout) as PptxResult;
    appendLog(jobId, "info", `Extracted ${pptxResult.slide_count} slides`);

    if (pptxResult.slides.length === 0) {
      throw new Error("PPTX has no slides");
    }

    // 3. Build combined text per slide and determine vision needs
    const slideTexts = pptxResult.slides.map(buildSlideText);
    const needsVision = pptxResult.slides.map(
      (s, i) => s.images.length > 0 || slideTexts[i].length < VISION_TEXT_THRESHOLD,
    );
    const visionSlideCount = needsVision.filter(Boolean).length;
    appendLog(
      jobId,
      "info",
      `${visionSlideCount}/${pptxResult.slides.length} slides need vision`,
    );

    // 4. Get entity for label
    const entity = await getEntity(entityId);
    const parentLabel = entity?.properties?.label ?? `Entity ${entityId}`;

    // 5. Create slide entities
    appendLog(jobId, "info", "Creating slide entities");
    const { sourceEntityIds } = await writeSourceEntities(
      pptxResult.slides.map((s, i) => ({
        label: `${parentLabel} - Slide ${s.slide_number}`,
        type: "pptx_slide",
        ordinal: i,
        text: slideTexts[i] || undefined,
        properties: {
          slide_number: s.slide_number,
          needs_vision: needsVision[i],
        },
      })),
      entityId,
      { spaceId, readLevel, writeLevel, ownerId, permissions },
    );
    appendLog(jobId, "info", `Created ${sourceEntityIds.length} slide entities`);

    // 6. Upload first image per slide for vision
    if (visionSlideCount > 0) {
      appendLog(jobId, "info", "Uploading slide images to entities");
      for (let i = 0; i < pptxResult.slides.length; i++) {
        if (!needsVision[i]) continue;
        const slide = pptxResult.slides[i];
        if (slide.images.length === 0) continue;

        const firstImage = slide.images[0];
        const imageBytes = await readFile(firstImage.path);
        await uploadEntityContent(
          sourceEntityIds[i],
          "slide_image",
          1, // freshly created entity, ver = 1
          Buffer.from(imageBytes),
          firstImage.content_type,
        );
      }
    }

    // 7. Survey (optional, for large presentations)
    const fullText = slideTexts.join("\n\n");
    const totalTokens = estimateTokens(fullText);
    let surveyResult: Awaited<ReturnType<typeof surveyDocument>> | undefined;

    if (totalTokens > CHUNK_THRESHOLD_TOKENS) {
      appendLog(jobId, "info", "Surveying document");
      const extractorConfig = await resolveLlmConfig("extractor");
      const extractorLlm = new LlmClient(extractorConfig);
      surveyResult = await surveyDocument(extractorLlm, fullText);
      appendLog(
        jobId,
        "llm_response",
        {
          stage: "survey",
          title: surveyResult.data.title,
          document_type: surveyResult.data.document_type,
        },
        surveyResult.usage,
      );

      try {
        await updateEntity(entityId, {
          ver: entity.ver ?? entityVer,
          properties: { ...(entity.properties ?? {}), survey: surveyResult.data },
        });
      } catch (err) {
        console.warn(
          `[knowledge:pptx] Failed to persist survey on ${entityId}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    // 8. Group slides and fan out
    const totalGroups = Math.ceil(sourceEntityIds.length / SLIDES_PER_GROUP);
    appendLog(
      jobId,
      "info",
      `Grouping ${sourceEntityIds.length} slides into ${totalGroups} groups of ${SLIDES_PER_GROUP}`,
    );

    const childJobIds: string[] = [];
    for (let g = 0; g < totalGroups; g++) {
      const startIdx = g * SLIDES_PER_GROUP;
      const endIdx = Math.min(startIdx + SLIDES_PER_GROUP, sourceEntityIds.length);
      const groupSlideEntityIds = sourceEntityIds.slice(startIdx, endIdx);
      const groupSlideIndices = Array.from(
        { length: endIdx - startIdx },
        (_, i) => startIdx + i,
      );

      const childId = await createJob({
        entityId,
        entityVer,
        trigger: "system",
        jobType: "pptx.slide_group",
        parentJobId: jobId,
        metadata: {
          group_ordinal: g,
          total_groups: totalGroups,
          slide_entity_ids: groupSlideEntityIds,
          slide_indices: groupSlideIndices,
          source_entity_ids: sourceEntityIds,
          survey: surveyResult?.data,
          ...inheritedMeta,
        },
      });
      if (childId) childJobIds.push(childId);
    }

    appendLog(jobId, "info", `Created ${childJobIds.length} slide group jobs`);

    // Store metadata on parent for finalization
    await sql.query(
      `UPDATE knowledge_jobs SET metadata = $1 WHERE id = $2`,
      [
        JSON.stringify({
          source_entity_ids: sourceEntityIds,
        }),
        jobId,
      ],
    );

    await setJobStatus(jobId, "waiting");
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
