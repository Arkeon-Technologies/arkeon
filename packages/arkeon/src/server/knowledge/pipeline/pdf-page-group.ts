// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * pdf.page_group handler: child job that processes a group of PDF pages.
 *
 * For each page entity in the group:
 *   - Reads the text from properties
 *   - If the page needs vision (has image content), calls describePageImage()
 *   - Combines text + vision descriptions
 *
 * Then concatenates all pages, runs extractFromChunk(), stores the plan,
 * and tries to claim finalization (identical pattern to text.chunk_extract).
 */

import { LlmClient, type LlmUsage } from "../lib/llm";
import { resolveLlmConfig, getExtractionConfig } from "../lib/config";
import { getEntity } from "../lib/arke-client";
import { appendLog } from "../lib/logger";
import type { JobRecord } from "../queue";
import { setJobStatus } from "../queue";
import type { SqlClient } from "../../lib/sql";
import type { DocumentSurvey, SpaceExtractionConfig } from "../lib/types";

import { extractFromChunk } from "./extract";
import { describePageImage } from "./visual-describe";
import { claimFinalization, runGroupFinalization } from "./finalize";

export async function handlePdfPageGroup(
  job: JobRecord,
  sql: SqlClient,
): Promise<void> {
  const jobId = job.id as string;
  const entityId = job.entity_id as string;
  const parentJobId = job.parent_job_id as string;
  const metadata = (job.metadata ?? {}) as Record<string, unknown>;
  const pageEntityIds = metadata.page_entity_ids as string[];
  const pageIndices = metadata.page_indices as number[];
  const groupOrdinal = metadata.group_ordinal as number;
  const totalGroups = metadata.total_groups as number;
  const survey = metadata.survey as DocumentSurvey | undefined;
  const readLevel = metadata.read_level as number | undefined;
  const writeLevel = metadata.write_level as number | undefined;
  const ownerId = metadata.owner_id as string | undefined;
  const permissions = metadata.permissions as
    | Array<{ grantee_type: string; grantee_id: string; role: string }>
    | undefined;
  const spaceId = metadata.space_id as string | undefined;
  const spaceExtractionConfig = metadata.space_extraction_config as SpaceExtractionConfig | undefined;
  const sourceEntityIds = metadata.source_entity_ids as string[];

  if (!pageEntityIds?.length) throw new Error("No page_entity_ids in pdf.page_group metadata");
  if (!parentJobId) throw new Error("No parent_job_id for pdf.page_group job");

  // Track vision LLM usage across pages
  let visionTokensIn = 0;
  let visionTokensOut = 0;
  let visionCalls = 0;
  let visionModel = "";

  // Process each page in the group
  const pageTexts: string[] = [];
  for (let i = 0; i < pageEntityIds.length; i++) {
    const pageEntityId = pageEntityIds[i];
    const pageNumber = pageIndices[i] + 1; // 1-indexed for display

    const pageEntity = await getEntity(pageEntityId);
    if (!pageEntity) {
      appendLog(jobId, "error", `Page entity ${pageEntityId} not found, skipping`);
      pageTexts.push("");
      continue;
    }

    const props = pageEntity.properties ?? {};
    let pageText = (props.text as string) ?? "";
    const needsVision = props.needs_vision as boolean;
    const contentMap = props.content as Record<string, unknown> | undefined;
    const hasPageImage = contentMap && "page_image" in contentMap;

    if (needsVision && hasPageImage) {
      // Vision describe this page
      appendLog(jobId, "info", `Describing page ${pageNumber} via vision LLM`);
      try {
        const descResult = await describePageImage(
          pageEntityId,
          "page_image",
          "image/jpeg",
          pageNumber,
        );

        // For pages with thin/no text, the vision text replaces it.
        // For pages with existing text, append image descriptions.
        if (pageText.length < 50) {
          pageText = descResult.text;
        } else {
          // Keep programmatic text but append vision-described images/tables
          const visionParts: string[] = [];
          if (descResult.pageDescription.imageDescriptions?.length > 0) {
            for (const desc of descResult.pageDescription.imageDescriptions) {
              if (desc) visionParts.push(`[Image: ${desc}]`);
            }
          }
          if (descResult.pageDescription.tables?.length > 0) {
            for (const table of descResult.pageDescription.tables) {
              if (!table) continue;
              if (table.caption) visionParts.push(`Table: ${table.caption}`);
              if (table.markdown) visionParts.push(table.markdown);
            }
          }
          if (visionParts.length > 0) {
            pageText += "\n\n" + visionParts.join("\n\n");
          }
        }

        if (!visionModel && descResult.usage.model) visionModel = descResult.usage.model;
        visionTokensIn += descResult.usage.tokensIn;
        visionTokensOut += descResult.usage.tokensOut;
        visionCalls++;

        appendLog(jobId, "llm_response", {
          stage: "visual_describe",
          page: pageNumber,
        }, descResult.usage);
      } catch (err) {
        appendLog(
          jobId,
          "error",
          `Vision describe failed for page ${pageNumber}: ${err instanceof Error ? err.message : err}`,
        );
        // Fall through with whatever text we have
      }
    }

    pageTexts.push(`--- Page ${pageNumber} ---\n${pageText}`);
  }

  // Concatenate all pages
  const groupText = pageTexts.join("\n\n");

  if (groupText.trim().length === 0) {
    appendLog(jobId, "info", "No text content in page group, completing with empty plan");
    await setJobStatus(jobId, "completed", {
      result: {
        plan: { entities: [], relationships: [] },
        groupOrdinal,
      },
      tokens_in: visionTokensIn,
      tokens_out: visionTokensOut,
      llm_calls: visionCalls,
      model: visionModel || undefined,
    });
  } else {
    // Extract entities from the group text
    const extractorConfig = await resolveLlmConfig("extractor");
    const extractorLlm = new LlmClient(extractorConfig);
    const extractionConfig = await getExtractionConfig();

    appendLog(
      jobId,
      "info",
      `Extracting from page group ${groupOrdinal + 1}/${totalGroups} (${groupText.length} chars)`,
    );
    const extractResult = await extractFromChunk(
      extractorLlm,
      groupText,
      {
        survey: survey ?? { title: "", document_type: "document", themes: [], key_actors: [], summary: "" },
        chunkOrdinal: groupOrdinal,
        totalChunks: totalGroups,
      },
      extractionConfig,
      spaceExtractionConfig,
    );

    appendLog(jobId, "llm_response", {
      stage: "page_group_extract",
      group: groupOrdinal,
      entities: extractResult.data.entities.length,
      relationships: extractResult.data.relationships.length,
    }, extractResult.usage);

    await setJobStatus(jobId, "completed", {
      result: {
        plan: extractResult.data,
        groupOrdinal,
      },
      model: extractResult.usage.model || visionModel || undefined,
      tokens_in: visionTokensIn + extractResult.usage.tokensIn,
      tokens_out: visionTokensOut + extractResult.usage.tokensOut,
      llm_calls: visionCalls + 1,
    });
  }

  console.log(
    `[knowledge:queue] pdf.page_group ${jobId} completed (group ${groupOrdinal + 1}/${totalGroups})`,
  );

  // Try to claim and run finalization
  const claimed = await claimFinalization(parentJobId, "pdf.page_group", sql);
  if (claimed) {
    console.log(`[knowledge:queue] All ${totalGroups} page groups complete, finalizing`);
    await runGroupFinalization(
      parentJobId,
      "pdf.page_group",
      {
        jobId: parentJobId,
        documentId: entityId,
        spaceId,
        readLevel,
        writeLevel,
        ownerId,
        permissions,
      },
      sql,
    );
  }
}
