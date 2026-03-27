import { describe, expect, test } from "vitest";

import {
  apiRequest,
  createCommons,
  createEntity,
  createRelationship,
  jsonRequest,
  registerAgent,
  uniqueName,
  uploadDirectContent,
} from "./helpers";

describe("concurrency", () => {
  test("concurrent entity updates on the same version produce one success and one cas_conflict", async () => {
    const owner = await registerAgent();
    const commons = await createCommons(owner.apiKey, { label: uniqueName("concurrency-commons") });
    const entity = await createEntity(owner.apiKey, commons.id, "note", { label: uniqueName("concurrency-entity") });

    const [first, second] = await Promise.all([
      jsonRequest(`/entities/${entity.id}`, {
        method: "PUT",
        apiKey: owner.apiKey,
        json: { ver: entity.ver, properties: { label: "update-a" } },
      }),
      jsonRequest(`/entities/${entity.id}`, {
        method: "PUT",
        apiKey: owner.apiKey,
        json: { ver: entity.ver, properties: { label: "update-b" } },
      }),
    ]);

    const statuses = [first.response.status, second.response.status].sort((a, b) => a - b);
    expect(statuses).toEqual([200, 409]);
  });

  test("concurrent relationship updates on the same version produce one success and one cas_conflict", async () => {
    const owner = await registerAgent();
    const commons = await createCommons(owner.apiKey, { label: uniqueName("concurrency-rel-commons") });
    const source = await createEntity(owner.apiKey, commons.id, "note", { label: uniqueName("source") });
    const target = await createEntity(owner.apiKey, commons.id, "note", { label: uniqueName("target") });
    const relationship = await createRelationship(owner.apiKey, source.id, "references", target.id, { note: "v1" });
    const relId = relationship.relationship_entity.id;

    const [first, second] = await Promise.all([
      jsonRequest(`/relationships/${relId}`, {
        method: "PUT",
        apiKey: owner.apiKey,
        json: { ver: 1, properties: { note: "a" } },
      }),
      jsonRequest(`/relationships/${relId}`, {
        method: "PUT",
        apiKey: owner.apiKey,
        json: { ver: 1, properties: { note: "b" } },
      }),
    ]);

    const statuses = [first.response.status, second.response.status].sort((a, b) => a - b);
    expect(statuses).toEqual([200, 409]);
  });

  test("concurrent content mutations on the same version do not both succeed", async () => {
    const owner = await registerAgent();
    const commons = await createCommons(owner.apiKey, { label: uniqueName("concurrency-content-commons") });
    const entity = await createEntity(owner.apiKey, commons.id, "file", { label: uniqueName("concurrency-content-entity") });
    await uploadDirectContent(owner.apiKey, entity.id, "file", 1, "content");

    const [renameResult, deleteResult] = await Promise.all([
      jsonRequest(`/entities/${entity.id}/content`, {
        method: "PATCH",
        apiKey: owner.apiKey,
        json: { from: "file", to: "renamed", ver: 2 },
      }),
      apiRequest(`/entities/${entity.id}/content?key=file&ver=2`, {
        method: "DELETE",
        apiKey: owner.apiKey,
      }),
    ]);

    const statuses = [renameResult.response.status, deleteResult.response.status].sort((a, b) => a - b);
    expect(statuses[0]).toBeGreaterThanOrEqual(200);
    expect(statuses[1]).toBeGreaterThanOrEqual(204);
    expect(statuses).not.toEqual([200, 204]);
  });
});
