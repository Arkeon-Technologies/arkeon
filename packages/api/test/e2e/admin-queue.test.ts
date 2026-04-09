import { describe, test, expect } from "vitest";
import { apiRequest, jsonRequest, adminApiKey, createActor, createWorker } from "./helpers";

describe("Admin queue endpoints", () => {
  test("GET /admin/queue returns queue stats", async () => {
    const { response, body } = await apiRequest("/admin/queue", {
      apiKey: adminApiKey,
    });
    expect(response.status).toBe(200);

    const data = body as Record<string, any>;
    expect(data).toHaveProperty("running");
    expect(data).toHaveProperty("queued");
    expect(data).toHaveProperty("max_concurrent");
    expect(data).toHaveProperty("max_queue_depth");
    expect(data).toHaveProperty("free_memory_mb");

    expect(typeof data.running).toBe("number");
    expect(typeof data.max_concurrent).toBe("number");
    expect(data.running).toBeGreaterThanOrEqual(0);
    expect(data.max_concurrent).toBeGreaterThan(0);
  });

  test("GET /admin/queue requires admin", async () => {
    const actor = await createActor(adminApiKey);
    const { response } = await apiRequest("/admin/queue", {
      apiKey: actor.apiKey,
    });
    expect(response.status).toBe(403);
  });

  test("POST /admin/queue/reset cancels all and returns before/after", async () => {
    const { response, body } = await jsonRequest("/admin/queue/reset", {
      method: "POST",
      apiKey: adminApiKey,
    });
    expect(response.status).toBe(200);

    const data = body as Record<string, any>;
    expect(data).toHaveProperty("before");
    expect(data).toHaveProperty("after");
    expect(data).toHaveProperty("cancelled");

    expect(data.before).toHaveProperty("running");
    expect(data.before).toHaveProperty("queued");
    expect(data.after).toHaveProperty("running");
    expect(data.after).toHaveProperty("queued");
    expect(typeof data.cancelled).toBe("number");

    // After a reset, running and queued should both be 0
    expect(data.after.running).toBe(0);
    expect(data.after.queued).toBe(0);
  });

  test("POST /admin/queue/reset requires admin", async () => {
    const actor = await createActor(adminApiKey);
    const { response } = await jsonRequest("/admin/queue/reset", {
      method: "POST",
      apiKey: actor.apiKey,
    });
    expect(response.status).toBe(403);
  });

  test("reset aborts a running worker invocation", async () => {
    // Create a worker pointing at a non-routable IP — the LLM call will
    // hang on TCP connect, giving us a reliably "running" invocation.
    const worker = await createWorker(adminApiKey, {
      name: "slow-worker-reset-test",
      llm: {
        base_url: "http://10.255.255.1:1/v1",
        api_key: "sk-fake",
        model: "hang-model",
      },
    });

    // Fire invocation without ?wait=true — returns 202 immediately
    const { response: invokeResp, body: invokeBody } = await jsonRequest(
      `/workers/${worker.id}/invoke`,
      { method: "POST", apiKey: adminApiKey, json: { prompt: "this will hang" } },
    );
    expect(invokeResp.status).toBe(202);
    const invocationId = (invokeBody as { invocation_id: number }).invocation_id;

    // Poll until it transitions to running (sandbox init is slower in Docker)
    let running = 0;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const { body: statsBody } = await apiRequest("/admin/queue", { apiKey: adminApiKey });
      running = (statsBody as any).running ?? 0;
      if (running >= 1) break;
    }
    expect(running).toBeGreaterThanOrEqual(1);

    // Reset the queue — should abort the hanging invocation
    const { response: resetResp, body: resetBody } = await jsonRequest(
      "/admin/queue/reset",
      { method: "POST", apiKey: adminApiKey },
    );
    expect(resetResp.status).toBe(200);
    const resetData = resetBody as Record<string, any>;
    expect(resetData.before.running).toBeGreaterThanOrEqual(1);
    expect(resetData.cancelled).toBeGreaterThanOrEqual(1);
    expect(resetData.after.running).toBe(0);
    expect(resetData.after.queued).toBe(0);

    // Verify the invocation is now failed/cancelled in DB
    const { body: pollBody } = await apiRequest(
      `/workers/invocations/${invocationId}`,
      { apiKey: adminApiKey },
    );
    const pollData = pollBody as Record<string, any>;
    expect(["failed", "cancelled"]).toContain(pollData.status);
  }, 30_000);

  test("queue stats reflect reset", async () => {
    // Reset first
    await jsonRequest("/admin/queue/reset", {
      method: "POST",
      apiKey: adminApiKey,
    });

    // Then check stats
    const { response, body } = await apiRequest("/admin/queue", {
      apiKey: adminApiKey,
    });
    expect(response.status).toBe(200);

    const data = body as Record<string, any>;
    expect(data.running).toBe(0);
    expect(data.queued).toBe(0);
  });
});
