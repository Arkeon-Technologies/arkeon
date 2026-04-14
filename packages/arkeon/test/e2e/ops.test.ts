// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import {
  adminApiKey,
  apiRequest,
  createActor,
  createEntity,
  createSpace,
  getJson,
  jsonRequest,
  uniqueName,
} from "./helpers";

type OpsResponse = {
  format: string;
  committed: boolean;
  entities: Array<{ ref: string; id: string; type: string; label: string | null; action: "created" | "updated" }>;
  edges: Array<{ id: string; source: string; predicate: string; target: string }>;
  stats: { entities: number; edges: number };
};

async function opsRequest(apiKey: string, envelope: Record<string, unknown>, dryRun = false) {
  const path = dryRun ? "/ops?dry_run=true" : "/ops";
  return jsonRequest(path, { method: "POST", apiKey, json: envelope });
}

describe("POST /ops — arke.ops/v1", () => {
  let actor: Awaited<ReturnType<typeof createActor>>;

  test("setup: actor", async () => {
    actor = await createActor(adminApiKey, { maxReadLevel: 3, maxWriteLevel: 3 });
  });

  test("happy path — creates entities and relationships atomically", async () => {
    const janeLabel = uniqueName("jane");
    const acmeLabel = uniqueName("acme");

    const { response, body } = await opsRequest(actor.apiKey, {
      format: "arke.ops/v1",
      ops: [
        { op: "entity", ref: "@jane", type: "person", label: janeLabel, description: "CEO of Acme" },
        { op: "entity", ref: "@acme", type: "organization", label: acmeLabel },
        { op: "relate", source: "@jane", target: "@acme", predicate: "leads", span: "Jane leads Acme" },
      ],
    });

    expect(response.status).toBe(200);
    const data = body as OpsResponse;
    expect(data.format).toBe("arke.ops/v1");
    expect(data.committed).toBe(true);
    expect(data.entities).toHaveLength(2);
    expect(data.edges).toHaveLength(1);
    expect(data.stats).toEqual({ entities: 2, edges: 1 });

    const jane = data.entities.find((c) => c.ref === "@jane")!;
    const acme = data.entities.find((c) => c.ref === "@acme")!;
    expect(jane.label).toBe(janeLabel);
    expect(acme.label).toBe(acmeLabel);

    // Verify entities actually exist
    const { body: janeBody } = await getJson(`/entities/${jane.id}`, actor.apiKey);
    expect(janeBody.entity.properties.label).toBe(janeLabel);
    expect(janeBody.entity.properties.description).toBe("CEO of Acme");

    // Verify edge
    expect(data.edges[0].source).toBe(jane.id);
    expect(data.edges[0].target).toBe(acme.id);
    expect(data.edges[0].predicate).toBe("leads");
  });

  test("inline properties passthrough — arbitrary fields land in entity.properties", async () => {
    const { response, body } = await opsRequest(actor.apiKey, {
      format: "arke.ops/v1",
      ops: [
        {
          op: "entity",
          ref: "@e",
          type: "person",
          label: uniqueName("pt"),
          born: 1974,
          location: "Seattle",
          confidence: 0.92,
          tags: ["ceo", "founder"],
        },
      ],
    });
    expect(response.status).toBe(200);
    const id = (body as OpsResponse).entities[0].id;
    const { body: fetched } = await getJson(`/entities/${id}`, actor.apiKey);
    expect(fetched.entity.properties.born).toBe(1974);
    expect(fetched.entity.properties.location).toBe("Seattle");
    expect(fetched.entity.properties.confidence).toBe(0.92);
    expect(fetched.entity.properties.tags).toEqual(["ceo", "founder"]);
  });

  test("mixed @local + ULID refs in one relate op", async () => {
    const existing = await createEntity(actor.apiKey, "organization", {
      label: uniqueName("existing-org"),
    });

    const { response, body } = await opsRequest(actor.apiKey, {
      format: "arke.ops/v1",
      ops: [
        { op: "entity", ref: "@alice", type: "person", label: uniqueName("alice") },
        { op: "relate", source: "@alice", target: existing.id, predicate: "works_at" },
      ],
    });
    expect(response.status).toBe(200);
    const data = body as OpsResponse;
    expect(data.entities).toHaveLength(1);
    expect(data.edges).toHaveLength(1);
    expect(data.edges[0].source).toBe(data.entities[0].id);
    expect(data.edges[0].target).toBe(existing.id);
  });

  test("dry_run returns plan without writing", async () => {
    const label = uniqueName("dryrun");
    const { response, body } = await opsRequest(
      actor.apiKey,
      {
        format: "arke.ops/v1",
        ops: [
          { op: "entity", ref: "@x", type: "note", label },
          { op: "entity", ref: "@y", type: "note", label: uniqueName("dryrun-2") },
          { op: "relate", source: "@x", target: "@y", predicate: "references" },
        ],
      },
      true,
    );
    expect(response.status).toBe(200);
    const data = body as OpsResponse;
    expect(data.committed).toBe(false);
    expect(data.entities).toHaveLength(2);
    expect(data.stats).toEqual({ entities: 2, edges: 1 });

    // Verify the dry-run IDs were NOT persisted
    const { response: fetchResp } = await apiRequest(`/entities/${data.entities[0].id}`, {
      apiKey: actor.apiKey,
    });
    expect(fetchResp.status).toBe(404);
  });

  test("422 on unresolved @ref with op_index and fix hint", async () => {
    const { response, body } = await opsRequest(actor.apiKey, {
      format: "arke.ops/v1",
      ops: [
        { op: "entity", ref: "@jane", type: "person" },
        { op: "relate", source: "@jane", target: "@bob", predicate: "knows" },
      ],
    });
    expect(response.status).toBe(422);
    const errObj = (body as any).error;
    expect(errObj.code).toBe("ops_validation_failed");
    const errors = errObj.details.errors as Array<any>;
    const unresolved = errors.find((e) => e.code === "unresolved_ref");
    expect(unresolved).toBeDefined();
    expect(unresolved.op_index).toBe(1);
    expect(unresolved.field).toBe("target");
    expect(unresolved.offending_value).toBe("@bob");
    expect(unresolved.fix).toContain("ULID");
  });

  test("422 on duplicate @ref", async () => {
    const { response, body } = await opsRequest(actor.apiKey, {
      format: "arke.ops/v1",
      ops: [
        { op: "entity", ref: "@dup", type: "note" },
        { op: "entity", ref: "@dup", type: "note" },
      ],
    });
    expect(response.status).toBe(422);
    const errors = (body as any).error.details.errors as Array<any>;
    expect(errors.find((e) => e.code === "duplicate_ref")).toBeDefined();
  });

  test("400 on invalid envelope (wrong format version)", async () => {
    const { response } = await opsRequest(actor.apiKey, {
      format: "arke.ops/v999",
      ops: [{ op: "entity", ref: "@x", type: "note" }],
    });
    expect(response.status).toBe(400);
  });

  test("400 on missing format field", async () => {
    const { response } = await opsRequest(actor.apiKey, {
      ops: [{ op: "entity", ref: "@x", type: "note" }],
    });
    expect(response.status).toBe(400);
  });

  test("400 on empty ops array", async () => {
    const { response } = await opsRequest(actor.apiKey, {
      format: "arke.ops/v1",
      ops: [],
    });
    expect(response.status).toBe(400);
  });

  test("404 on non-existent source.entity_id", async () => {
    const fakeUlid = "01ZZZZZZZZZZZZZZZZZZZZZZZZ";
    const { response, body } = await opsRequest(actor.apiKey, {
      format: "arke.ops/v1",
      source: { entity_id: fakeUlid },
      ops: [{ op: "entity", ref: "@x", type: "note", label: uniqueName("src-test") }],
    });
    expect(response.status).toBe(404);
    const err = (body as any).error;
    expect(err.code).toBe("source_not_found");
    expect(err.details.source_entity_id).toBe(fakeUlid);
    expect(err.details.fix).toBeDefined();
  });

  test("404 on relate referencing non-existent ULID", async () => {
    const fakeUlid = "01ZZZZZZZZZZZZZZZZZZZZZZZZ";
    const { response, body } = await opsRequest(actor.apiKey, {
      format: "arke.ops/v1",
      ops: [
        { op: "entity", ref: "@jane", type: "person", label: uniqueName("ghost-ref") },
        { op: "relate", source: "@jane", target: fakeUlid, predicate: "knows" },
      ],
    });
    expect(response.status).toBe(404);
    const err = (body as any).error;
    expect(err.code).toBe("target_not_found");
    expect(err.details.op_index).toBe(1);
    expect(err.details.field).toBe("target");
    expect(err.details.offending_value).toBe(fakeUlid);
  });

  test("source.entity_id creates extracted_from edges from every created entity", async () => {
    // Create a source document
    const sourceDoc = await createEntity(actor.apiKey, "document", {
      label: uniqueName("source-doc"),
    });

    const { response, body } = await opsRequest(actor.apiKey, {
      format: "arke.ops/v1",
      source: {
        entity_id: sourceDoc.id,
        extracted_by: { model: "test-model", run_id: "run-1" },
      },
      ops: [
        { op: "entity", ref: "@a", type: "person", label: uniqueName("a") },
        { op: "entity", ref: "@b", type: "person", label: uniqueName("b") },
        { op: "relate", source: "@a", target: "@b", predicate: "knows" },
      ],
    });
    expect(response.status).toBe(200);
    const data = body as OpsResponse;
    expect(data.entities).toHaveLength(2);

    // Check that each created entity has an extracted_from edge to the source
    for (const entity of data.entities) {
      const { response: relResp, body: relBody } = await apiRequest(
        `/entities/${entity.id}/relationships?direction=out&predicate=extracted_from`,
        { apiKey: actor.apiKey },
      );
      expect(relResp.status).toBe(200);
      const rels = (relBody as any).relationships as Array<any>;
      const toSource = rels.find((r) => r.target_id === sourceDoc.id);
      expect(toSource).toBeDefined();
      expect(toSource.predicate).toBe("extracted_from");
    }
  });

  test("entity with space_id atomically adds it to the space", async () => {
    const space = await createSpace(actor.apiKey, uniqueName("ops-space"));
    // Actor is creator + owner of the space, so has contributor access

    const { response, body } = await opsRequest(actor.apiKey, {
      format: "arke.ops/v1",
      ops: [
        {
          op: "entity",
          ref: "@s",
          type: "note",
          label: uniqueName("space-scoped"),
          space_id: space.id,
        },
      ],
    });
    expect(response.status).toBe(200);
    const data = body as OpsResponse;
    expect(data.entities).toHaveLength(1);

    // Verify the entity is in the space
    const { response: listResp, body: listBody } = await apiRequest(
      `/spaces/${space.id}/entities?limit=50`,
      { apiKey: actor.apiKey },
    );
    expect(listResp.status).toBe(200);
    const entities = (listBody as any).entities as Array<any>;
    expect(entities.find((e) => e.id === data.entities[0].id)).toBeDefined();
  });

  test("defaults block applies to ops that don't override", async () => {
    const space = await createSpace(actor.apiKey, uniqueName("default-space"));

    const { response, body } = await opsRequest(actor.apiKey, {
      format: "arke.ops/v1",
      defaults: { space_id: space.id },
      ops: [
        { op: "entity", ref: "@a", type: "note", label: uniqueName("def-a") },
        { op: "entity", ref: "@b", type: "note", label: uniqueName("def-b") },
      ],
    });
    expect(response.status).toBe(200);
    const data = body as OpsResponse;

    // Both entities should be in the space
    const { body: listBody } = await apiRequest(`/spaces/${space.id}/entities?limit=50`, {
      apiKey: actor.apiKey,
    });
    const ids = new Set((listBody as any).entities.map((e: any) => e.id));
    expect(ids.has(data.entities[0].id)).toBe(true);
    expect(ids.has(data.entities[1].id)).toBe(true);
  });

  test("classification ceiling enforced — requesting read_level > actor.max_read_level is rejected", async () => {
    const lowActor = await createActor(adminApiKey, { maxReadLevel: 1, maxWriteLevel: 1 });
    const { response, body } = await opsRequest(lowActor.apiKey, {
      format: "arke.ops/v1",
      ops: [
        { op: "entity", ref: "@x", type: "note", label: uniqueName("over"), read_level: 3 },
      ],
    });
    expect(response.status).toBe(403);
    const err = (body as any).error;
    expect(err.code).toBe("invalid_classification");
    expect(err.details.op_index).toBe(0);
    expect(err.details.requested).toBe(3);
    expect(err.details.ceiling).toBe(1);
    expect(err.details.fix).toContain("Lower read_level");
  });

  test("atomicity — if any op fails, nothing is committed", async () => {
    const beforeLabel = uniqueName("atomic-before");
    const goodLabel = uniqueName("atomic-good");

    // First op is valid, second op references a non-existent entity.
    // Expect whole batch to roll back — the valid entity should NOT exist.
    const { response, body } = await opsRequest(actor.apiKey, {
      format: "arke.ops/v1",
      ops: [
        { op: "entity", ref: "@good", type: "note", label: goodLabel },
        { op: "relate", source: "@good", target: "01ZZZZZZZZZZZZZZZZZZZZZZZZ", predicate: "refs" },
      ],
    });
    expect(response.status).toBe(404);

    // The @good entity should NOT exist — search by label
    const { body: searchBody } = await apiRequest(
      `/entities?filter=label:${encodeURIComponent(goodLabel)}&limit=5`,
      { apiKey: actor.apiKey },
    );
    const results = (searchBody as any).entities as Array<any>;
    expect(results.length).toBe(0);
  });
});
