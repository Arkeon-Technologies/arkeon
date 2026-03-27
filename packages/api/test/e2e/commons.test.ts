import { describe, expect, test } from "vitest";

import { apiRequest, createCommons, createEntity, jsonRequest, registerAgent, uniqueName } from "./helpers";

describe("commons", () => {
  test("create, get, update, list children, feed, and delete commons", async () => {
    const owner = await registerAgent();
    const parent = await createCommons(owner.apiKey, { label: uniqueName("parent-commons") });
    const childCommons = await createCommons(owner.apiKey, { label: uniqueName("child-commons") }, { commons_id: parent.id });
    const entity = await createEntity(owner.apiKey, parent.id, "note", {
      label: uniqueName("commons-entity"),
      description: "listed in commons entities",
    });

    const { response: getResponse, body: getBody } = await apiRequest(`/commons/${parent.id}`);
    expect(getResponse.status).toBe(200);
    expect((getBody as any).commons.id).toBe(parent.id);

    const { response: etagResponse } = await apiRequest(`/commons/${parent.id}`, {
      headers: { "if-none-match": `"${parent.ver}"` },
    });
    expect(etagResponse.status).toBe(304);

    const { response: updateResponse, body: updateBody } = await jsonRequest(`/commons/${parent.id}`, {
      method: "PUT",
      apiKey: owner.apiKey,
      json: {
        ver: parent.ver,
        properties: { label: uniqueName("updated-parent"), description: "updated commons" },
        note: "commons updated",
      },
    });
    expect(updateResponse.status).toBe(200);
    expect((updateBody as any).commons.ver).toBe(parent.ver + 1);

    const { response: entitiesResponse, body: entitiesBody } = await apiRequest(`/commons/${parent.id}/entities`);
    expect(entitiesResponse.status).toBe(200);
    expect((entitiesBody as any).entities.some((row: any) => row.id === entity.id)).toBe(true);

    const { response: childResponse, body: childBody } = await apiRequest(`/commons/${parent.id}/commons`);
    expect(childResponse.status).toBe(200);
    expect((childBody as any).commons.some((row: any) => row.id === childCommons.id)).toBe(true);

    const { response: feedResponse, body: feedBody } = await apiRequest(`/commons/${parent.id}/feed`);
    expect(feedResponse.status).toBe(200);
    expect((feedBody as any).activity.length).toBeGreaterThanOrEqual(1);

    const { response: deleteResponse } = await apiRequest(`/commons/${childCommons.id}`, {
      method: "DELETE",
      apiKey: owner.apiKey,
    });
    expect(deleteResponse.status).toBe(204);

    const { response: deletedGetResponse, body: deletedGetBody } = await apiRequest(`/commons/${childCommons.id}`);
    expect(deletedGetResponse.status).toBe(404);
    expect((deletedGetBody as any).error.code).toBe("not_found");
  });
});
