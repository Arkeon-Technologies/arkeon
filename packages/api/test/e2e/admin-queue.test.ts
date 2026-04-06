import { describe, test, expect } from "vitest";
import { apiRequest, jsonRequest, adminApiKey, createActor } from "./helpers";

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
