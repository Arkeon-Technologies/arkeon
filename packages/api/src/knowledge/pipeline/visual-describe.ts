// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Visual description utility: image in, text out.
 *
 * NOT a queue job handler. Called by group jobs (pdf.page_group, etc.)
 * when source entities have images that need multimodal LLM description.
 */

import { LlmClient, type LlmUsage } from "../lib/llm";
import { resolveLlmConfig } from "../lib/config";
import type { VisualPageDescription } from "../lib/types";
import { getEntityContentBytes } from "../lib/arke-client";

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const VISUAL_DESCRIBE_PROMPT = `You are a document page analyzer. Given a page image, extract all content into structured JSON.

Produce:
- "text": ALL text on the page, faithfully preserving structure (headings, lists, paragraphs, captions). Do not summarize — transcribe exactly.
- "imageDescriptions": An array of strings, one per visual element (charts, diagrams, photos, maps, logos, figures). Describe what is depicted, any labels/legends, and the key takeaway.
- "tables": An array of objects with optional "caption" and "markdown" (the table rendered as a markdown table).

Return JSON:
{
  "text": "...",
  "imageDescriptions": ["Bar chart showing Q3 revenue by region..."],
  "tables": [{ "caption": "Revenue by Region", "markdown": "| Region | Revenue |\\n|---|---|\\n| NA | $2.1M |" }]
}

Rules:
- Transcribe text exactly as it appears — do not paraphrase or omit
- For scanned/handwritten text, do your best OCR and note uncertainty with [unclear: ...]
- Describe ALL visual elements, not just the prominent ones
- Tables must be valid markdown
- If the page is blank or has no meaningful content, return empty text and empty arrays`;

// ---------------------------------------------------------------------------
// Flatten structured result to plain text
// ---------------------------------------------------------------------------

export function flattenToText(page: VisualPageDescription, pageNumber: number): string {
  const parts: string[] = [];

  parts.push(`--- Page ${pageNumber} ---`);

  if (page.text?.trim()) {
    parts.push(page.text.trim());
  }

  if (page.imageDescriptions?.length > 0) {
    for (const desc of page.imageDescriptions) {
      if (desc) parts.push(`[Image: ${desc}]`);
    }
  }

  if (page.tables?.length > 0) {
    for (const table of page.tables) {
      if (!table) continue;
      if (table.caption) parts.push(`Table: ${table.caption}`);
      if (table.markdown) parts.push(table.markdown);
    }
  }

  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface DescribePageResult {
  text: string;
  pageDescription: VisualPageDescription;
  usage: LlmUsage;
}

const MAX_IMAGE_BYTES = 15 * 1024 * 1024; // 15MB — OpenAI vision limit is 20MB

/**
 * Describe a single page image via multimodal LLM.
 * Fetches image from entity content, returns flattened text.
 */
export async function describePageImage(
  entityId: string,
  contentKey: string,
  imageMimeType: string,
  pageNumber: number,
): Promise<DescribePageResult> {
  const imageBytes = await getEntityContentBytes(entityId, contentKey);
  if (imageBytes.length > MAX_IMAGE_BYTES) {
    throw new Error(`Image too large for vision API: ${(imageBytes.length / 1024 / 1024).toFixed(1)}MB (max ${MAX_IMAGE_BYTES / 1024 / 1024}MB)`);
  }
  const imageBase64 = imageBytes.toString("base64");

  const visualConfig = await resolveLlmConfig("visual");
  const visualLlm = new LlmClient(visualConfig);

  const mimeType = imageMimeType || "image/jpeg";
  const content: Array<
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string } }
  > = [
    { type: "text", text: `Analyze this document page image (page ${pageNumber}). Return structured JSON.` },
    { type: "image_url", image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
  ];

  const result = await visualLlm.chatVision<VisualPageDescription>(
    VISUAL_DESCRIBE_PROMPT,
    content,
    { maxTokens: 16_384 },
  );

  const pageDescription = result.data;
  const text = flattenToText(pageDescription, pageNumber);

  return { text, pageDescription, usage: result.usage };
}
