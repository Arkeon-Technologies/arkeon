// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * pdf.extract handler: parent job for PDF ingestion.
 *
 * Extracts text per page via pdfjs-dist, renders pages to JPEG via pdftoppm,
 * creates page entities, uploads images for pages needing vision,
 * then fans out pdf.page_group child jobs.
 *
 * All vision LLM calls happen in the children, not here.
 */

import { readFile, writeFile, mkdir, mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

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
import { createJob, setJobStatus, getJobSignal } from "../queue";
import type { SqlClient } from "../../lib/sql";

import { writeSourceEntities } from "./write";
import { surveyDocument } from "./survey";
import { estimateTokens, CHUNK_THRESHOLD_TOKENS } from "./chunk";

const execFileAsync = promisify(execFile);

const PAGES_PER_GROUP = 5;
const PDFTOPPM_DPI = 150;
const VISION_TEXT_THRESHOLD = 50; // chars below which a page needs OCR

// ---------------------------------------------------------------------------
// PDF text extraction via pdfjs-dist
// ---------------------------------------------------------------------------

interface PageText {
  pageNumber: number;
  text: string;
}

async function extractTextPerPage(pdfBytes: Buffer): Promise<PageText[]> {
  const data = new Uint8Array(pdfBytes);
  const pdf = await getDocument({ data, useSystemFonts: true }).promise;
  const pages: PageText[] = [];

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();
    const text = textContent.items
      .map((item: any) => item.str)
      .join("");
    pages.push({ pageNumber: i, text: text.trim() });
  }

  return pages;
}

// ---------------------------------------------------------------------------
// PDF page rendering via pdftoppm
// ---------------------------------------------------------------------------

async function renderPagesToJpeg(
  pdfPath: string,
  outputDir: string,
): Promise<string[]> {
  await mkdir(outputDir, { recursive: true });
  const prefix = join(outputDir, "page");

  await execFileAsync("pdftoppm", [
    "-jpeg",
    "-r", String(PDFTOPPM_DPI),
    pdfPath,
    prefix,
  ]);

  const files = await readdir(outputDir);
  return files
    .filter((f) => f.endsWith(".jpg"))
    .sort()
    .map((f) => join(outputDir, f));
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handlePdfExtract(
  job: JobRecord,
  sql: SqlClient,
): Promise<void> {
  const jobId = job.id as string;
  const entityId = job.entity_id as string;
  const entityVer = job.entity_ver as number;
  const parentJobId = job.parent_job_id as string;
  const metadata = (job.metadata ?? {}) as Record<string, unknown>;
  const contentKey = metadata.content_key as string;
  const pdfMode = metadata.pdf_mode as string | undefined; // "ocr" to force all pages through vision
  const readLevel = metadata.read_level as number | undefined;
  const writeLevel = metadata.write_level as number | undefined;
  const ownerId = metadata.owner_id as string | undefined;
  const permissions = metadata.permissions as
    | Array<{ grantee_type: string; grantee_id: string; role: string }>
    | undefined;
  const spaceId = metadata.space_id as string | undefined;
  const spaceExtractionConfig = metadata.space_extraction_config;

  if (!contentKey) throw new Error("No content_key in pdf.extract metadata");

  const signal = getJobSignal(jobId);
  const extractionConfig = await getExtractionConfig();
  const inheritedMeta = {
    read_level: readLevel,
    write_level: writeLevel,
    owner_id: ownerId,
    permissions,
    space_id: spaceId,
    space_extraction_config: spaceExtractionConfig,
  };

  // 1. Fetch PDF bytes
  appendLog(jobId, "info", `Fetching PDF content (key: ${contentKey})`);
  const pdfBytes = await getEntityContentBytes(entityId, contentKey);

  // 2. Extract text per page
  appendLog(jobId, "info", "Extracting text layer per page");
  const pageTexts = await extractTextPerPage(pdfBytes);
  appendLog(jobId, "info", `Extracted text from ${pageTexts.length} pages`);

  // 3. Render pages to JPEG and upload (in try/finally for cleanup).
  // Created lazily below only when vision rendering is needed. Using
  // mkdtemp gives us a unique, unguessable directory under the OS temp
  // dir — avoids symlink attacks and collisions between concurrent jobs.
  let tmpDir: string | null = null;

  // Per-page: decide if it needs vision
  const needsVision = pageTexts.map(
    (p) => pdfMode === "ocr" || p.text.length < VISION_TEXT_THRESHOLD,
  );
  const visionPageCount = needsVision.filter(Boolean).length;
  appendLog(
    jobId,
    "info",
    `${visionPageCount}/${pageTexts.length} pages need vision (mode: ${pdfMode ?? "auto"})`,
  );

  // 4. Get entity for label
  const entity = await getEntity(entityId);
  const parentLabel = entity?.properties?.label ?? `Entity ${entityId}`;

  // 5. Create page entities
  appendLog(jobId, "info", "Creating page entities");
  const { sourceEntityIds } = await writeSourceEntities(
    pageTexts.map((p, i) => ({
      label: `${parentLabel} - p.${p.pageNumber}`,
      type: "pdf_page",
      ordinal: i,
      text: p.text || undefined,
      properties: {
        page_number: p.pageNumber,
        needs_vision: needsVision[i],
      },
    })),
    entityId,
    { spaceId, readLevel, writeLevel, ownerId, permissions },
  );
  appendLog(jobId, "info", `Created ${sourceEntityIds.length} page entities`);

  // 6. Render + upload page images for pages needing vision (with temp cleanup)
  if (visionPageCount > 0) {
    tmpDir = await mkdtemp(join(tmpdir(), "arke-pdf-"));
    try {
      appendLog(jobId, "info", "Rendering pages to JPEG via pdftoppm");
      const pdfPath = join(tmpDir, "input.pdf");
      await writeFile(pdfPath, pdfBytes);
      const pageImagePaths = await renderPagesToJpeg(pdfPath, join(tmpDir, "pages"));
      appendLog(jobId, "info", `Rendered ${pageImagePaths.length} page images`);

      appendLog(jobId, "info", "Uploading page images to entities");
      for (let i = 0; i < pageTexts.length; i++) {
        if (!needsVision[i]) continue;
        if (i >= pageImagePaths.length) break;

        const imageBytes = await readFile(pageImagePaths[i]);
        await uploadEntityContent(
          sourceEntityIds[i],
          "page_image",
          1, // freshly created entities are at ver=1
          Buffer.from(imageBytes),
          "image/jpeg",
        );
      }
    } finally {
      if (tmpDir) {
        await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  // 7. Survey (optional, for large PDFs)
  const fullText = pageTexts.map((p) => p.text).join("\n\n");
  const totalTokens = estimateTokens(fullText);
  let surveyResult: Awaited<ReturnType<typeof surveyDocument>> | undefined;

  if (totalTokens > CHUNK_THRESHOLD_TOKENS) {
    appendLog(jobId, "info", "Surveying document");
    const extractorConfig = await resolveLlmConfig("extractor");
    const extractorLlm = new LlmClient(extractorConfig);
    surveyResult = await surveyDocument(extractorLlm, fullText, signal);
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

    // Persist survey on source entity
    try {
      await updateEntity(entityId, {
        ver: entity.ver ?? entityVer,
        properties: { ...(entity.properties ?? {}), survey: surveyResult.data },
      });
    } catch (err) {
      console.warn(
        `[knowledge:pdf] Failed to persist survey on ${entityId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // 8. Group pages
  const pagesPerGroup = PAGES_PER_GROUP;
  const totalGroups = Math.ceil(sourceEntityIds.length / pagesPerGroup);
  appendLog(jobId, "info", `Grouping ${sourceEntityIds.length} pages into ${totalGroups} groups of ${pagesPerGroup}`);

  // 9. Fan out child jobs
  const childJobIds: string[] = [];
  for (let g = 0; g < totalGroups; g++) {
    const startIdx = g * pagesPerGroup;
    const endIdx = Math.min(startIdx + pagesPerGroup, sourceEntityIds.length);
    const groupPageEntityIds = sourceEntityIds.slice(startIdx, endIdx);
    const groupPageIndices = Array.from({ length: endIdx - startIdx }, (_, i) => startIdx + i);

    const childId = await createJob({
      entityId,
      entityVer,
      trigger: "system",
      jobType: "pdf.page_group",
      parentJobId: jobId,
      metadata: {
        group_ordinal: g,
        total_groups: totalGroups,
        page_entity_ids: groupPageEntityIds,
        page_indices: groupPageIndices,
        source_entity_ids: sourceEntityIds,
        survey: surveyResult?.data,
        ...inheritedMeta,
      },
    });
    if (childId) childJobIds.push(childId);
  }

  appendLog(jobId, "info", `Created ${childJobIds.length} page group jobs`);

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
}
