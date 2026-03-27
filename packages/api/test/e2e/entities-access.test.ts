import { describe, expect, test } from "vitest";

import { apiRequest, createCommons, createEntity, createGrant, jsonRequest, registerAgent, uniqueName } from "./helpers";

describe("entities and access", () => {
  test("create, update, view versions, and tombstone an entity", async () => {
    const owner = await registerAgent();
    const commons = await createCommons(owner.apiKey, { label: uniqueName("entity-commons") });
    const entity = await createEntity(owner.apiKey, commons.id, "note", {
      label: uniqueName("entity"),
      description: "version 1",
    });

    const { response: updateResponse, body: updateBody } = await jsonRequest(`/entities/${entity.id}`, {
      method: "PUT",
      apiKey: owner.apiKey,
      json: {
        ver: entity.ver,
        properties: { label: entity.properties.label, description: "version 2" },
        note: "v2",
      },
    });
    expect(updateResponse.status).toBe(200);
    expect((updateBody as any).entity.ver).toBe(entity.ver + 1);

    const { response: versionsResponse, body: versionsBody } = await apiRequest(`/entities/${entity.id}/versions`);
    expect(versionsResponse.status).toBe(200);
    expect((versionsBody as any).versions.length).toBeGreaterThanOrEqual(2);

    const { response: versionDetailResponse, body: versionDetailBody } = await apiRequest(`/entities/${entity.id}/versions/1`);
    expect(versionDetailResponse.status).toBe(200);
    expect((versionDetailBody as any).ver).toBe(1);

    const { response: tombstoneResponse, body: tombstoneBody } = await jsonRequest(`/entities/${entity.id}`, {
      method: "PUT",
      apiKey: owner.apiKey,
      json: {
        ver: (updateBody as any).entity.ver,
        tombstone: true,
      },
    });
    expect(tombstoneResponse.status).toBe(200);
    expect((tombstoneBody as any).entity.ver).toBe(entity.ver + 2);
    expect((tombstoneBody as any).entity.properties).toEqual({});
  });

  test("manage policies, grants, and ownership transfer", async () => {
    const owner = await registerAgent();
    const collaborator = await registerAgent();
    const nextOwner = await registerAgent();
    const commons = await createCommons(owner.apiKey, { label: uniqueName("access-commons") });
    const entity = await createEntity(owner.apiKey, commons.id, "note", { label: uniqueName("access-entity") });

    const { response: accessResponse, body: accessBody } = await apiRequest(`/entities/${entity.id}/access`);
    expect(accessResponse.status).toBe(200);
    expect((accessBody as any).owner_id).toBe(owner.entityId);

    const { response: policyResponse, body: policyBody } = await jsonRequest(`/entities/${entity.id}/access`, {
      method: "PUT",
      apiKey: owner.apiKey,
      json: {
        view_access: "private",
        edit_access: "collaborators",
        contribute_access: "contributors",
      },
    });
    expect(policyResponse.status).toBe(200);
    expect((policyBody as any).view_access).toBe("private");

    await createGrant(owner.apiKey, entity.id, collaborator.entityId, "edit");
    await createGrant(owner.apiKey, entity.id, collaborator.entityId, "admin");

    const { response: deleteTypeResponse } = await apiRequest(`/entities/${entity.id}/access/grants/${collaborator.entityId}/edit`, {
      method: "DELETE",
      apiKey: owner.apiKey,
    });
    expect(deleteTypeResponse.status).toBe(204);

    await createGrant(owner.apiKey, entity.id, collaborator.entityId, "view");
    const { response: deleteActorResponse } = await apiRequest(`/entities/${entity.id}/access/grants/${collaborator.entityId}`, {
      method: "DELETE",
      apiKey: owner.apiKey,
    });
    expect(deleteActorResponse.status).toBe(204);

    const { response: transferResponse, body: transferBody } = await jsonRequest(`/entities/${entity.id}/access/owner`, {
      method: "PUT",
      apiKey: owner.apiKey,
      json: { new_owner_id: nextOwner.entityId },
    });
    expect(transferResponse.status).toBe(200);
    expect((transferBody as any).owner_id).toBe(nextOwner.entityId);

    const { response: updateResponse } = await jsonRequest(`/entities/${entity.id}`, {
      method: "PUT",
      apiKey: nextOwner.apiKey,
      json: {
        ver: entity.ver,
        properties: { label: "new owner edit" },
      },
    });
    expect(updateResponse.status).toBe(200);
  });
});
