// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import {
  adminApiKey,
  apiRequest,
  createActor,
  getJson,
  jsonRequest,
  uniqueName,
} from "./helpers";

describe("Actors", () => {
  test("Admin can create actor at any level", async () => {
    const actor = await createActor(adminApiKey, {
      maxReadLevel: 4,
      maxWriteLevel: 4,
    });
    expect(actor.maxReadLevel).toBe(4);
    expect(actor.maxWriteLevel).toBe(4);
    expect(actor.apiKey).toBeTruthy();
  });

  test("Actor can create actor at lower level", async () => {
    const parent = await createActor(adminApiKey, {
      maxReadLevel: 3,
      maxWriteLevel: 3,
    });
    const child = await createActor(parent.apiKey, {
      maxReadLevel: 2,
      maxWriteLevel: 2,
    });
    expect(child.maxReadLevel).toBe(2);
    expect(child.maxWriteLevel).toBe(2);
  });

  test("Actor cannot create actor above their level", async () => {
    const parent = await createActor(adminApiKey, {
      maxReadLevel: 2,
      maxWriteLevel: 2,
    });
    const { response } = await jsonRequest("/actors", {
      method: "POST",
      apiKey: parent.apiKey,
      json: {
        kind: "agent",
        max_read_level: 3,
        max_write_level: 3,
        properties: { label: uniqueName("above-level") },
      },
    });
    expect([403, 500]).toContain(response.status);
  });

  test("Actor can create actor at same level", async () => {
    const parent = await createActor(adminApiKey, {
      maxReadLevel: 2,
      maxWriteLevel: 2,
    });
    const child = await createActor(parent.apiKey, {
      maxReadLevel: 2,
      maxWriteLevel: 2,
    });
    expect(child.maxReadLevel).toBe(2);
    expect(child.maxWriteLevel).toBe(2);
  });

  test("List actors returns all actors", async () => {
    const actor = await createActor(adminApiKey, {
      maxReadLevel: 1,
      maxWriteLevel: 1,
    });
    const { response, body } = await getJson("/actors", actor.apiKey);
    expect(response.status).toBe(200);
    expect((body as any).actors.length).toBeGreaterThan(0);
  });

  test("Get actor by ID", async () => {
    const actor = await createActor(adminApiKey, {
      maxReadLevel: 1,
      maxWriteLevel: 1,
      properties: { label: uniqueName("get-by-id") },
    });
    const { response, body } = await getJson(`/actors/${actor.id}`, adminApiKey);
    expect(response.status).toBe(200);
    expect((body as any).actor.id).toBe(actor.id);
  });

  test("Actor can update own properties", async () => {
    const actor = await createActor(adminApiKey, {
      maxReadLevel: 1,
      maxWriteLevel: 1,
      properties: { label: "original" },
    });
    const { response, body } = await jsonRequest(`/actors/${actor.id}`, {
      method: "PUT",
      apiKey: actor.apiKey,
      json: { properties: { label: "updated" } },
    });
    expect(response.status).toBe(200);
    expect((body as any).actor.properties.label).toBe("updated");
  });

  test("Non-admin cannot update another actor's clearance", async () => {
    const actorA = await createActor(adminApiKey, {
      maxReadLevel: 2,
      maxWriteLevel: 2,
    });
    const actorB = await createActor(adminApiKey, {
      maxReadLevel: 1,
      maxWriteLevel: 1,
    });
    const { response } = await jsonRequest(`/actors/${actorB.id}`, {
      method: "PUT",
      apiKey: actorA.apiKey,
      json: { max_read_level: 3 },
    });
    expect(response.status).toBe(403);
  });

  test("Admin can deactivate actor", async () => {
    const actor = await createActor(adminApiKey, {
      maxReadLevel: 1,
      maxWriteLevel: 1,
    });
    const { response, body } = await apiRequest(`/actors/${actor.id}`, {
      method: "DELETE",
      apiKey: adminApiKey,
    });
    expect(response.status).toBe(200);
    expect((body as any).actor.status).toBe("deactivated");
  });

  test("Deactivated actor's API key stops working", async () => {
    const actor = await createActor(adminApiKey, {
      maxReadLevel: 1,
      maxWriteLevel: 1,
    });

    // Verify key works before deactivation
    const { response: beforeRes } = await apiRequest("/auth/me", {
      apiKey: actor.apiKey,
    });
    expect(beforeRes.status).toBe(200);

    // Deactivate
    await apiRequest(`/actors/${actor.id}`, {
      method: "DELETE",
      apiKey: adminApiKey,
    });

    // Verify key no longer works
    const { response: afterRes } = await apiRequest("/auth/me", {
      apiKey: actor.apiKey,
    });
    expect([401, 403]).toContain(afterRes.status);
  });
});
