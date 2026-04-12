// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import {
  adminApiKey,
  apiRequest,
  addGroupMember,
  createActor,
  createGroup,
  createWorker,
  getJson,
  grantWorkerPermission,
  jsonRequest,
  uniqueName,
} from "./helpers";

describe("Worker permissions", () => {
  let owner: Awaited<ReturnType<typeof createActor>>;

  test("setup: create owner actor", async () => {
    owner = await createActor(adminApiKey, {
      maxReadLevel: 3,
      maxWriteLevel: 3,
    });
  });

  test("Owner can list permissions (initially empty)", async () => {
    const worker = await createWorker(owner.apiKey);
    const { response, body } = await getJson(`/workers/${worker.id}/permissions`, owner.apiKey);
    expect(response.status).toBe(200);
    expect((body as any).owner_id).toBe(owner.id);
    expect((body as any).permissions).toEqual([]);
  });

  test("Owner can grant invoker permission to another actor", async () => {
    const worker = await createWorker(owner.apiKey);
    const invoker = await createActor(adminApiKey, { maxReadLevel: 1, maxWriteLevel: 1 });

    await grantWorkerPermission(owner.apiKey, worker.id, "actor", invoker.id);

    const { response, body } = await getJson(`/workers/${worker.id}/permissions`, owner.apiKey);
    expect(response.status).toBe(200);
    const perms = (body as any).permissions;
    expect(perms).toHaveLength(1);
    expect(perms[0].grantee_id).toBe(invoker.id);
    expect(perms[0].role).toBe("invoker");
  });

  test("Non-owner cannot grant permissions", async () => {
    const worker = await createWorker(owner.apiKey);
    const stranger = await createActor(adminApiKey, { maxReadLevel: 1, maxWriteLevel: 1 });

    const { response } = await jsonRequest(`/workers/${worker.id}/permissions`, {
      method: "POST",
      apiKey: stranger.apiKey,
      json: { grantee_type: "actor", grantee_id: stranger.id, role: "invoker" },
    });
    expect(response.status).toBe(403);
  });

  test("Non-owner cannot list permissions", async () => {
    const worker = await createWorker(owner.apiKey);
    const stranger = await createActor(adminApiKey, { maxReadLevel: 1, maxWriteLevel: 1 });

    const { response } = await getJson(`/workers/${worker.id}/permissions`, stranger.apiKey);
    expect(response.status).toBe(403);
  });

  test("Invoker can invoke worker but not view or update it", async () => {
    const worker = await createWorker(owner.apiKey);
    const invoker = await createActor(adminApiKey, { maxReadLevel: 1, maxWriteLevel: 1 });

    await grantWorkerPermission(owner.apiKey, worker.id, "actor", invoker.id);

    // Cannot GET worker config
    const { response: getRes } = await getJson(`/workers/${worker.id}`, invoker.apiKey);
    expect(getRes.status).toBe(403);

    // Cannot PUT worker config
    const { response: putRes } = await jsonRequest(`/workers/${worker.id}`, {
      method: "PUT",
      apiKey: invoker.apiKey,
      json: { name: "hijacked" },
    });
    expect(putRes.status).toBe(403);

    // CAN invoke (will fail at runtime because LLM config is fake, but auth should pass)
    // We check for non-403 status to confirm authorization succeeded
    const { response: invokeRes } = await jsonRequest(`/workers/${worker.id}/invoke`, {
      method: "POST",
      apiKey: invoker.apiKey,
      json: { prompt: "hello" },
    });
    // Should not be 403 (auth passed); likely 500 or similar since LLM config is fake
    expect(invokeRes.status).not.toBe(403);
  });

  test("Actor without invoker permission cannot invoke", async () => {
    const worker = await createWorker(owner.apiKey);
    const stranger = await createActor(adminApiKey, { maxReadLevel: 1, maxWriteLevel: 1 });

    const { response } = await jsonRequest(`/workers/${worker.id}/invoke`, {
      method: "POST",
      apiKey: stranger.apiKey,
      json: { prompt: "hello" },
    });
    expect(response.status).toBe(403);
  });

  test("Cross-level invocation: low-clearance actor can invoke high-clearance worker", async () => {
    // Owner has level 3, creates a worker at level 3
    const worker = await createWorker(owner.apiKey, { maxReadLevel: 3, maxWriteLevel: 3 });

    // Low-clearance invoker at level 1
    const lowInvoker = await createActor(adminApiKey, { maxReadLevel: 1, maxWriteLevel: 1 });

    await grantWorkerPermission(owner.apiKey, worker.id, "actor", lowInvoker.id);

    const { response } = await jsonRequest(`/workers/${worker.id}/invoke`, {
      method: "POST",
      apiKey: lowInvoker.apiKey,
      json: { prompt: "check this" },
    });
    // Auth passes (not 403), even though invoker has lower clearance than worker
    expect(response.status).not.toBe(403);
  });

  test("Group-based invoker permission", async () => {
    const worker = await createWorker(owner.apiKey);
    const group = await createGroup(adminApiKey, uniqueName("invoker-group"));
    const member = await createActor(adminApiKey, { maxReadLevel: 1, maxWriteLevel: 1 });

    await addGroupMember(adminApiKey, group.id, member.id);
    await grantWorkerPermission(owner.apiKey, worker.id, "group", group.id);

    // Group member can invoke
    const { response } = await jsonRequest(`/workers/${worker.id}/invoke`, {
      method: "POST",
      apiKey: member.apiKey,
      json: { prompt: "group invoke" },
    });
    expect(response.status).not.toBe(403);
  });

  test("Revoke permission: invoker loses access", async () => {
    const worker = await createWorker(owner.apiKey);
    const invoker = await createActor(adminApiKey, { maxReadLevel: 1, maxWriteLevel: 1 });

    await grantWorkerPermission(owner.apiKey, worker.id, "actor", invoker.id);

    // Verify invoke works
    const { response: okRes } = await jsonRequest(`/workers/${worker.id}/invoke`, {
      method: "POST",
      apiKey: invoker.apiKey,
      json: { prompt: "before revoke" },
    });
    expect(okRes.status).not.toBe(403);

    // Revoke
    const { response: revokeRes } = await apiRequest(
      `/workers/${worker.id}/permissions/${invoker.id}`,
      { method: "DELETE", apiKey: owner.apiKey },
    );
    expect(revokeRes.status).toBe(204);

    // Verify invoke now blocked
    const { response: failRes } = await jsonRequest(`/workers/${worker.id}/invoke`, {
      method: "POST",
      apiKey: invoker.apiKey,
      json: { prompt: "after revoke" },
    });
    expect(failRes.status).toBe(403);
  });

  test("Upsert: granting twice updates the grant", async () => {
    const worker = await createWorker(owner.apiKey);
    const invoker = await createActor(adminApiKey, { maxReadLevel: 1, maxWriteLevel: 1 });

    await grantWorkerPermission(owner.apiKey, worker.id, "actor", invoker.id);
    // Grant again — should upsert, not error
    await grantWorkerPermission(owner.apiKey, worker.id, "actor", invoker.id);

    const { body } = await getJson(`/workers/${worker.id}/permissions`, owner.apiKey);
    // Should still be exactly one permission, not two
    expect((body as any).permissions).toHaveLength(1);
  });

  test("Admin can grant and revoke permissions on any worker", async () => {
    const worker = await createWorker(owner.apiKey);
    const invoker = await createActor(adminApiKey, { maxReadLevel: 1, maxWriteLevel: 1 });

    // Admin grants
    await grantWorkerPermission(adminApiKey, worker.id, "actor", invoker.id);

    const { body } = await getJson(`/workers/${worker.id}/permissions`, owner.apiKey);
    expect((body as any).permissions).toHaveLength(1);

    // Admin revokes
    const { response: revokeRes } = await apiRequest(
      `/workers/${worker.id}/permissions/${invoker.id}`,
      { method: "DELETE", apiKey: adminApiKey },
    );
    expect(revokeRes.status).toBe(204);
  });

  test("Revoke nonexistent permission returns 404", async () => {
    const worker = await createWorker(owner.apiKey);
    const nobody = await createActor(adminApiKey, { maxReadLevel: 1, maxWriteLevel: 1 });

    const { response } = await apiRequest(
      `/workers/${worker.id}/permissions/${nobody.id}`,
      { method: "DELETE", apiKey: owner.apiKey },
    );
    expect(response.status).toBe(404);
  });
});
