// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for mergeGroupPlans — verifies ULID preservation, cross-chunk
 * ref resolution, and the full merge→materialize→buildOps pipeline.
 */

import { describe, test, expect } from "vitest";
import { mergeGroupPlans } from "../../src/server/knowledge/pipeline/merge";
import { materializeShellEntities } from "../../src/server/knowledge/pipeline/materialize";
import { buildOpsFromPlan } from "../../src/server/knowledge/pipeline/write";
import type { ExtractPlan } from "../../src/server/knowledge/lib/types";
import type { ChatJsonResult } from "../../src/server/knowledge/lib/llm";

function wrapPlan(plan: ExtractPlan): ChatJsonResult<ExtractPlan> {
  return { data: plan, usage: { model: "", tokensIn: 0, tokensOut: 0 } };
}

describe("mergeGroupPlans", () => {
  test("deduplicates entities by label+type across chunks", () => {
    const chunk0: ExtractPlan = {
      entities: [
        { op: "create_entity", ref: "location_phnom_penh", label: "Phnom Penh", type: "location", description: "Capital of Cambodia" },
        { op: "create_entity", ref: "person_alice", label: "Alice", type: "person", description: "A researcher" },
      ],
      relationships: [
        { op: "create_relationship", source_ref: "person_alice", target_ref: "location_phnom_penh", predicate: "visited", source_span: "" },
      ],
    };
    const chunk1: ExtractPlan = {
      entities: [
        { op: "create_entity", ref: "location_phnom_penh", label: "Phnom Penh", type: "location", description: "Short" },
        { op: "create_entity", ref: "person_bob", label: "Bob", type: "person", description: "A traveler" },
      ],
      relationships: [
        { op: "create_relationship", source_ref: "person_bob", target_ref: "location_phnom_penh", predicate: "lives_in", source_span: "" },
      ],
    };

    const result = mergeGroupPlans([wrapPlan(chunk0), wrapPlan(chunk1)]);

    // Should have 3 entities (Phnom Penh deduped), keeping longer description
    expect(result.plan.entities).toHaveLength(3);
    const ppEntity = result.plan.entities.find((e) => e.label === "Phnom Penh");
    expect(ppEntity).toBeDefined();
    expect(ppEntity!.description).toBe("Capital of Cambodia"); // longer one wins

    // Both relationships should resolve to the same Phnom Penh entity
    const ppRef = ppEntity!.ref;
    expect(result.plan.relationships).toHaveLength(2);
    for (const rel of result.plan.relationships) {
      if (rel.predicate === "visited" || rel.predicate === "lives_in") {
        expect(rel.target_ref).toBe(ppRef);
      }
    }
  });

  test("preserves ULID refs (scouted entities) without prefixing", () => {
    const EXISTING_ID = "01ZPV2S0QMSJV3HVYSXZ6V9YEC"; // valid Crockford base32 ULID

    const chunk0: ExtractPlan = {
      entities: [
        { op: "create_entity", ref: EXISTING_ID, label: "Apple Inc", type: "organization", description: "Tech company" },
        { op: "create_entity", ref: "person_bob", label: "Bob", type: "person", description: "Employee" },
      ],
      relationships: [
        { op: "create_relationship", source_ref: "person_bob", target_ref: EXISTING_ID, predicate: "works_at", source_span: "" },
      ],
    };
    const chunk1: ExtractPlan = {
      entities: [
        { op: "create_entity", ref: "person_carol", label: "Carol", type: "person", description: "Manager" },
      ],
      relationships: [
        { op: "create_relationship", source_ref: "person_carol", target_ref: EXISTING_ID, predicate: "works_at", source_span: "" },
      ],
    };

    const result = mergeGroupPlans([wrapPlan(chunk0), wrapPlan(chunk1)]);

    // The ULID entity should NOT be prefixed
    const appleEntity = result.plan.entities.find((e) => e.label === "Apple Inc");
    expect(appleEntity).toBeDefined();
    expect(appleEntity!.ref).toBe(EXISTING_ID); // not c0_01HXYZ...

    // Both relationships should resolve to the bare ULID
    for (const rel of result.plan.relationships) {
      if (rel.predicate === "works_at") {
        expect(rel.target_ref).toBe(EXISTING_ID);
      }
    }
  });

  test("cross-chunk ref resolution: chunk B references entity defined only in chunk A", () => {
    const chunk0: ExtractPlan = {
      entities: [
        { op: "create_entity", ref: "concept_mimetic_crisis", label: "Mimetic Crisis", type: "concept", description: "A Girardian concept" },
      ],
      relationships: [],
    };
    const chunk1: ExtractPlan = {
      entities: [
        { op: "create_entity", ref: "person_girard", label: "René Girard", type: "person", description: "French philosopher" },
      ],
      relationships: [
        // References concept_mimetic_crisis which only exists in chunk 0
        { op: "create_relationship", source_ref: "person_girard", target_ref: "concept_mimetic_crisis", predicate: "theorized", source_span: "" },
      ],
    };

    const result = mergeGroupPlans([wrapPlan(chunk0), wrapPlan(chunk1)]);

    // The relationship should resolve via suffix fallback
    const rel = result.plan.relationships.find((r) => r.predicate === "theorized");
    expect(rel).toBeDefined();
    // target should be the canonical ref from chunk 0 (c0_concept_mimetic_crisis)
    const conceptEntity = result.plan.entities.find((e) => e.label === "Mimetic Crisis");
    expect(conceptEntity).toBeDefined();
    expect(rel!.target_ref).toBe(conceptEntity!.ref);
  });

  test("full pipeline: merge → materialize → buildOps produces valid ops", () => {
    const EXISTING_ID = "01ZPV2S0QMSJV3HVYSXZ6V9YEC";
    const knownEntityIds = new Set([EXISTING_ID]);

    const chunk0: ExtractPlan = {
      entities: [
        { op: "create_entity", ref: "person_alice", label: "Alice", type: "person", description: "A researcher" },
        { op: "create_entity", ref: "location_paris", label: "Paris", type: "location", description: "City of Light" },
      ],
      relationships: [
        { op: "create_relationship", source_ref: "person_alice", target_ref: "location_paris", predicate: "lives_in", source_span: "" },
        // Relationship to a scouted existing entity via ULID
        { op: "create_relationship", source_ref: "person_alice", target_ref: EXISTING_ID, predicate: "works_at", source_span: "" },
      ],
    };
    const chunk1: ExtractPlan = {
      entities: [
        { op: "create_entity", ref: "person_bob", label: "Bob", type: "person", description: "A colleague" },
      ],
      relationships: [
        // Cross-chunk ref to location_paris (only defined in chunk 0)
        { op: "create_relationship", source_ref: "person_bob", target_ref: "location_paris", predicate: "visited", source_span: "" },
        // Shell-based ref
        {
          op: "create_relationship", source_ref: "person_bob", target_ref: "org_unknown", predicate: "member_of", source_span: "",
          target_shell: { label: "Unknown Org", type: "organization" },
        },
      ],
    };

    // Step 1: Merge
    const merged = mergeGroupPlans([wrapPlan(chunk0), wrapPlan(chunk1)]);

    // Step 2: Materialize shells
    const materialized = materializeShellEntities(merged.plan);

    // Step 3: Build ops (this is what ops-parse validates)
    const envelope = buildOpsFromPlan(materialized, "doc-123", {}, knownEntityIds);

    // Collect all entity refs and relate source/targets
    const entityRefs = new Set<string>();
    const relateRefs: string[] = [];

    for (const op of envelope.ops) {
      if ((op as any).op === "entity") {
        entityRefs.add((op as any).ref as string);
      } else if ((op as any).op === "relate") {
        relateRefs.push((op as any).source as string);
        relateRefs.push((op as any).target as string);
      }
    }

    // Every @local ref in relate ops must have a corresponding entity op
    for (const ref of relateRefs) {
      if (ref.startsWith("@")) {
        expect(entityRefs.has(ref)).toBe(true);
      } else {
        // Bare ULID — must be in knownEntityIds
        expect(knownEntityIds.has(ref)).toBe(true);
      }
    }

    // ULID entity should be skipped (it's a known existing entity)
    const ulidOps = envelope.ops.filter((op) => (op as any).ref === `@${EXISTING_ID}`);
    expect(ulidOps).toHaveLength(0);

    // The works_at relationship should use bare ULID (not @prefixed)
    const worksAtOp = envelope.ops.find(
      (op) => (op as any).op === "relate" && (op as any).predicate === "works_at",
    ) as any;
    expect(worksAtOp).toBeDefined();
    expect(worksAtOp.target).toBe(EXISTING_ID); // bare ULID, not @ULID
  });

  test("drops self-referencing relationships after entity dedup", () => {
    // Two chunks use different refs for the same entity (same label+type).
    // A relationship between the two refs becomes a self-reference after dedup.
    const chunk0: ExtractPlan = {
      entities: [
        { op: "create_entity", ref: "concept_cambodia", label: "Cambodia", type: "location", description: "A country in Southeast Asia" },
        { op: "create_entity", ref: "person_alice", label: "Alice", type: "person", description: "" },
      ],
      relationships: [
        { op: "create_relationship", source_ref: "person_alice", target_ref: "concept_cambodia", predicate: "visited", source_span: "" },
      ],
    };
    const chunk1: ExtractPlan = {
      entities: [
        { op: "create_entity", ref: "location_cambodia", label: "Cambodia", type: "location", description: "Country" },
      ],
      relationships: [
        // This relationship references two refs that both resolve to "Cambodia"
        { op: "create_relationship", source_ref: "concept_cambodia", target_ref: "location_cambodia", predicate: "same_as", source_span: "" },
      ],
    };

    const result = mergeGroupPlans([wrapPlan(chunk0), wrapPlan(chunk1)]);

    // "Cambodia" should be deduped to 1 entity
    const cambodiaEntities = result.plan.entities.filter((e) => e.label === "Cambodia");
    expect(cambodiaEntities).toHaveLength(1);

    // The "same_as" self-reference should be dropped
    const sameAsRels = result.plan.relationships.filter((r) => r.predicate === "same_as");
    expect(sameAsRels).toHaveLength(0);

    // The "visited" relationship should survive
    const visitedRels = result.plan.relationships.filter((r) => r.predicate === "visited");
    expect(visitedRels).toHaveLength(1);
  });

  test("preserves entity properties through merge", () => {
    const chunk0: ExtractPlan = {
      entities: [
        {
          op: "create_entity", ref: "person_alice", label: "Alice", type: "person",
          description: "A researcher",
          properties: { nationality: "French", role: "Lead" },
        },
      ],
      relationships: [],
    };

    const result = mergeGroupPlans([wrapPlan(chunk0)]);
    const alice = result.plan.entities.find((e) => e.label === "Alice");
    expect(alice).toBeDefined();
    expect(alice!.properties).toEqual({ nationality: "French", role: "Lead" });
  });

  test("shell entities are materialized after merge", () => {
    const chunk0: ExtractPlan = {
      entities: [
        { op: "create_entity", ref: "person_alice", label: "Alice", type: "person", description: "" },
      ],
      relationships: [
        {
          op: "create_relationship", source_ref: "person_alice", target_ref: "loc_paris", predicate: "visited", source_span: "",
          target_shell: { label: "Paris", type: "location", description: "Capital of France" },
        },
      ],
    };
    const chunk1: ExtractPlan = {
      entities: [
        { op: "create_entity", ref: "person_bob", label: "Bob", type: "person", description: "" },
      ],
      relationships: [
        {
          op: "create_relationship", source_ref: "person_bob", target_ref: "loc_paris", predicate: "lives_in", source_span: "",
          target_shell: { label: "Paris", type: "location", description: "City of Light" },
        },
      ],
    };

    const merged = mergeGroupPlans([wrapPlan(chunk0), wrapPlan(chunk1)]);
    const materialized = materializeShellEntities(merged.plan);

    // Both shells had same label+type → should produce exactly 1 Paris entity
    const parisEntities = materialized.entities.filter((e) => e.label === "Paris");
    expect(parisEntities).toHaveLength(1);

    // Both relationships should point to the same Paris entity
    const parisRef = parisEntities[0].ref;
    const rels = materialized.relationships.filter(
      (r) => r.predicate === "visited" || r.predicate === "lives_in",
    );
    expect(rels).toHaveLength(2);
    for (const r of rels) {
      expect(r.target_ref).toBe(parisRef);
    }
  });
});
