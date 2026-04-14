// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Entity/relationship extraction from document text via LLM.
 * Single LLM call with JSON mode -> structured ExtractPlan.
 *
 * Supports per-space extraction config (entity_types, predicates,
 * label_instructions, context) stored in space.properties.extraction.
 * Space config overrides global config when present.
 */

import { LlmClient, type ChatJsonResult } from "../lib/llm";
import type { ExtractPlan, ExtractOpEntity, ExtractOpRelationship, DocumentSurvey, TextChunk, SpaceExtractionConfig } from "../lib/types";
import type { ExtractionConfig } from "../lib/config";

function buildSystemPrompt(
  config: ExtractionConfig,
  surveyTypes?: string[],
  spaceConfig?: SpaceExtractionConfig,
): string {
  let prompt = "";

  // Space context — prepended first so the LLM has domain context
  if (spaceConfig?.context) {
    prompt += `Context about this document collection:\n${spaceConfig.context}\n\n`;
  }

  prompt += `You are building a detailed knowledge graph from a document.

Extract ALL meaningful entities and the relationships between them. Be thorough — capture not just the main subjects but also events, actions, places, concepts, and supporting details.

Return JSON:
{
  "entities": [
    {
      "ref": "person_jane",
      "label": "Jane Smith",
      "type": "person",
      "description": "CEO of Acme Corp who announced the Q3 restructuring. Described as 'a decisive leader who transformed the company' (para 3)."
    },
    {
      "ref": "event_restructuring",
      "label": "Q3 Restructuring",
      "type": "event",
      "description": "Major corporate reorganization announced in October 2024, affecting 3 divisions."
    }
  ],
  "relationships": [
    {
      "source_ref": "person_jane",
      "predicate": "announced",
      "target_ref": "event_restructuring",
      "source_span": "Jane Smith announced a sweeping restructuring of three major divisions",
      "detail": "Announced during the Q3 earnings call, affecting engineering, sales, and operations."
    }
  ]
}

Rules:
- Extract comprehensively: people, organizations, locations, events, concepts, objects, works — anything meaningful
- Each real-world entity gets exactly ONE entry — never duplicate
- Give each entity a short stable ref like "person_jane" or "event_battle"
- Descriptions should be rich and cite the source text (quote key phrases)
- source_span: a verbatim quote from the text where this relationship is stated
- detail: explain the relationship fully — context, nuance, significance
- Use specific predicates (e.g. "founded", "betrayed", "traveled_to") not generic ones ("relates_to")
- source_ref and target_ref MUST match a ref from entities
- You may include additional domain-specific properties as top-level keys on entities and relationships (alongside ref/label/type/description). If the additional instructions below request specific properties, include them on every entity or relationship as directed`;

  // Entity types: space config (always strict) > strict global > survey-inferred > suggestions
  if (spaceConfig?.entity_types && spaceConfig.entity_types.length > 0) {
    prompt += `\n\nEntity types (use ONLY these): ${spaceConfig.entity_types.join(", ")}`;
  } else if (config.strict_entity_types && config.entity_types.length > 0) {
    prompt += `\n\nEntity types (use ONLY these): ${config.entity_types.join(", ")}`;
  } else if (surveyTypes && surveyTypes.length > 0) {
    prompt += `\n\nEntity types for this document (use these types): ${surveyTypes.join(", ")}`;
  } else if (config.entity_types.length > 0) {
    prompt += `\n\nSuggested entity types (use others if they fit better): ${config.entity_types.join(", ")}`;
  }

  // Predicates: space config (always strict) > strict global > suggestions
  if (spaceConfig?.predicates && spaceConfig.predicates.length > 0) {
    prompt += `\nRelationship predicates (use ONLY these): ${spaceConfig.predicates.join(", ")}`;
  } else if (config.predicates.length > 0) {
    const predList = config.predicates.join(", ");
    if (config.strict_predicates) {
      prompt += `\nRelationship predicates (use ONLY these): ${predList}`;
    } else {
      prompt += `\nSuggested predicates (use any that fits): ${predList}`;
    }
  }

  // Label instructions from space
  if (spaceConfig?.label_instructions) {
    prompt += `\n\nLabel conventions:\n${spaceConfig.label_instructions}`;
  }

  // Global custom instructions still apply
  if (config.custom_instructions) {
    prompt += `\n\nAdditional instructions:\n${config.custom_instructions}`;
  }

  return prompt;
}

/** Collect any keys not in the known set into a properties bag. Returns null if empty. */
function collectExtra(obj: any, knownKeys: Set<string>): Record<string, unknown> | null {
  if (!obj || typeof obj !== "object") return null;
  const extra: Record<string, unknown> = {};
  let hasAny = false;
  for (const [key, value] of Object.entries(obj)) {
    if (!knownKeys.has(key) && value !== undefined) {
      extra[key] = value;
      hasAny = true;
    }
  }
  return hasAny ? extra : null;
}

/**
 * Normalize LLM response into { entities, relationships }.
 * Handles: { entities, relationships }, { ops: [...] }, or mixed formats.
 */
function normalizePlan(raw: any): ExtractPlan {
  const entities: ExtractOpEntity[] = [];
  const relationships: ExtractOpRelationship[] = [];

  // Known keys to exclude from custom properties
  const ENTITY_KNOWN_KEYS = new Set(["op", "ref", "label", "type", "description"]);
  const REL_KNOWN_KEYS = new Set(["op", "source_ref", "predicate", "target_ref", "source_span", "detail", "source_shell", "target_shell"]);

  // Preferred format: { entities: [...], relationships: [...] }
  if (Array.isArray(raw.entities)) {
    for (const e of raw.entities) {
      const properties = collectExtra(e, ENTITY_KNOWN_KEYS);
      entities.push({
        op: "create_entity", ref: e.ref, label: e.label, type: e.type, description: e.description ?? "",
        ...(properties ? { properties } : {}),
      });
    }
  }
  if (Array.isArray(raw.relationships)) {
    for (const r of raw.relationships) {
      const properties = collectExtra(r, REL_KNOWN_KEYS);
      relationships.push({
        op: "create_relationship",
        source_ref: r.source_ref,
        predicate: r.predicate,
        target_ref: r.target_ref,
        source_span: r.source_span ?? "",
        detail: r.detail,
        source_shell: r.source_shell,
        target_shell: r.target_shell,
        ...(properties ? { properties } : {}),
      });
    }
  }

  // Legacy format: { ops: [...] }
  if (Array.isArray(raw.ops)) {
    for (const op of raw.ops) {
      if (op.op === "create_entity") {
        entities.push(op);
      } else if (op.op === "create_relationship") {
        relationships.push(op);
      }
    }
  }

  return { entities, relationships };
}

export async function extractFromDocument(
  llm: LlmClient,
  documentText: string,
  config: ExtractionConfig,
  spaceConfig?: SpaceExtractionConfig,
): Promise<ChatJsonResult<ExtractPlan>> {
  const systemPrompt = buildSystemPrompt(config, undefined, spaceConfig);

  const result = await llm.chatJson<any>(systemPrompt, documentText, {
    maxTokens: 16_384,
  });

  return { data: normalizePlan(result.data), usage: result.usage };
}

// ---------------------------------------------------------------------------
// Chunk-level extraction (for large documents)
// ---------------------------------------------------------------------------

function buildChunkSystemPrompt(
  config: ExtractionConfig,
  survey: DocumentSurvey,
  chunkOrdinal: number,
  totalChunks: number,
  spaceConfig?: SpaceExtractionConfig,
): string {
  const basePrompt = buildSystemPrompt(config, survey.entity_types, spaceConfig);

  const contextBlock = `Document context:
You are extracting chunk ${chunkOrdinal + 1} of ${totalChunks} from a ${survey.document_type} titled "${survey.title}".
Themes: ${survey.themes.join(", ")}.
Key actors: ${survey.key_actors.join(", ")}.
Summary: ${survey.summary}

Focus only on entities and relationships present in this chunk's text. Do not invent information not in the text.`;

  return contextBlock + "\n\n" + basePrompt;
}

export async function extractFromChunk(
  llm: LlmClient,
  chunkText: string,
  context: {
    survey: DocumentSurvey;
    chunkOrdinal: number;
    totalChunks: number;
  },
  config: ExtractionConfig,
  spaceConfig?: SpaceExtractionConfig,
): Promise<ChatJsonResult<ExtractPlan>> {
  const systemPrompt = buildChunkSystemPrompt(
    config,
    context.survey,
    context.chunkOrdinal,
    context.totalChunks,
    spaceConfig,
  );

  const result = await llm.chatJson<any>(systemPrompt, chunkText, {
    maxTokens: 16_384,
  });

  return { data: normalizePlan(result.data), usage: result.usage };
}

/** Simple concurrency limiter (used for internal parallel operations) */
function limitConcurrency<T>(
  tasks: (() => Promise<T>)[],
  maxConcurrent: number,
): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const results: T[] = new Array(tasks.length);
    let nextIndex = 0;
    let completed = 0;
    let hasError = false;

    function runNext() {
      if (hasError) return;
      const index = nextIndex++;
      if (index >= tasks.length) return;

      tasks[index]()
        .then((result) => {
          if (hasError) return;
          results[index] = result;
          completed++;
          if (completed === tasks.length) {
            resolve(results);
          } else {
            runNext();
          }
        })
        .catch((err) => {
          if (!hasError) {
            hasError = true;
            reject(err);
          }
        });
    }

    const initialBatch = Math.min(maxConcurrent, tasks.length);
    for (let i = 0; i < initialBatch; i++) {
      runNext();
    }
  });
}

const DEFAULT_CHUNK_CONCURRENCY = Infinity;

export async function extractAllChunks(
  llm: LlmClient,
  chunks: TextChunk[],
  survey: DocumentSurvey,
  config: ExtractionConfig,
  spaceConfig?: SpaceExtractionConfig,
): Promise<ChatJsonResult<ExtractPlan>[]> {
  const concurrency = Number(process.env.CHUNK_EXTRACT_CONCURRENCY) || DEFAULT_CHUNK_CONCURRENCY;

  const tasks = chunks.map((chunk) => () =>
    extractFromChunk(llm, chunk.text, {
      survey,
      chunkOrdinal: chunk.ordinal,
      totalChunks: chunks.length,
    }, config, spaceConfig),
  );

  return limitConcurrency(tasks, concurrency);
}
