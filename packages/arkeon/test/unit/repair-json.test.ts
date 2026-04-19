// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, test, expect } from "vitest";
import { repairTruncatedJson } from "../../src/server/knowledge/lib/llm";

describe("repairTruncatedJson", () => {
  test("valid JSON passes through unchanged", () => {
    const input = '{"entities": [{"label": "foo"}], "relationships": []}';
    const result = repairTruncatedJson(input);
    expect(result).toEqual(JSON.parse(input));
  });

  test("truncated mid-array — unclosed bracket", () => {
    const input = '{"entities": [{"label": "foo"}, {"label": "bar"}';
    const result = repairTruncatedJson(input);
    expect(result).toEqual({ entities: [{ label: "foo" }, { label: "bar" }] });
  });

  test("truncated mid-object — unclosed brace", () => {
    const input = '{"entities": [{"label": "foo", "type": "person"';
    const result = repairTruncatedJson(input);
    expect(result).toEqual({ entities: [{ label: "foo", type: "person" }] });
  });

  test("truncated mid-string value", () => {
    // Truncated in the middle of "bar" value
    const input = '{"entities": [{"label": "foo"}, {"label": "ba';
    const result = repairTruncatedJson(input);
    // Should trim back to last complete element
    expect(result).toEqual({ entities: [{ label: "foo" }] });
  });

  test("truncated mid-key (opening quote edge case from review)", () => {
    // The review pointed out: {"entities": [{"label": "foo"}, {"label": "b
    // lastIndexOf('"') would find the " before b — an opening quote, not a closing one.
    // The fix should trim back to the last complete element boundary.
    const input = '{"entities": [{"label": "foo"}, {"label": "b';
    const result = repairTruncatedJson(input);
    expect(result).toEqual({ entities: [{ label: "foo" }] });
  });

  test("nested structures — multiple unclosed levels", () => {
    const input = '{"entities": [{"label": "foo", "props": {"nested": true';
    const result = repairTruncatedJson(input);
    expect(result).toEqual({ entities: [{ label: "foo", props: { nested: true } }] });
  });

  test("truncated after comma", () => {
    const input = '{"entities": [{"label": "foo"},';
    const result = repairTruncatedJson(input);
    expect(result).toEqual({ entities: [{ label: "foo" }] });
  });

  test("truncated after colon — no salvageable value", () => {
    const input = '{"entities": [{"label":';
    const result = repairTruncatedJson(input);
    // Nothing useful to salvage — key with no value
    expect(result).toBeNull();
  });

  test("completely broken input returns null", () => {
    expect(repairTruncatedJson("not json at all")).toBeNull();
    expect(repairTruncatedJson("")).toBeNull();
    expect(repairTruncatedJson("{{{")).toBeNull();
  });

  test("truncated with trailing whitespace", () => {
    const input = '{"entities": [{"label": "foo"}]   ';
    const result = repairTruncatedJson(input);
    expect(result).toEqual({ entities: [{ label: "foo" }] });
  });

  test("deeply nested truncation", () => {
    const input = '{"a": {"b": {"c": [1, 2, 3';
    const result = repairTruncatedJson(input);
    expect(result).toEqual({ a: { b: { c: [1, 2, 3] } } });
  });

  test("extraction-shaped payload truncated mid-relationship", () => {
    const input = `{"entities": [{"ref": "person_jane", "label": "Jane", "type": "person", "description": "CEO"}], "relationships": [{"source_ref": "person_jane", "predicate": "leads", "target_ref": "org_acme", "detail": "Jane leads Ac`;
    const result = repairTruncatedJson(input) as any;
    expect(result).not.toBeNull();
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0].label).toBe("Jane");
    // The truncated relationship should be dropped
  });

  test("string with escaped quotes does not confuse scanner", () => {
    const input = '{"label": "say \\"hello\\"", "type": "test"';
    const result = repairTruncatedJson(input);
    expect(result).toEqual({ label: 'say "hello"', type: "test" });
  });
});
