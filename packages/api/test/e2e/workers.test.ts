// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import {
  adminApiKey,
  apiRequest,
  createActor,
  createWorker,
  getJson,
  jsonRequest,
  uniqueName,
} from "./helpers";

describe("Workers", () => {
  test("Create worker actor with valid config", async () => {
    const worker = await createWorker(adminApiKey);
    expect(worker.id).toBeTruthy();
    expect(worker.properties.name).toBeTruthy();
    expect(worker.properties.system_prompt).toBe("You are a test worker.");
    // Keys should be encrypted, not plaintext
    expect(worker.properties.arke_key_encrypted).toBeTruthy();
    expect(worker.properties.arke_key_hint).toBeTruthy();
    expect((worker.properties.llm as any).api_key_encrypted).toBeTruthy();
    expect((worker.properties.llm as any).api_key_hint).toBeTruthy();
    // Plaintext key should NOT be in properties
    expect((worker.properties.llm as any).api_key).toBeUndefined();
  });

  test("Create worker missing name returns 400", async () => {
    const { response, body } = await jsonRequest("/actors", {
      method: "POST",
      apiKey: adminApiKey,
      json: {
        kind: "worker",
        system_prompt: "test",
        llm: { base_url: "https://example.com", api_key: "sk-test", model: "m" },
      },
    });
    expect(response.status).toBe(400);
    expect((body as any).error.code).toBe("missing_required_field");
  });

  test("Create worker missing system_prompt returns 400", async () => {
    const { response, body } = await jsonRequest("/actors", {
      method: "POST",
      apiKey: adminApiKey,
      json: {
        kind: "worker",
        name: uniqueName("worker"),
        llm: { base_url: "https://example.com", api_key: "sk-test", model: "m" },
      },
    });
    expect(response.status).toBe(400);
    expect((body as any).error.code).toBe("missing_required_field");
  });

  test("Create worker missing llm returns 400", async () => {
    const { response, body } = await jsonRequest("/actors", {
      method: "POST",
      apiKey: adminApiKey,
      json: {
        kind: "worker",
        name: uniqueName("worker"),
        system_prompt: "test",
      },
    });
    expect(response.status).toBe(400);
    expect((body as any).error.code).toBe("missing_required_field");
  });

  test("Get worker returns redacted keys", async () => {
    const worker = await createWorker(adminApiKey);
    const { response, body } = await getJson(`/workers/${worker.id}`, adminApiKey);
    expect(response.status).toBe(200);
    const config = (body as any).config;
    // Should have hint but NOT encrypted values
    expect(config.arke_key_hint).toBeTruthy();
    expect(config.llm.api_key_hint).toBeTruthy();
    // Encrypted fields should not be exposed
    expect(config.arke_key_encrypted).toBeUndefined();
    expect(config.llm.api_key_encrypted).toBeUndefined();
  });

  test("Update worker name", async () => {
    const worker = await createWorker(adminApiKey);
    const newName = uniqueName("updated");
    const { response, body } = await jsonRequest(`/workers/${worker.id}`, {
      method: "PUT",
      apiKey: adminApiKey,
      json: { name: newName },
    });
    expect(response.status).toBe(200);
    expect((body as any).config.name).toBe(newName);
  });

  test("Non-owner cannot access worker", async () => {
    const worker = await createWorker(adminApiKey);
    const other = await createActor(adminApiKey, {
      maxReadLevel: 1,
      maxWriteLevel: 1,
    });
    const { response } = await apiRequest(`/workers/${worker.id}`, {
      apiKey: other.apiKey,
    });
    expect(response.status).toBe(403);
  });

  test("Create worker with schedule returns 503 when Redis unavailable", async () => {
    const { response, body } = await jsonRequest("/actors", {
      method: "POST",
      apiKey: adminApiKey,
      json: {
        kind: "worker",
        name: uniqueName("worker"),
        system_prompt: "scheduled worker",
        llm: { base_url: "https://example.com", api_key: "sk-test", model: "m" },
        schedule: "0 * * * *",
        scheduled_prompt: "do something",
      },
    });
    // 503 if no Redis, 201 if Redis is available — both are valid
    expect([201, 503]).toContain(response.status);
    if (response.status === 503) {
      expect((body as any).error.code).toBe("scheduler_unavailable");
    }
  });

  test("Update worker with schedule returns 503 when Redis unavailable", async () => {
    const worker = await createWorker(adminApiKey);
    const { response, body } = await jsonRequest(`/workers/${worker.id}`, {
      method: "PUT",
      apiKey: adminApiKey,
      json: {
        schedule: "0 * * * *",
        scheduled_prompt: "do something",
      },
    });
    expect([200, 503]).toContain(response.status);
    if (response.status === 503) {
      expect((body as any).error.code).toBe("scheduler_unavailable");
    }
  });

  test("Non-owner cannot update worker", async () => {
    const worker = await createWorker(adminApiKey);
    const other = await createActor(adminApiKey, {
      maxReadLevel: 1,
      maxWriteLevel: 1,
    });
    const { response } = await jsonRequest(`/workers/${worker.id}`, {
      method: "PUT",
      apiKey: other.apiKey,
      json: { name: "hijacked" },
    });
    expect(response.status).toBe(403);
  });

  // --- Invocation queue tests ---

  test("Invoke returns 202 with invocation_id by default", async () => {
    const worker = await createWorker(adminApiKey);
    const { response, body } = await jsonRequest(`/workers/${worker.id}/invoke`, {
      method: "POST",
      apiKey: adminApiKey,
      json: { prompt: "test prompt" },
    });
    expect(response.status).toBe(202);
    const data = body as { invocation_id: number; status: string };
    expect(data.invocation_id).toBeTruthy();
    expect(data.status).toBe("queued");
  });

  test("Invoke with ?wait=true blocks and returns result", async () => {
    const worker = await createWorker(adminApiKey);
    const { response, body } = await jsonRequest(`/workers/${worker.id}/invoke?wait=true`, {
      method: "POST",
      apiKey: adminApiKey,
      json: { prompt: "test prompt" },
    });
    // Worker has a fake LLM endpoint, so it will fail — but we still get a 200 with result
    expect(response.status).toBe(200);
    const data = body as { invocation_id: number; success: boolean; result: unknown; iterations: number; usage: unknown };
    expect(data.invocation_id).toBeTruthy();
    expect(typeof data.success).toBe("boolean");
    expect(typeof data.iterations).toBe("number");
    expect(data.usage).toBeTruthy();
    expect(typeof (data.usage as Record<string, unknown>).input_tokens).toBe("number");
  });

  test("Poll invocation by ID returns status and fields", async () => {
    const worker = await createWorker(adminApiKey);
    const { body: invokeBody } = await jsonRequest(`/workers/${worker.id}/invoke`, {
      method: "POST",
      apiKey: adminApiKey,
      json: { prompt: "poll test" },
    });
    const invocationId = (invokeBody as { invocation_id: number }).invocation_id;

    // Poll immediately — should exist with a valid status
    const { response, body } = await getJson(`/workers/invocations/${invocationId}`, adminApiKey);
    expect(response.status).toBe(200);
    const data = body as Record<string, unknown>;
    expect(data.id).toBe(invocationId);
    expect(data.prompt).toBe("poll test");
    expect(data.source).toBe("http");
    expect(["queued", "running", "completed", "failed"]).toContain(data.status);
    expect(data.queued_at).toBeTruthy();
  });

  test("Poll invocation transitions to completed/failed", async () => {
    const worker = await createWorker(adminApiKey);
    // Use ?wait=true to ensure execution completes before polling
    const { body: invokeBody } = await jsonRequest(`/workers/${worker.id}/invoke?wait=true`, {
      method: "POST",
      apiKey: adminApiKey,
      json: { prompt: "completion test" },
    });
    const invocationId = (invokeBody as { invocation_id: number }).invocation_id;

    // Small delay for fire-and-forget DB update to settle
    await new Promise((r) => setTimeout(r, 500));

    const { response, body } = await getJson(`/workers/invocations/${invocationId}`, adminApiKey);
    expect(response.status).toBe(200);
    const data = body as Record<string, unknown>;
    expect(["completed", "failed"]).toContain(data.status);
    expect(data.started_at).toBeTruthy();
    expect(data.completed_at).toBeTruthy();
    expect(typeof data.duration_ms).toBe("number");
    expect(typeof data.success).toBe("boolean");
  });

  test("Poll nonexistent invocation returns 404", async () => {
    const { response } = await getJson("/workers/invocations/999999", adminApiKey);
    expect(response.status).toBe(404);
  });

  test("Invocation appears in worker invocation list", async () => {
    const worker = await createWorker(adminApiKey);
    await jsonRequest(`/workers/${worker.id}/invoke?wait=true`, {
      method: "POST",
      apiKey: adminApiKey,
      json: { prompt: "list test" },
    });

    // Small delay for fire-and-forget DB update
    await new Promise((r) => setTimeout(r, 500));

    const { response, body } = await getJson(`/workers/${worker.id}/invocations`, adminApiKey);
    expect(response.status).toBe(200);
    const data = body as { invocations: Array<Record<string, unknown>> };
    expect(data.invocations.length).toBeGreaterThanOrEqual(1);
    const inv = data.invocations.find((i) => i.prompt === "list test");
    expect(inv).toBeTruthy();
    expect(inv!.status).toBeTruthy();
    expect(inv!.queued_at).toBeTruthy();
  });

  test("Non-owner cannot invoke worker", async () => {
    const worker = await createWorker(adminApiKey);
    const other = await createActor(adminApiKey, {
      maxReadLevel: 1,
      maxWriteLevel: 1,
    });
    const { response } = await jsonRequest(`/workers/${worker.id}/invoke`, {
      method: "POST",
      apiKey: other.apiKey,
      json: { prompt: "unauthorized" },
    });
    expect(response.status).toBe(403);
  });
});
