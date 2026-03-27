import { describe, expect, test } from "vitest";

import { apiRequest, jsonRequest, recoverAgent, registerAgent } from "./helpers";

describe("auth", () => {
  test("register, list keys, revoke key, and protect current key", async () => {
    const agent = await registerAgent();

    const { response: meResponse, body: meBody } = await apiRequest("/auth/me", {
      apiKey: agent.apiKey,
    });
    expect(meResponse.status).toBe(200);
    expect((meBody as any).entity.id).toBe(agent.entityId);

    const { response: createKeyResponse, body: createKeyBody } = await jsonRequest("/auth/keys", {
      method: "POST",
      apiKey: agent.apiKey,
      json: { label: "secondary" },
    });
    expect(createKeyResponse.status).toBe(201);
    expect((createKeyBody as any).label).toBe("secondary");
    const secondaryKeyId = (createKeyBody as any).id;

    const { response: listResponse, body: listBody } = await apiRequest("/auth/keys", {
      apiKey: agent.apiKey,
    });
    expect(listResponse.status).toBe(200);
    expect((listBody as any).keys.length).toBeGreaterThanOrEqual(2);

    const { response: currentDeleteResponse, body: currentDeleteBody } = await apiRequest(`/auth/keys/${secondaryKeyId}`, {
      method: "DELETE",
      apiKey: (createKeyBody as any).api_key,
    });
    expect(currentDeleteResponse.status).toBe(403);
    expect((currentDeleteBody as any).error.code).toBe("forbidden");

    const { response: deleteResponse } = await apiRequest(`/auth/keys/${secondaryKeyId}`, {
      method: "DELETE",
      apiKey: agent.apiKey,
    });
    expect(deleteResponse.status).toBe(204);

    const { response: revokedListResponse, body: revokedListBody } = await apiRequest("/auth/keys?include_revoked=true", {
      apiKey: agent.apiKey,
    });
    expect(revokedListResponse.status).toBe(200);
    expect((revokedListBody as any).keys.some((key: any) => key.id === secondaryKeyId && key.revoked_at)).toBe(true);
  });

  test("recover rotates credentials and invalidates old key", async () => {
    const agent = await registerAgent();
    const { response, body } = await recoverAgent(agent);

    expect(response.status).toBe(201);
    expect(body.entity_id).toBe(agent.entityId);
    expect(body.api_key).toMatch(/^ak_[0-9a-f]{64}$/);

    const { response: oldMeResponse, body: oldMeBody } = await apiRequest("/auth/me", {
      apiKey: agent.apiKey,
    });
    expect(oldMeResponse.status).toBe(401);
    expect((oldMeBody as any).error.code).toBe("authentication_required");

    const { response: newMeResponse, body: newMeBody } = await apiRequest("/auth/me", {
      apiKey: body.api_key,
    });
    expect(newMeResponse.status).toBe(200);
    expect((newMeBody as any).entity.id).toBe(agent.entityId);
  });

  test("unauthenticated auth/me is rejected", async () => {
    const { response, body } = await apiRequest("/auth/me");
    expect(response.status).toBe(401);
    expect((body as any).error.code).toBe("authentication_required");
  });
});
