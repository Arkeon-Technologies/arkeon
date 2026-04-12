// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Convert implicit entity references (source_shell/target_shell)
 * into explicit entities.
 *
 * Also deduplicates shells against existing entities by label+type,
 * so if the LLM creates "Moon" as an entity AND includes a shell
 * for "Moon" on a relationship, the shell reuses the existing ref.
 */

import type { ExtractOpEntity, ExtractOpRelationship, ExtractPlan } from "../lib/types";

function normalizeLabel(label: string): string {
  return label.toLowerCase().replace(/\s+/g, " ").trim();
}

function labelTypeKey(label: string, type: string): string {
  return `${normalizeLabel(label)}::${type.toLowerCase()}`;
}

function makeShellRef(prefix: "source" | "target", label: string, index: number): string {
  return `${prefix}_${label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "")}_${index}`;
}

export function materializeShellEntities(plan: ExtractPlan): ExtractPlan {
  const entities: ExtractOpEntity[] = [];
  const relationships: ExtractOpRelationship[] = [];
  const seenRefs = new Set<string>();
  const labelTypeToRef = new Map<string, string>();

  // Index existing entities
  for (const e of plan.entities) {
    seenRefs.add(e.ref);
    labelTypeToRef.set(labelTypeKey(e.label, e.type), e.ref);
    entities.push(e);
  }

  // Process relationships, materializing shells as needed
  for (const rel of plan.relationships) {
    let nextRel = { ...rel };

    if (!seenRefs.has(nextRel.source_ref) && nextRel.source_shell) {
      const key = labelTypeKey(nextRel.source_shell.label, nextRel.source_shell.type);
      const existingRef = labelTypeToRef.get(key);

      if (existingRef) {
        nextRel = { ...nextRel, source_ref: existingRef };
      } else {
        const ref = makeShellRef("source", nextRel.source_shell.label, entities.length);
        entities.push({
          op: "create_entity",
          ref,
          label: nextRel.source_shell.label,
          type: nextRel.source_shell.type,
          description: nextRel.source_shell.description ?? "",
        });
        seenRefs.add(ref);
        labelTypeToRef.set(key, ref);
        nextRel = { ...nextRel, source_ref: ref };
      }
    }

    if (!seenRefs.has(nextRel.target_ref) && nextRel.target_shell) {
      const key = labelTypeKey(nextRel.target_shell.label, nextRel.target_shell.type);
      const existingRef = labelTypeToRef.get(key);

      if (existingRef) {
        nextRel = { ...nextRel, target_ref: existingRef };
      } else {
        const ref = makeShellRef("target", nextRel.target_shell.label, entities.length);
        entities.push({
          op: "create_entity",
          ref,
          label: nextRel.target_shell.label,
          type: nextRel.target_shell.type,
          description: nextRel.target_shell.description ?? "",
        });
        seenRefs.add(ref);
        labelTypeToRef.set(key, ref);
        nextRel = { ...nextRel, target_ref: ref };
      }
    }

    relationships.push(nextRel);
  }

  return { entities, relationships };
}
