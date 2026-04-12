// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import { parseOps } from "../../src/server/lib/ops-parse";
import type { OpsEnvelope } from "../../src/server/lib/ops-schema";

function envelope(ops: unknown[], extra: Partial<OpsEnvelope> = {}): OpsEnvelope {
  return { format: "arke.ops/v1", ops: ops as OpsEnvelope["ops"], ...extra };
}

describe("parseOps — happy path", () => {
  test("single entity op resolves to a planned entity with preallocated ULID", () => {
    const { plan, errors } = parseOps(
      envelope([
        { op: "entity", ref: "@jane", type: "person", label: "Jane Smith" },
      ]),
    );
    expect(errors).toEqual([]);
    expect(plan).not.toBeNull();
    expect(plan!.entities).toHaveLength(1);
    expect(plan!.entities[0].local_ref).toBe("@jane");
    expect(plan!.entities[0].type).toBe("person");
    expect(plan!.entities[0].label).toBe("Jane Smith");
    expect(plan!.entities[0].id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/i);
    expect(plan!.entities[0].op_index).toBe(0);
  });

  test("inline properties passthrough — non-reserved keys become properties", () => {
    const { plan } = parseOps(
      envelope([
        {
          op: "entity",
          ref: "@jane",
          type: "person",
          label: "Jane",
          description: "CEO",
          born: 1974,
          location: "Seattle",
          confidence: 0.92,
        },
      ]),
    );
    expect(plan!.entities[0].properties).toEqual({
      label: "Jane",
      description: "CEO",
      born: 1974,
      location: "Seattle",
      confidence: 0.92,
    });
  });

  test("relate op resolves both @local refs to ULIDs", () => {
    const { plan, errors } = parseOps(
      envelope([
        { op: "entity", ref: "@jane", type: "person", label: "Jane" },
        { op: "entity", ref: "@acme", type: "organization", label: "Acme Corp" },
        { op: "relate", source: "@jane", target: "@acme", predicate: "leads", span: "Jane leads Acme" },
      ]),
    );
    expect(errors).toEqual([]);
    expect(plan!.edges).toHaveLength(1);
    const edge = plan!.edges[0];
    expect(edge.source_id).toBe(plan!.entities[0].id);
    expect(edge.target_id).toBe(plan!.entities[1].id);
    expect(edge.source_is_local).toBe(true);
    expect(edge.target_is_local).toBe(true);
    expect(edge.predicate).toBe("leads");
    expect(edge.properties).toEqual({ span: "Jane leads Acme" });
  });

  test("relate op with global ULID target records it as referenced_global_ids", () => {
    const existingUlid = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const { plan, errors } = parseOps(
      envelope([
        { op: "entity", ref: "@jane", type: "person" },
        { op: "relate", source: "@jane", target: existingUlid, predicate: "works_at" },
      ]),
    );
    expect(errors).toEqual([]);
    expect(plan!.edges[0].source_is_local).toBe(true);
    expect(plan!.edges[0].target_is_local).toBe(false);
    expect(plan!.edges[0].target_id).toBe(existingUlid);
    expect(plan!.referenced_global_ids.has(existingUlid)).toBe(true);
  });

  test("relate op accepts arke: prefixed ULIDs", () => {
    const { plan, errors } = parseOps(
      envelope([
        { op: "entity", ref: "@jane", type: "person" },
        { op: "relate", source: "@jane", target: "arke:01ARZ3NDEKTSV4RRFFQ69G5FAV", predicate: "works_at" },
      ]),
    );
    expect(errors).toEqual([]);
    expect(plan!.edges[0].target_id).toBe("01ARZ3NDEKTSV4RRFFQ69G5FAV");
  });

  test("lowercase ULIDs are accepted and normalized to uppercase", () => {
    // DB stores ULIDs uppercase (Crockford alphabet). The schema regex is
    // case-insensitive, so callers can pass lowercase refs; parseOps must
    // canonicalize them so global-ref existence checks compare apples to
    // apples. Without this, a lowercase ULID would silently miss the
    // bulk SELECT and surface as a bogus target_not_found.
    const { plan, errors } = parseOps(
      envelope([
        { op: "entity", ref: "@jane", type: "person" },
        { op: "relate", source: "@jane", target: "01arz3ndektsv4rrffq69g5fav", predicate: "works_at" },
      ]),
    );
    expect(errors).toEqual([]);
    expect(plan!.edges[0].target_id).toBe("01ARZ3NDEKTSV4RRFFQ69G5FAV");
    expect(plan!.referenced_global_ids.has("01ARZ3NDEKTSV4RRFFQ69G5FAV")).toBe(true);
  });

  test("mixed-case arke: prefixed ULIDs are accepted and normalized", () => {
    const { plan, errors } = parseOps(
      envelope([
        { op: "entity", ref: "@jane", type: "person" },
        { op: "relate", source: "@jane", target: "arke:01Arz3NdEkTsV4RrFfQ69g5FaV", predicate: "works_at" },
      ]),
    );
    expect(errors).toEqual([]);
    expect(plan!.edges[0].target_id).toBe("01ARZ3NDEKTSV4RRFFQ69G5FAV");
  });

  test("defaults block is applied to ops that don't override", () => {
    const spaceUlid = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const { plan } = parseOps(
      envelope(
        [
          { op: "entity", ref: "@a", type: "note" },
          { op: "entity", ref: "@b", type: "note", space_id: "01BBBBBBBBBBBBBBBBBBBBBBBB" },
        ],
        { defaults: { space_id: spaceUlid, read_level: 2, write_level: 2 } },
      ),
    );
    expect(plan!.entities[0].space_id).toBe(spaceUlid);
    expect(plan!.entities[0].read_level).toBe(2);
    expect(plan!.entities[1].space_id).toBe("01BBBBBBBBBBBBBBBBBBBBBBBB");
  });

  test("label falls back to 'name' property when 'label' is absent", () => {
    const { plan } = parseOps(
      envelope([
        { op: "entity", ref: "@e", type: "event", name: "KubeCon 2024" },
      ]),
    );
    expect(plan!.entities[0].label).toBe("KubeCon 2024");
  });

  test("label is null when neither label nor name is present", () => {
    const { plan } = parseOps(
      envelope([{ op: "entity", ref: "@x", type: "thing" }]),
    );
    expect(plan!.entities[0].label).toBeNull();
  });
});

describe("parseOps — error diagnostics", () => {
  test("unresolved @ref in relate.source surfaces op_index and fix hint", () => {
    const { plan, errors } = parseOps(
      envelope([
        { op: "relate", source: "@jane", target: "@acme", predicate: "leads" },
      ]),
    );
    expect(plan).toBeNull();
    expect(errors).toHaveLength(2); // both source and target unresolved
    const sourceErr = errors.find((e) => e.field === "source")!;
    expect(sourceErr.code).toBe("unresolved_ref");
    expect(sourceErr.op_index).toBe(0);
    expect(sourceErr.offending_value).toBe("@jane");
    expect(sourceErr.message).toContain("@jane");
    expect(sourceErr.message).toContain("earlier in this batch");
    expect(sourceErr.fix).toContain("ULID");
  });

  test("unresolved @ref when the entity is defined AFTER the relate op", () => {
    const { errors } = parseOps(
      envelope([
        { op: "relate", source: "@jane", target: "@acme", predicate: "leads" },
        { op: "entity", ref: "@jane", type: "person" },
        { op: "entity", ref: "@acme", type: "organization" },
      ]),
    );
    // The relate op at index 0 fails because @jane and @acme aren't defined yet —
    // forward refs are not allowed. Proves the "define before reference" rule.
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].code).toBe("unresolved_ref");
    expect(errors[0].op_index).toBe(0);
  });

  test("duplicate @ref in same batch is rejected", () => {
    const { errors } = parseOps(
      envelope([
        { op: "entity", ref: "@jane", type: "person" },
        { op: "entity", ref: "@jane", type: "person", label: "different Jane" },
      ]),
    );
    const dup = errors.find((e) => e.code === "duplicate_ref")!;
    expect(dup).toBeDefined();
    expect(dup.op_index).toBe(1);
    expect(dup.offending_value).toBe("@jane");
    expect(dup.fix).toContain("unique");
  });

  test("self-reference (source === target) is rejected", () => {
    const { errors } = parseOps(
      envelope([
        { op: "entity", ref: "@jane", type: "person" },
        { op: "relate", source: "@jane", target: "@jane", predicate: "knows" },
      ]),
    );
    const selfRef = errors.find((e) => e.code === "self_reference")!;
    expect(selfRef).toBeDefined();
    expect(selfRef.op_index).toBe(1);
  });

  test("multiple errors are collected with distinct op_indexes", () => {
    const { errors } = parseOps(
      envelope([
        { op: "entity", ref: "@jane", type: "person" },
        { op: "relate", source: "@bob", target: "@jane", predicate: "knows" },
        { op: "entity", ref: "@jane", type: "person" },
      ]),
    );
    expect(errors.length).toBeGreaterThanOrEqual(2);
    const unresolved = errors.find((e) => e.code === "unresolved_ref")!;
    const duplicate = errors.find((e) => e.code === "duplicate_ref")!;
    expect(unresolved.op_index).toBe(1);
    expect(duplicate.op_index).toBe(2);
  });
});
