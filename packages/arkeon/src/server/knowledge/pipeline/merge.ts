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
import { isUlid } from "./write";

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
      // ULIDs are global identifiers from scout — never namespace them
      const namespacedRef = isUlid(entity.ref) ? entity.ref : prefix + entity.ref;
      const key = dedupeKey(entity.label, entity.type);
      const existing = entityMap.get(key);

      if (!existing || (entity.description || "").length > (existing.description || "").length) {
        entityMap.set(key, {
          op: "create_entity",
          ref: existing ? existing.ref : namespacedRef,
          label: entity.label,
          type: entity.type,
          description: entity.description,
          ...(entity.properties || existing?.properties ? { properties: { ...existing?.properties, ...entity.properties } } : {}),
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
        source_ref: isUlid(rel.source_ref) ? rel.source_ref : prefix + rel.source_ref,
        target_ref: isUlid(rel.target_ref) ? rel.target_ref : prefix + rel.target_ref,
      });
    }
  }

  const entities: ExtractOpEntity[] = [...entityMap.values()];

  // Build suffix→canonical map for cross-chunk ref resolution.
  // If chunk B references "location_phnom_penh" but only chunk A defined it,
  // the prefixed "c1_location_phnom_penh" won't be in refRewrite. Fall back to
  // matching the bare suffix against any chunk's canonical ref.
  const suffixToCanonical = new Map<string, string>();
  for (const [namespacedRef, canonicalRef] of refRewrite) {
    const bare = namespacedRef.replace(/^c\d+_/, "");
    // First writer wins — deduped by label+type already picked the canonical
    if (!suffixToCanonical.has(bare)) {
      suffixToCanonical.set(bare, canonicalRef);
    }
  }

  const seenRels = new Set<string>();
  const relationships: ExtractOpRelationship[] = [];
  for (const rel of allRelationships) {
    const resolvedSource = refRewrite.get(rel.source_ref)
      ?? suffixToCanonical.get(rel.source_ref.replace(/^c\d+_/, ""))
      ?? rel.source_ref;
    const resolvedTarget = refRewrite.get(rel.target_ref)
      ?? suffixToCanonical.get(rel.target_ref.replace(/^c\d+_/, ""))
      ?? rel.target_ref;
    // Entity dedup can cause two different refs to merge into one entity.
    // A relationship between those refs becomes a self-reference — drop it.
    if (resolvedSource === resolvedTarget) continue;

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
