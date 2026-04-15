// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import { mergeGroupPlans } from "../../src/server/knowledge/pipeline/merge";
import { buildOpsFromPlan, isUlid } from "../../src/server/knowledge/pipeline/write";
import { normalizeLabel } from "../../src/server/knowledge/lib/normalize";
import type { ExtractPlan } from "../../src/server/knowledge/lib/types";
import type { ChatJsonResult } from "../../src/server/knowledge/lib/llm";

function plan(p: ExtractPlan): ChatJsonResult<ExtractPlan> {
  return { data: p, usage: { model: "test", tokens_in: 0, tokens_out: 0 } };
}

// ---------------------------------------------------------------------------
// normalizeLabel
// ---------------------------------------------------------------------------

describe("normalizeLabel", () => {
  test("lowercases and trims", () => {
    expect(normalizeLabel("  Albert Einstein  ")).toBe("albert einstein");
  });

  test("strips title prefixes", () => {
    expect(normalizeLabel("Dr. Jane Smith")).toBe("jane smith");
    expect(normalizeLabel("Gen. Patton")).toBe("patton");
    expect(normalizeLabel("Ambassador Kim")).toBe("kim");
    expect(normalizeLabel("Prof. Hawking")).toBe("hawking");
  });

  test("collapses whitespace", () => {
    expect(normalizeLabel("United   States   of   America")).toBe(
      "united states of america",
    );
  });

  test("empty string stays empty", () => {
    expect(normalizeLabel("")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// mergeGroupPlans — cross-chunk deduplication
// ---------------------------------------------------------------------------

describe("mergeGroupPlans", () => {
  test("single chunk passes through unchanged", () => {
    const result = mergeGroupPlans([
      plan({
        entities: [
          { op: "create_entity", ref: "e1", label: "Albert Einstein", type: "person", description: "Physicist" },
        ],
        relationships: [],
      }),
    ]);

    expect(result.plan.entities).toHaveLength(1);
    expect(result.plan.entities[0].label).toBe("Albert Einstein");
    expect(result.plan.entities[0].ref).toBe("c0_e1");
  });

  test("deduplicates same entity across two chunks by label+type", () => {
    const result = mergeGroupPlans([
      plan({
        entities: [
          { op: "create_entity", ref: "e1", label: "Albert Einstein", type: "person", description: "Short" },
        ],
        relationships: [],
      }),
      plan({
        entities: [
          { op: "create_entity", ref: "e1", label: "Albert Einstein", type: "person", description: "A much longer description about the physicist" },
        ],
        relationships: [],
      }),
    ]);

    expect(result.plan.entities).toHaveLength(1);
    // Should keep the longer description
    expect(result.plan.entities[0].description).toBe(
      "A much longer description about the physicist",
    );
  });

  test("does not dedup entities with same label but different type", () => {
    const result = mergeGroupPlans([
      plan({
        entities: [
          { op: "create_entity", ref: "e1", label: "Mercury", type: "planet", description: "A planet" },
        ],
        relationships: [],
      }),
      plan({
        entities: [
          { op: "create_entity", ref: "e1", label: "Mercury", type: "element", description: "A chemical element" },
        ],
        relationships: [],
      }),
    ]);

    expect(result.plan.entities).toHaveLength(2);
  });

  test("deduplicates relationships across chunks", () => {
    const result = mergeGroupPlans([
      plan({
        entities: [
          { op: "create_entity", ref: "e1", label: "Einstein", type: "person", description: "" },
          { op: "create_entity", ref: "e2", label: "Princeton", type: "organization", description: "" },
        ],
        relationships: [
          { op: "create_relationship", source_ref: "e1", target_ref: "e2", predicate: "works_at", source_span: "Einstein at Princeton" },
        ],
      }),
      plan({
        entities: [
          { op: "create_entity", ref: "e1", label: "Einstein", type: "person", description: "" },
          { op: "create_entity", ref: "e2", label: "Princeton", type: "organization", description: "" },
        ],
        relationships: [
          { op: "create_relationship", source_ref: "e1", target_ref: "e2", predicate: "works_at", source_span: "Einstein worked at Princeton" },
        ],
      }),
    ]);

    // Entities should be deduped
    expect(result.plan.entities).toHaveLength(2);
    // Relationship should be deduped (same source::predicate::target after ref rewrite)
    expect(result.plan.relationships).toHaveLength(1);
  });

  test("different predicates between same entities are kept", () => {
    const result = mergeGroupPlans([
      plan({
        entities: [
          { op: "create_entity", ref: "e1", label: "Einstein", type: "person", description: "" },
          { op: "create_entity", ref: "e2", label: "Princeton", type: "organization", description: "" },
        ],
        relationships: [
          { op: "create_relationship", source_ref: "e1", target_ref: "e2", predicate: "works_at", source_span: "" },
        ],
      }),
      plan({
        entities: [
          { op: "create_entity", ref: "e1", label: "Einstein", type: "person", description: "" },
          { op: "create_entity", ref: "e2", label: "Princeton", type: "organization", description: "" },
        ],
        relationships: [
          { op: "create_relationship", source_ref: "e1", target_ref: "e2", predicate: "founded", source_span: "" },
        ],
      }),
    ]);

    expect(result.plan.relationships).toHaveLength(2);
  });

  test("case-insensitive label matching via normalize", () => {
    const result = mergeGroupPlans([
      plan({
        entities: [
          { op: "create_entity", ref: "e1", label: "ALBERT EINSTEIN", type: "person", description: "short" },
        ],
        relationships: [],
      }),
      plan({
        entities: [
          { op: "create_entity", ref: "e1", label: "albert einstein", type: "person", description: "a longer one" },
        ],
        relationships: [],
      }),
    ]);

    expect(result.plan.entities).toHaveLength(1);
    expect(result.plan.entities[0].description).toBe("a longer one");
  });

  test("title prefix stripping merges Dr. X with X", () => {
    const result = mergeGroupPlans([
      plan({
        entities: [
          { op: "create_entity", ref: "e1", label: "Dr. Smith", type: "person", description: "A doctor" },
        ],
        relationships: [],
      }),
      plan({
        entities: [
          { op: "create_entity", ref: "e1", label: "Smith", type: "person", description: "A longer description about Smith" },
        ],
        relationships: [],
      }),
    ]);

    expect(result.plan.entities).toHaveLength(1);
  });

  test("three chunks with overlapping entities", () => {
    const result = mergeGroupPlans([
      plan({
        entities: [
          { op: "create_entity", ref: "a", label: "Einstein", type: "person", description: "chunk 1" },
          { op: "create_entity", ref: "b", label: "Bohr", type: "person", description: "chunk 1 Bohr" },
        ],
        relationships: [
          { op: "create_relationship", source_ref: "a", target_ref: "b", predicate: "debated", source_span: "" },
        ],
      }),
      plan({
        entities: [
          { op: "create_entity", ref: "a", label: "Einstein", type: "person", description: "chunk 2 longer desc" },
          { op: "create_entity", ref: "c", label: "Heisenberg", type: "person", description: "chunk 2 Heisenberg" },
        ],
        relationships: [
          { op: "create_relationship", source_ref: "a", target_ref: "c", predicate: "collaborated_with", source_span: "" },
        ],
      }),
      plan({
        entities: [
          { op: "create_entity", ref: "a", label: "Bohr", type: "person", description: "chunk 3 Bohr much more detailed" },
        ],
        relationships: [],
      }),
    ]);

    // Einstein, Bohr, Heisenberg = 3 unique entities
    expect(result.plan.entities).toHaveLength(3);
    // debated + collaborated_with = 2 unique relationships
    expect(result.plan.relationships).toHaveLength(2);

    // Bohr should have the longest description (from chunk 3)
    const bohr = result.plan.entities.find((e) => normalizeLabel(e.label) === "bohr");
    expect(bohr?.description).toBe("chunk 3 Bohr much more detailed");
  });

  test("entities with empty labels are skipped", () => {
    const result = mergeGroupPlans([
      plan({
        entities: [
          { op: "create_entity", ref: "e1", label: "", type: "person", description: "" },
          { op: "create_entity", ref: "e2", label: "Einstein", type: "person", description: "" },
        ],
        relationships: [],
      }),
    ]);

    expect(result.plan.entities).toHaveLength(1);
    expect(result.plan.entities[0].label).toBe("Einstein");
  });

  test("refToSourceOrdinal tracks which chunk produced each entity", () => {
    const result = mergeGroupPlans([
      plan({
        entities: [
          { op: "create_entity", ref: "e1", label: "Einstein", type: "person", description: "short" },
        ],
        relationships: [],
      }),
      plan({
        entities: [
          { op: "create_entity", ref: "e1", label: "Einstein", type: "person", description: "this is a much longer description" },
        ],
        relationships: [],
      }),
    ]);

    // The winning entity came from chunk 1 (longer description)
    const ref = result.plan.entities[0].ref;
    expect(result.refToSourceOrdinal.get(ref)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// buildOpsFromPlan — verify upsert_on is set
// ---------------------------------------------------------------------------

describe("buildOpsFromPlan", () => {
  test("sets upsert_on to label+type in defaults", () => {
    const envelope = buildOpsFromPlan(
      {
        entities: [
          { op: "create_entity", ref: "e1", label: "Einstein", type: "person", description: "Physicist" },
        ],
        relationships: [],
      },
      "doc123",
    );

    expect(envelope.defaults?.upsert_on).toEqual(["label", "type"]);
  });

  test("sets source.entity_id for provenance tracking", () => {
    const envelope = buildOpsFromPlan(
      { entities: [], relationships: [] },
      "doc123",
    );

    expect(envelope.source?.entity_id).toBe("doc123");
  });

  test("entity ops use @ref prefix", () => {
    const envelope = buildOpsFromPlan(
      {
        entities: [
          { op: "create_entity", ref: "e1", label: "Einstein", type: "person", description: "Physicist" },
        ],
        relationships: [],
      },
      "doc123",
    );

    expect(envelope.ops[0]).toMatchObject({
      op: "entity",
      ref: "@e1",
      type: "person",
      label: "Einstein",
      description: "Physicist",
    });
  });

  test("relate ops reference @source and @target", () => {
    const envelope = buildOpsFromPlan(
      {
        entities: [],
        relationships: [
          { op: "create_relationship", source_ref: "e1", target_ref: "e2", predicate: "knows", source_span: "Einstein knows Bohr" },
        ],
      },
      "doc123",
    );

    expect(envelope.ops[0]).toMatchObject({
      op: "relate",
      source: "@e1",
      target: "@e2",
      predicate: "knows",
      span: "Einstein knows Bohr",
    });
  });

  test("space_id and classification levels passed through", () => {
    const envelope = buildOpsFromPlan(
      { entities: [], relationships: [] },
      "doc123",
      { spaceId: "space1", readLevel: 2, writeLevel: 3 },
    );

    expect(envelope.defaults?.space_id).toBe("space1");
    expect(envelope.defaults?.read_level).toBe(2);
    expect(envelope.defaults?.write_level).toBe(3);
  });

  test("ULID ref entities are skipped when in knownEntityIds", () => {
    const existingId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const known = new Set([existingId]);
    const envelope = buildOpsFromPlan(
      {
        entities: [
          { op: "create_entity", ref: existingId, label: "Kissinger", type: "person", description: "Existing" },
          { op: "create_entity", ref: "e_new", label: "Shah", type: "person", description: "New" },
        ],
        relationships: [
          { op: "create_relationship", source_ref: "e_new", target_ref: existingId, predicate: "met_with", source_span: "Shah met Kissinger" },
        ],
      },
      "doc123",
      undefined,
      known,
    );

    // Only the new entity should produce an entity op
    const entityOps = envelope.ops.filter((o) => o.op === "entity");
    expect(entityOps).toHaveLength(1);
    expect(entityOps[0].ref).toBe("@e_new");

    // The relate op should use raw ULID for the existing entity
    const relateOps = envelope.ops.filter((o) => o.op === "relate");
    expect(relateOps).toHaveLength(1);
    expect(relateOps[0].source).toBe("@e_new");
    expect(relateOps[0].target).toBe(existingId);
  });

  test("ULID-shaped ref NOT in knownEntityIds is treated as new entity", () => {
    const hallucinatedUlid = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    // No knownEntityIds passed, or ID not in set
    const envelope = buildOpsFromPlan(
      {
        entities: [
          { op: "create_entity", ref: hallucinatedUlid, label: "Ghost", type: "person", description: "" },
        ],
        relationships: [],
      },
      "doc123",
      undefined,
      new Set(["01DIFFERENTIDXXXXXXXXXXXXXX"]),
    );

    // Should NOT skip — treat as new entity with @ref
    const entityOps = envelope.ops.filter((o) => o.op === "entity");
    expect(entityOps).toHaveLength(1);
    expect(entityOps[0].ref).toBe(`@${hallucinatedUlid}`);
  });

  test("ULID-shaped ref without knownEntityIds set is treated as new entity", () => {
    const existingId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const envelope = buildOpsFromPlan(
      {
        entities: [
          { op: "create_entity", ref: existingId, label: "Kissinger", type: "person", description: "" },
        ],
        relationships: [],
      },
      "doc123",
      // no opts, no knownEntityIds
    );

    // Without knownEntityIds, ULID refs are treated as new (not silently dropped)
    const entityOps = envelope.ops.filter((o) => o.op === "entity");
    expect(entityOps).toHaveLength(1);
    expect(entityOps[0].ref).toBe(`@${existingId}`);
  });
});

// ---------------------------------------------------------------------------
// isUlid
// ---------------------------------------------------------------------------

describe("isUlid", () => {
  test("valid ULIDs", () => {
    expect(isUlid("01ARZ3NDEKTSV4RRFFQ69G5FAV")).toBe(true);
    expect(isUlid("01arz3ndektsv4rrffq69g5fav")).toBe(true); // lowercase
  });

  test("not ULIDs", () => {
    expect(isUlid("person_jane")).toBe(false);
    expect(isUlid("e1")).toBe(false);
    expect(isUlid("")).toBe(false);
    expect(isUlid("01ARZ3NDEKTSV4RRFFQ69G5FA")).toBe(false); // 25 chars
    expect(isUlid("01ARZ3NDEKTSV4RRFFQ69G5FAVX")).toBe(false); // 27 chars
  });
});
