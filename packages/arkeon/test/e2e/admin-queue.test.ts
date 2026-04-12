// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

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

  test("POST /admin/queue/reset requires admin", async () => {
    const actor = await createActor(adminApiKey);
    const { response } = await jsonRequest("/admin/queue/reset", {
      method: "POST",
      apiKey: actor.apiKey,
    });
    expect(response.status).toBe(403);
  });
});
