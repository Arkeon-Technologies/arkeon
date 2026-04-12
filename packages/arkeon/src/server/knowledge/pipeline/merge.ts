// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Cross-chunk merge: combines per-chunk ExtractPlans into a single plan,
 * deduplicating entities that appear in multiple chunks.
 */

import type {
  ExtractPlan,
  ExtractOpEntity,
  ExtractOpRelationship,
} from "../lib/types";
import type { ChatJsonResult } from "../lib/llm";
import { normalizeLabel as normalize } from "../lib/normalize";

function dedupeKey(label: string, type: string): string {
  return `${normalize(label || "")}::${(type || "unknown").toLowerCase()}`;
}

export interface MergeResult {
  plan: ExtractPlan;
  /** Maps entity ref -> source ordinal (chunk, page group, etc.) that produced it */
  refToSourceOrdinal: Map<string, number>;
}

export function mergeGroupPlans(
  chunkResults: ChatJsonResult<ExtractPlan>[],
): MergeResult {
  const entityMap = new Map<string, ExtractOpEntity>();
  const refRewrite = new Map<string, string>();
  const entitySourceChunk = new Map<string, number>();
  const allRelationships: ExtractOpRelationship[] = [];

  for (let i = 0; i < chunkResults.length; i++) {
    const plan = chunkResults[i].data;
    const prefix = `c${i}_`;

    for (const entity of plan.entities ?? []) {
      if (!entity.ref || !entity.label) continue;
      const namespacedRef = prefix + entity.ref;
      const key = dedupeKey(entity.label, entity.type);
      const existing = entityMap.get(key);

      if (!existing || (entity.description || "").length > (existing.description || "").length) {
        entityMap.set(key, {
          op: "create_entity",
          ref: existing ? existing.ref : namespacedRef,
          label: entity.label,
          type: entity.type,
          description: entity.description,
        });
        refRewrite.set(namespacedRef, existing ? existing.ref : namespacedRef);
        entitySourceChunk.set(existing ? existing.ref : namespacedRef, i);
      } else {
        refRewrite.set(namespacedRef, existing.ref);
      }
    }

    for (const rel of plan.relationships ?? []) {
      allRelationships.push({
        ...rel,
        source_ref: prefix + rel.source_ref,
        target_ref: prefix + rel.target_ref,
      });
    }
  }

  const entities: ExtractOpEntity[] = [...entityMap.values()];

  const seenRels = new Set<string>();
  const relationships: ExtractOpRelationship[] = [];
  for (const rel of allRelationships) {
    const resolvedSource = refRewrite.get(rel.source_ref) ?? rel.source_ref;
    const resolvedTarget = refRewrite.get(rel.target_ref) ?? rel.target_ref;
    const relKey = `${resolvedSource}::${rel.predicate}::${resolvedTarget}`;

    if (seenRels.has(relKey)) continue;
    seenRels.add(relKey);

    relationships.push({
      ...rel,
      source_ref: resolvedSource,
      target_ref: resolvedTarget,
    });
  }

  return { plan: { entities, relationships }, refToSourceOrdinal: entitySourceChunk };
}
