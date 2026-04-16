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
import { normalizeLabel } from "../lib/normalize";

function labelTypeKey(label: string, type: string): string {
  return `${normalizeLabel(label)}::${type.toLowerCase()}`;
}

function makeShellRef(prefix: "source" | "target", label: string, index: number): string {
  return `${prefix}_${label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "")}_${index}`;
}

/**
 * Known entity type tokens the LLM tends to use as ref prefixes. Order matters:
 * multi-word types checked first to avoid premature single-word matches.
 */
const KNOWN_TYPE_TOKENS = [
  "biblical_character", "biblical_figure", "biblical_text", "biblical_story", "biblical_reference",
  "historical_event", "religious_figure", "religious_text", "religious_ritual", "religious_order",
  "philosophical_work", "theological_concept", "social_mechanism",
  "person", "organization", "location", "event", "concept", "work", "text", "character",
  "doctrine", "mechanism", "myth", "ritual", "scripture", "chapter",
];

/**
 * Parse an undefined ref (e.g. "@c0_concept_mimetic_crisis") into an inferred
 * {label, type}. Falls back to ("thing", full-ref-as-label) for refs we can't
 * structurally parse. Used when the LLM emits a relate op whose target was
 * never defined as an entity AND no *_shell was provided — rather than 422'ing
 * the whole batch, synthesize a minimal stub so the relationship survives.
 * Consolidation will clean these up later.
 */
function synthesizeShellFromRef(ref: string): { label: string; type: string } {
  // Strip @ prefix
  let name = ref.startsWith("@") ? ref.slice(1) : ref;
  // Strip chunk prefix like "c0_", "c12_"
  name = name.replace(/^c\d+_/, "");

  // If ref embeds a 26-char ULID (pattern like "child_01ABC...Z26") the LLM
  // was trying to reference an existing entity but wrapped it; drop the ULID
  // from the synthesized label and note the type guess.
  name = name.replace(/_?[0-9A-HJKMNP-TV-Z]{26}_?/gi, "_").replace(/^_|_$/g, "");

  // Try type prefix match
  const lower = name.toLowerCase();
  for (const t of KNOWN_TYPE_TOKENS) {
    if (lower === t || lower.startsWith(t + "_")) {
      const labelPart = name.slice(t.length).replace(/^_/, "");
      const label = labelPart
        ? labelPart.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim()
        : t.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim();
      return { label, type: t };
    }
  }

  // No recognizable type prefix — humanize the whole ref as a label, generic type.
  const label = name
    ? name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim() || ref
    : ref;
  return { label, type: "thing" };
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

    // Last-resort synthesis: if either side is still an undefined local ref
    // and no shell was provided, infer a stub entity from the ref name itself.
    // This was the single largest class of validation failure in practice —
    // the LLM invents relate-op targets on the fly without remembering to
    // emit the corresponding entity op or attach a *_shell. Synthesizing a
    // minimal entity preserves the relationship; consolidation can improve
    // or merge the stub later.
    for (const side of ["source_ref", "target_ref"] as const) {
      const ref = nextRel[side];
      // Refs here don't yet have the '@' prefix (write.ts adds that when
      // building the ops envelope). Skip empty, already-defined, and
      // 26-char bare ULIDs (those reference known entities, not local refs).
      if (!ref || seenRefs.has(ref)) continue;
      if (/^[0-9A-HJKMNP-TV-Z]{26}$/i.test(ref)) continue;
      const inferred = synthesizeShellFromRef(ref);
      const key = labelTypeKey(inferred.label, inferred.type);
      const existingRef = labelTypeToRef.get(key);
      if (existingRef) {
        nextRel = { ...nextRel, [side]: existingRef };
      } else {
        entities.push({
          op: "create_entity",
          ref,
          label: inferred.label,
          type: inferred.type,
          description: `(Inferred from undefined ref '${ref}' — extracted implicitly from a relationship.)`,
        });
        seenRefs.add(ref);
        labelTypeToRef.set(key, ref);
        console.warn(`[knowledge:materialize] Synthesized stub entity for undefined ref ${ref} → {label: "${inferred.label}", type: "${inferred.type}"}`);
      }
    }

    relationships.push(nextRel);
  }

  return { entities, relationships };
}
