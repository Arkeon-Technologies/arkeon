// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Document survey: characterize a large document before chunk extraction.
 */

import { LlmClient, type ChatJsonResult } from "../lib/llm";
import type { DocumentSurvey } from "../lib/types";

const HEAD_CHARS = 6_000;
const TAIL_CHARS = 2_000;
const MIDDLE_SAMPLE_CHARS = 4_000;
const MIDDLE_SAMPLE_COUNT = 3;

const SURVEY_PROMPT = `You are analyzing a document to prepare for detailed knowledge graph extraction.

Given representative samples from a document, characterize it and define the vocabulary of entity types that should be used when extracting.

Return JSON:
{
  "title": "The document's title or a descriptive title if none is obvious",
  "document_type": "e.g. novel, research paper, legal contract, meeting transcript, technical manual, news article, etc.",
  "themes": ["3-8 key themes or topics covered"],
  "key_actors": ["Named people, organizations, or entities that are likely important throughout the document"],
  "summary": "2-3 sentence overview of what this document is about",
  "entity_types": ["person", "location", "event", "..."]
}

Rules:
- Base your analysis ONLY on the provided samples
- If the document type is unclear, make your best guess
- key_actors should be proper nouns (named entities), not generic roles
- themes should be specific to this document, not generic categories
- entity_types: list 6-15 types that capture all the kinds of things in this document. Use simple lowercase labels. Include both obvious types (person, location) and domain-specific ones (e.g. "spell" for fantasy, "legal_clause" for contracts, "chemical_compound" for science papers). These will be the ONLY types used during extraction, so be comprehensive.`;

function sampleDocument(text: string): string {
  const parts: string[] = [];

  const headEnd = snapToParagraphEnd(text, HEAD_CHARS);
  parts.push("=== BEGINNING OF DOCUMENT ===\n" + text.slice(0, headEnd));

  if (text.length > HEAD_CHARS + TAIL_CHARS) {
    const tailStart = snapToParagraphStart(text, text.length - TAIL_CHARS);
    parts.push("=== END OF DOCUMENT ===\n" + text.slice(tailStart));
  }

  const middleStart = headEnd;
  const middleEnd = text.length - TAIL_CHARS;
  if (middleEnd > middleStart + MIDDLE_SAMPLE_CHARS) {
    const availableRange = middleEnd - middleStart - MIDDLE_SAMPLE_CHARS;
    const positions = pickRandomPositions(availableRange, MIDDLE_SAMPLE_COUNT);

    for (let i = 0; i < positions.length; i++) {
      const start = snapToParagraphStart(text, middleStart + positions[i]);
      const end = snapToParagraphEnd(text, start + MIDDLE_SAMPLE_CHARS);
      parts.push(`=== MIDDLE SAMPLE ${i + 1} ===\n` + text.slice(start, end));
    }
  }

  return parts.join("\n\n");
}

function snapToParagraphStart(text: string, pos: number): number {
  if (pos <= 0) return 0;
  if (pos >= text.length) return text.length;
  const nextBreak = text.indexOf("\n\n", pos);
  if (nextBreak !== -1 && nextBreak - pos < 500) {
    let start = nextBreak + 2;
    while (start < text.length && text[start] === "\n") start++;
    return start;
  }
  return pos;
}

function snapToParagraphEnd(text: string, pos: number): number {
  if (pos >= text.length) return text.length;
  const nextBreak = text.indexOf("\n\n", pos);
  if (nextBreak !== -1 && nextBreak - pos < 500) {
    return nextBreak;
  }
  return Math.min(pos, text.length);
}

function pickRandomPositions(range: number, count: number): number[] {
  if (range <= 0 || count <= 0) return [];
  const step = Math.floor(range / (count + 1));
  const positions: number[] = [];
  for (let i = 1; i <= count; i++) {
    const base = step * i;
    const jitter = Math.floor(step * 0.1 * (Math.random() * 2 - 1));
    positions.push(Math.max(0, Math.min(range, base + jitter)));
  }
  return positions;
}

export async function surveyDocument(
  llm: LlmClient,
  text: string,
): Promise<ChatJsonResult<DocumentSurvey>> {
  const sample = sampleDocument(text);
  return llm.chatJson<DocumentSurvey>(SURVEY_PROMPT, sample, {
    maxTokens: 2048,
  });
}
