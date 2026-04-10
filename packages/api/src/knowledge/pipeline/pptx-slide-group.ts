/**
 * pptx.slide_group handler: child job that processes a group of PPTX slides.
 *
 * For each slide entity in the group:
 *   - Reads the text from properties
 *   - If the slide needs vision (has image content), calls describePageImage()
 *   - Combines text + vision descriptions
 *
 * Then concatenates all slides, runs extractFromChunk(), stores the plan,
 * and tries to claim finalization (identical pattern to text.chunk_extract).
 */

import { LlmClient, type LlmUsage } from "../lib/llm";
import { resolveLlmConfig, getExtractionConfig } from "../lib/config";
import { getEntity } from "../lib/arke-client";
import { appendLog } from "../lib/logger";
import type { JobRecord } from "../queue";
import { setJobStatus } from "../queue";
import type { SqlClient } from "../../lib/sql";
import type { DocumentSurvey } from "../lib/types";

import { extractFromChunk } from "./extract";
import { describePageImage } from "./visual-describe";
import { claimFinalization, runGroupFinalization } from "./finalize";

export async function handlePptxSlideGroup(
  job: JobRecord,
  sql: SqlClient,
): Promise<void> {
  const jobId = job.id as string;
  const entityId = job.entity_id as string;
  const parentJobId = job.parent_job_id as string;
  const metadata = (job.metadata ?? {}) as Record<string, unknown>;
  const slideEntityIds = metadata.slide_entity_ids as string[];
  const slideIndices = metadata.slide_indices as number[];
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
  const sourceEntityIds = metadata.source_entity_ids as string[];

  if (!slideEntityIds?.length) throw new Error("No slide_entity_ids in pptx.slide_group metadata");
  if (!parentJobId) throw new Error("No parent_job_id for pptx.slide_group job");

  // Track vision LLM usage across slides
  let visionTokensIn = 0;
  let visionTokensOut = 0;
  let visionCalls = 0;
  let visionModel = "";

  // Process each slide in the group
  const slideTexts: string[] = [];
  for (let i = 0; i < slideEntityIds.length; i++) {
    const slideEntityId = slideEntityIds[i];
    const slideNumber = slideIndices[i] + 1; // 1-indexed for display

    const slideEntity = await getEntity(slideEntityId);
    if (!slideEntity) {
      appendLog(jobId, "error", `Slide entity ${slideEntityId} not found, skipping`);
      slideTexts.push("");
      continue;
    }

    const props = slideEntity.properties ?? {};
    let slideText = (props.text as string) ?? "";
    const needsVision = props.needs_vision as boolean;
    const contentMap = props.content as Record<string, unknown> | undefined;
    const hasSlideImage = contentMap && "slide_image" in contentMap;

    if (needsVision && hasSlideImage) {
      appendLog(jobId, "info", `Describing slide ${slideNumber} via vision LLM`);
      try {
        const imageEntry = (contentMap as any).slide_image;
        const imageMimeType = imageEntry?.content_type ?? "image/jpeg";

        const descResult = await describePageImage(
          slideEntityId,
          "slide_image",
          imageMimeType,
          slideNumber,
        );

        // For slides with thin/no text, the vision text replaces it.
        // For slides with existing text, append image descriptions.
        if (slideText.length < 50) {
          slideText = descResult.text;
        } else {
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
            slideText += "\n\n" + visionParts.join("\n\n");
          }
        }

        if (!visionModel && descResult.usage.model) visionModel = descResult.usage.model;
        visionTokensIn += descResult.usage.tokensIn;
        visionTokensOut += descResult.usage.tokensOut;
        visionCalls++;

        appendLog(jobId, "llm_response", {
          stage: "visual_describe",
          slide: slideNumber,
        }, descResult.usage);
      } catch (err) {
        appendLog(
          jobId,
          "error",
          `Vision describe failed for slide ${slideNumber}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    slideTexts.push(`--- Slide ${slideNumber} ---\n${slideText}`);
  }

  // Concatenate all slides
  const groupText = slideTexts.join("\n\n");

  if (groupText.trim().length === 0) {
    appendLog(jobId, "info", "No text content in slide group, completing with empty plan");
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
      `Extracting from slide group ${groupOrdinal + 1}/${totalGroups} (${groupText.length} chars)`,
    );
    const extractResult = await extractFromChunk(
      extractorLlm,
      groupText,
      {
        survey: survey ?? { title: "", document_type: "presentation", themes: [], key_actors: [], summary: "" },
        chunkOrdinal: groupOrdinal,
        totalChunks: totalGroups,
      },
      extractionConfig,
    );

    appendLog(jobId, "llm_response", {
      stage: "slide_group_extract",
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
    `[knowledge:queue] pptx.slide_group ${jobId} completed (group ${groupOrdinal + 1}/${totalGroups})`,
  );

  // Try to claim and run finalization
  const claimed = await claimFinalization(parentJobId, "pptx.slide_group", sql);
  if (claimed) {
    console.log(`[knowledge:queue] All ${totalGroups} slide groups complete, finalizing`);
    await runGroupFinalization(
      parentJobId,
      "pptx.slide_group",
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
