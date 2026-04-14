// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Types for the extract-resolve-write pipeline.
 */

// --- Extract stage output ---

export interface ExtractOpEntity {
  op: "create_entity";
  ref: string;
  label: string;
  type: string;
  description: string;
}

export interface ExtractOpRelationship {
  op: "create_relationship";
  source_ref: string;
  predicate: string;
  target_ref: string;
  source_span: string;
  detail?: string;
  /** Inline entity definition for a source that wasn't explicitly extracted */
  source_shell?: {
    label: string;
    type: string;
    description?: string;
  };
  /** Inline entity definition for a target that wasn't explicitly extracted */
  target_shell?: {
    label: string;
    type: string;
    description?: string;
  };
}

export type ExtractOp = ExtractOpEntity | ExtractOpRelationship;

export interface ExtractPlan {
  entities: ExtractOpEntity[];
  relationships: ExtractOpRelationship[];
}

// --- Resolve stage ---

export interface EntityCandidate {
  id: string;
  label: string;
  type: string;
  description?: string;
}

export interface MergeDecision {
  self_ref: string;
  self_label: string;
  same_as_ids: string[];
  different_ids: string[];
  rationale: string;
}

// --- Rewrite stage ---

export interface CanonicalEntity {
  ref: string;
  /** If set, this entity already exists in the graph — don't create, just link */
  canonical_id?: string;
  label: string;
  type: string;
  description: string;
}

export interface CanonicalRelationship {
  source_ref: string;
  target_ref: string;
  source_id?: string;
  target_id?: string;
  predicate: string;
  source_span: string;
  detail?: string;
}

// --- Write stage ---

export interface WriteResult {
  createdEntityIds: string[];
  updatedEntityIds: string[];
  createdRelationshipIds: string[];
  refToId: Record<string, string>;
}

// --- Space extraction config ---

/** Per-space extraction schema stored in space.properties.extraction */
export interface SpaceExtractionConfig {
  entity_types?: string[];
  predicates?: string[];
  label_instructions?: string;
  context?: string;
}

// --- Content routing ---

export interface ContentResult {
  text: string;
  mimeType?: string;
  sourceKey?: string;
}

// --- Document survey ---

export interface DocumentSurvey {
  title: string;
  document_type: string;
  themes: string[];
  key_actors: string[];
  summary: string;
  /** Entity types inferred from the document content */
  entity_types?: string[];
}

// --- Chunking ---

export interface TextChunk {
  text: string;
  ordinal: number;
  startOffset: number;
  endOffset: number;
}

// --- Visual describe (single page) ---

export interface VisualPageDescription {
  text: string;
  imageDescriptions: string[];
  tables: { caption?: string; markdown: string }[];
}

// --- Full pipeline result ---

export interface IngestResult {
  documentId: string;
  extractedEntities: number;
  extractedRelationships: number;
  createdEntities: number;
  createdRelationships: number;
  potentialDuplicates: number;
  chunksCreated?: number;
  usage: {
    model: string;
    tokens_in: number;
    tokens_out: number;
    llm_calls: number;
  };
}
