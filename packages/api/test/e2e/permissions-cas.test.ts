import { describe, expect, test } from "vitest";

import { apiRequest, createCommons, createEntity, createGrant, jsonRequest, registerAgent, uniqueName, uploadDirectContent } from "./helpers";

describe("permissions and cas", () => {
  test("anonymous access to private entity returns forbidden", async () => {
    const owner = await registerAgent();
    const commons = await createCommons(owner.apiKey, { label: uniqueName("private-commons") });
    const entity = await createEntity(owner.apiKey, commons.id, "note", { label: uniqueName("private-entity") });
    const { response: policyResponse } = await jsonRequest(`/entities/${entity.id}/access`, {
      method: "PUT",
      apiKey: owner.apiKey,
      json: { view_access: "private" },
    });
    expect(policyResponse.status).toBe(200);

    const { response, body } = await apiRequest(`/entities/${entity.id}`);
    expect(response.status).toBe(403);
    expect((body as any).error.code).toBe("forbidden");
  });

  test("stale versions on entity and content operations return cas_conflict", async () => {
    const owner = await registerAgent();
    const commons = await createCommons(owner.apiKey, { label: uniqueName("cas-commons") });
    const entity = await createEntity(owner.apiKey, commons.id, "note", { label: uniqueName("cas-entity") });

    const { response: firstUpdateResponse } = await jsonRequest(`/entities/${entity.id}`, {
      method: "PUT",
      apiKey: owner.apiKey,
      json: { ver: entity.ver, properties: { label: "updated once" } },
    });
    expect(firstUpdateResponse.status).toBe(200);

    const { response: staleUpdateResponse, body: staleUpdateBody } = await jsonRequest(`/entities/${entity.id}`, {
      method: "PUT",
      apiKey: owner.apiKey,
      json: { ver: entity.ver, properties: { label: "stale update" } },
    });
    expect(staleUpdateResponse.status).toBe(409);
    expect((staleUpdateBody as any).error.code).toBe("cas_conflict");

    await uploadDirectContent(owner.apiKey, entity.id, "file", 2, "cas content");
    const { response: staleContentResponse, body: staleContentBody } = await apiRequest(`/entities/${entity.id}/content?key=file&ver=2`, {
      method: "DELETE",
      apiKey: owner.apiKey,
    });
    expect(staleContentResponse.status).toBe(409);
    expect((staleContentBody as any).error.code).toBe("cas_conflict");
  });

  test("non-owner admin cannot revoke another admin", async () => {
    const owner = await registerAgent();
    const adminA = await registerAgent();
    const adminB = await registerAgent();
    const commons = await createCommons(owner.apiKey, { label: uniqueName("admin-commons") });
    const entity = await createEntity(owner.apiKey, commons.id, "note", { label: uniqueName("admin-entity") });

    await createGrant(owner.apiKey, entity.id, adminA.entityId, "admin");
    await createGrant(owner.apiKey, entity.id, adminB.entityId, "admin");

    const { response, body } = await apiRequest(`/entities/${entity.id}/access/grants/${adminB.entityId}/admin`, {
      method: "DELETE",
      apiKey: adminA.apiKey,
    });
    expect(response.status).toBe(403);
    expect((body as any).error.code).toBe("forbidden");
  });
});
