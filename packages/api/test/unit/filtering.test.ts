import { describe, test, expect } from "vitest";
import { parseFilter, buildFilterSql } from "../../src/lib/filtering";

describe("parseFilter", () => {
  test("parses simple equality", () => {
    const clauses = parseFilter("extracted:true");
    expect(clauses).toEqual([{ path: "extracted", op: ":", value: "true" }]);
  });

  test("parses dotted path", () => {
    const clauses = parseFilter("metadata.source:arxiv");
    expect(clauses).toEqual([{ path: "metadata.source", op: ":", value: "arxiv" }]);
  });

  test("parses multiple comma-separated filters", () => {
    const clauses = parseFilter("label:test,extracted:false");
    expect(clauses).toHaveLength(2);
    expect(clauses[0]).toEqual({ path: "label", op: ":", value: "test" });
    expect(clauses[1]).toEqual({ path: "extracted", op: ":", value: "false" });
  });
});

describe("buildFilterSql — properties. prefix normalization", () => {
  test("properties.extracted:true produces same SQL as extracted:true", () => {
    const params1: unknown[] = [];
    const result1 = buildFilterSql("extracted:true", params1, 1);

    const params2: unknown[] = [];
    const result2 = buildFilterSql("properties.extracted:true", params2, 1);

    expect(result1.sql).toEqual(result2.sql);
    expect(params1).toEqual(params2);
  });

  test("properties.metadata.source:arxiv strips prefix and uses nested path", () => {
    const params: unknown[] = [];
    const result = buildFilterSql("properties.metadata.source:arxiv", params, 1);
    expect(result.sql).toEqual(["properties #>> '{metadata,source}' = $1"]);
    expect(params).toEqual(["arxiv"]);
  });

  test("nested path without prefix works", () => {
    const params: unknown[] = [];
    const result = buildFilterSql("metadata.source:arxiv", params, 1);
    expect(result.sql).toEqual(["properties #>> '{metadata,source}' = $1"]);
    expect(params).toEqual(["arxiv"]);
  });

  test("bare 'properties' (no dot) is not stripped", () => {
    const params: unknown[] = [];
    const result = buildFilterSql("properties:something", params, 1);
    expect(result.sql).toEqual(["properties #>> '{properties}' = $1"]);
    expect(params).toEqual(["something"]);
  });

  test("column whitelist is unaffected by normalization", () => {
    const params: unknown[] = [];
    const result = buildFilterSql("created_at>2024-01-01", params, 1);
    expect(result.sql).toEqual(["created_at > $1::timestamptz"]);
    expect(params).toEqual(["2024-01-01"]);
  });

  test("properties.created_at goes to JSONB, not column whitelist", () => {
    const params: unknown[] = [];
    const result = buildFilterSql("properties.created_at:foo", params, 1);
    // After stripping "properties.", path is "created_at" which IS in the whitelist.
    // But we strip AFTER the whitelist check, so this goes to JSONB.
    // Actually — the whitelist check uses clause.path (before stripping),
    // so "properties.created_at" won't match the whitelist.
    expect(result.sql).toEqual(["properties #>> '{created_at}' = $1"]);
    expect(params).toEqual(["foo"]);
  });

  test("boolean false filter via JSONB", () => {
    const params: unknown[] = [];
    const result = buildFilterSql("processed:false", params, 1);
    expect(result.sql).toEqual(["properties #>> '{processed}' = $1"]);
    expect(params).toEqual(["false"]);
  });

  test("existence operator with properties. prefix", () => {
    const params: unknown[] = [];
    const result = buildFilterSql("properties.processed?", params, 1);
    expect(result.sql).toEqual(["properties #> '{processed}' IS NOT NULL"]);
    expect(params).toEqual([]);
  });

  test("properties.properties.x strips prefix once, drills into nested 'properties' key", () => {
    // JSONB: { "properties": { "foo": "bar" } }
    // Filter: properties.properties.foo:bar → strip prefix → properties.foo → {properties,foo}
    const params: unknown[] = [];
    const result = buildFilterSql("properties.properties.foo:bar", params, 1);
    expect(result.sql).toEqual(["properties #>> '{properties,foo}' = $1"]);
    expect(params).toEqual(["bar"]);
  });

  test("properties.properties.properties drills three levels after prefix strip", () => {
    // JSONB: { "properties": { "properties": { "deep": "val" } } }
    // Filter: properties.properties.properties.deep:val → strip → properties.properties.deep → {properties,properties,deep}
    const params: unknown[] = [];
    const result = buildFilterSql("properties.properties.properties.deep:val", params, 1);
    expect(result.sql).toEqual(["properties #>> '{properties,properties,deep}' = $1"]);
    expect(params).toEqual(["val"]);
  });
});
