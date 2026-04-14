// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * E2E tests for the knowledge extraction service.
 *
 * Tests config CRUD, manual ingest job creation, job listing,
 * and the content poller auto-enqueue behavior.
 *
 * Requires: running API server with Postgres (no LLM key needed for config/job tests).
 */

import { describe, test, expect, beforeAll } from "vitest";
import {
  adminApiKey,
  jsonRequest,
  getJson,
  apiRequest,
  createActor,
  createEntity,
  uploadDirectContent,
} from "./helpers";

let userActor: { id: string; apiKey: string };

beforeAll(async () => {
  userActor = await createActor(adminApiKey, {
    maxReadLevel: 2,
    maxWriteLevel: 2,
    properties: { label: "knowledge-test-user" },
  });
});

describe("Knowledge Config", () => {
  test("GET /knowledge/config returns default extraction config", async () => {
    const { response, body } = await getJson("/knowledge/config", adminApiKey);
    expect(response.status).toBe(200);
    const data = body as { llm: any[]; extraction: any };
    expect(data.extraction).toBeDefined();
    expect(data.extraction.entity_types).toBeInstanceOf(Array);
    expect(data.extraction.entity_types.length).toBeGreaterThan(0);
    expect(data.extraction.predicates).toBeInstanceOf(Array);
    expect(data.extraction.predicates.length).toBeGreaterThan(0);
    expect(data.llm).toBeInstanceOf(Array);
  });

  test("PUT /knowledge/config updates LLM config", async () => {
    const { response, body } = await jsonRequest("/knowledge/config", {
      method: "PUT",
      apiKey: adminApiKey,
      json: {
        llm: {
          default: {
            provider: "openai",
            base_url: "https://api.openai.com/v1",
            api_key: "sk-test-key-for-knowledge",
            model: "gpt-4o-mini",
            max_tokens: 8192,
          },
        },
      },
    });
    expect(response.status).toBe(200);
    const data = body as { llm: any[]; extraction: any };

    // Key should be stored but redacted in response
    const defaultConfig = data.llm.find((c: any) => c.id === "default");
    expect(defaultConfig).toBeDefined();
    expect(defaultConfig.model).toBe("gpt-4o-mini");
    expect(defaultConfig.has_key).toBe(true);
    expect(defaultConfig.api_key_hint).toMatch(/^sk-t\.\.\.edge$/);
    // Encrypted key should NOT be in the response
    expect(defaultConfig.api_key_encrypted).toBeUndefined();
    expect(defaultConfig.api_key).toBeUndefined();
  });

  test("PUT /knowledge/config updates extraction rules", async () => {
    const { response, body } = await jsonRequest("/knowledge/config", {
      method: "PUT",
      apiKey: adminApiKey,
      json: {
        extraction: {
          entity_types: ["person", "organization", "custom_type"],
          strict_entity_types: true,
          custom_instructions: "Focus on people and orgs only.",
        },
      },
    });
    expect(response.status).toBe(200);
    const data = body as { extraction: any };
    expect(data.extraction.entity_types).toEqual(["person", "organization", "custom_type"]);
    expect(data.extraction.strict_entity_types).toBe(true);
    expect(data.extraction.custom_instructions).toBe("Focus on people and orgs only.");
  });

  test("PUT /knowledge/config can update extraction without touching LLM", async () => {
    const { response } = await jsonRequest("/knowledge/config", {
      method: "PUT",
      apiKey: adminApiKey,
      json: {
        extraction: {
          custom_instructions: null,
          strict_entity_types: false,
        },
      },
    });
    expect(response.status).toBe(200);

    // Verify LLM config is unchanged
    const { body: checkBody } = await getJson("/knowledge/config", adminApiKey);
    const data = checkBody as { llm: any[]; extraction: any };
    const defaultConfig = data.llm.find((c: any) => c.id === "default");
    expect(defaultConfig?.model).toBe("gpt-4o-mini"); // unchanged
    expect(data.extraction.strict_entity_types).toBe(false);
    expect(data.extraction.custom_instructions).toBeNull();
  });

  test("DELETE /knowledge/config/:id removes LLM config", async () => {
    // Create a test config first
    await jsonRequest("/knowledge/config", {
      method: "PUT",
      apiKey: adminApiKey,
      json: {
        llm: {
          test_role: {
            provider: "openai",
            base_url: "https://api.openai.com/v1",
            api_key: "sk-test-key-for-delete",
            model: "gpt-test",
          },
        },
      },
    });

    const { response, body } = await jsonRequest("/knowledge/config/test_role", {
      method: "DELETE",
      apiKey: adminApiKey,
    });
    expect(response.status).toBe(200);
    expect((body as any).deleted).toBe(true);

    // Verify it's gone
    const { body: checkBody } = await getJson("/knowledge/config", adminApiKey);
    const testConfig = (checkBody as any).llm.find((c: any) => c.id === "test_role");
    expect(testConfig).toBeUndefined();
  });

  test("PUT /knowledge/config rejects CREATE without api_key (400)", async () => {
    // Creating a new id with provider + base_url + model but no api_key
    // used to succeed silently — the row would appear in GET but
    // resolveLlmConfig would refuse to return anything. Now it's a 400.
    const { response, body } = await jsonRequest("/knowledge/config", {
      method: "PUT",
      apiKey: adminApiKey,
      json: {
        llm: {
          no_key_role: {
            provider: "openai",
            base_url: "https://api.openai.com/v1",
            model: "gpt-4.1-nano",
          },
        },
      },
    });
    expect(response.status).toBe(400);
    expect((body as any).error?.code).toBe("missing_api_key");
  });

  test("PUT /knowledge/config allows model-only UPDATE when key is already stored", async () => {
    // First write an initial config with a key.
    await jsonRequest("/knowledge/config", {
      method: "PUT",
      apiKey: adminApiKey,
      json: {
        llm: {
          update_role: {
            provider: "openai",
            base_url: "https://api.openai.com/v1",
            api_key: "sk-initial-key",
            model: "gpt-4.1-nano",
          },
        },
      },
    });

    // Then update model only — no api_key — should succeed.
    const { response, body } = await jsonRequest("/knowledge/config", {
      method: "PUT",
      apiKey: adminApiKey,
      json: {
        llm: {
          update_role: {
            provider: "openai",
            base_url: "https://api.openai.com/v1",
            model: "gpt-4o-mini",
          },
        },
      },
    });
    expect(response.status).toBe(200);
    const data = body as { llm: any[] };
    const updated = data.llm.find((c: any) => c.id === "update_role");
    expect(updated?.model).toBe("gpt-4o-mini");
    expect(updated?.has_key).toBe(true);
  });

  test("GET /knowledge/config requires authentication", async () => {
    const { response } = await apiRequest("/knowledge/config");
    expect(response.status).toBe(401);
  });

  test("GET /knowledge/config requires admin", async () => {
    const { response } = await getJson("/knowledge/config", userActor.apiKey);
    expect(response.status).toBe(403);
  });

  test("PUT /knowledge/config requires admin", async () => {
    const { response } = await jsonRequest("/knowledge/config", {
      method: "PUT",
      apiKey: userActor.apiKey,
      json: { extraction: { strict_entity_types: true } },
    });
    expect(response.status).toBe(403);
  });
});

describe("Knowledge Ingest", () => {
  test("POST /knowledge/ingest creates jobs for entities", async () => {
    // Create a test entity with some content
    const entity = await createEntity(adminApiKey, "document", {
      label: "Test Document for KG Extraction",
      description: "A document to test knowledge graph extraction.",
    });

    const { response, body } = await jsonRequest("/knowledge/ingest", {
      method: "POST",
      apiKey: adminApiKey,
      json: { entity_ids: [entity.id] },
    });
    expect(response.status).toBe(200);
    const data = body as { jobs: any[] };
    expect(data.jobs).toHaveLength(1);
    expect(data.jobs[0].entity_id).toBe(entity.id);
    expect(data.jobs[0].status).toBe("queued");
    expect(data.jobs[0].job_id).toBeTruthy();
  });

  test("POST /knowledge/ingest deduplicates same entity+version", async () => {
    const entity = await createEntity(adminApiKey, "note", {
      label: "Dedupe Test Note",
    });

    // First ingest
    const { body: body1 } = await jsonRequest("/knowledge/ingest", {
      method: "POST",
      apiKey: adminApiKey,
      json: { entity_ids: [entity.id] },
    });
    expect((body1 as any).jobs[0].status).toBe("queued");

    // Second ingest of same entity (same version) — should be duplicate
    const { body: body2 } = await jsonRequest("/knowledge/ingest", {
      method: "POST",
      apiKey: adminApiKey,
      json: { entity_ids: [entity.id] },
    });
    expect((body2 as any).jobs[0].status).toBe("duplicate");
    expect((body2 as any).jobs[0].job_id).toBeNull();
  });

  test("POST /knowledge/ingest returns 404 for nonexistent entity", async () => {
    const { response } = await jsonRequest("/knowledge/ingest", {
      method: "POST",
      apiKey: adminApiKey,
      json: { entity_ids: ["01NONEXISTENT0000000000000"] },
    });
    expect(response.status).toBe(404);
  });

  test("POST /knowledge/ingest requires auth", async () => {
    const { response } = await jsonRequest("/knowledge/ingest", {
      method: "POST",
      json: { entity_ids: ["01ABC"] },
    });
    expect(response.status).toBe(401);
  });
});

describe("Knowledge Jobs", () => {
  test("GET /knowledge/jobs lists jobs", async () => {
    const { response, body } = await getJson("/knowledge/jobs", adminApiKey);
    expect(response.status).toBe(200);
    const data = body as { jobs: any[]; total: number };
    expect(data.jobs).toBeInstanceOf(Array);
    expect(typeof data.total).toBe("number");
  });

  test("GET /knowledge/jobs filters by status", async () => {
    const { response, body } = await getJson("/knowledge/jobs?status=pending", adminApiKey);
    expect(response.status).toBe(200);
    const data = body as { jobs: any[] };
    for (const job of data.jobs) {
      expect(job.status).toBe("pending");
    }
  });

  test("GET /knowledge/jobs/:id returns job with logs", async () => {
    // Create an entity and ingest it to get a job
    const entity = await createEntity(adminApiKey, "document", {
      label: "Job Detail Test",
    });

    const { body: ingestBody } = await jsonRequest("/knowledge/ingest", {
      method: "POST",
      apiKey: adminApiKey,
      json: { entity_ids: [entity.id] },
    });
    const jobId = (ingestBody as any).jobs[0].job_id;

    const { response, body } = await getJson(`/knowledge/jobs/${jobId}`, adminApiKey);
    expect(response.status).toBe(200);
    const data = body as { job: any; logs: any[] };
    expect(data.job.id).toBe(jobId);
    expect(data.job.entity_id).toBe(entity.id);
    expect(data.logs).toBeInstanceOf(Array);
  });

  test("GET /knowledge/jobs/:id returns 404 for nonexistent", async () => {
    const { response } = await getJson("/knowledge/jobs/nonexistent", adminApiKey);
    expect(response.status).toBe(404);
  });
});

describe("Knowledge Permissions", () => {
  test("non-admin can trigger ingest", async () => {
    const entity = await createEntity(adminApiKey, "document", {
      label: "User Ingest Test",
    });

    const { response, body } = await jsonRequest("/knowledge/ingest", {
      method: "POST",
      apiKey: userActor.apiKey,
      json: { entity_ids: [entity.id] },
    });
    expect(response.status).toBe(200);
    expect((body as any).jobs[0].status).toBe("queued");
  });

  test("non-admin can only see own jobs", async () => {
    // Create a job as admin
    const adminEntity = await createEntity(adminApiKey, "document", {
      label: "Admin Only Doc",
    });
    await jsonRequest("/knowledge/ingest", {
      method: "POST",
      apiKey: adminApiKey,
      json: { entity_ids: [adminEntity.id] },
    });

    // User should only see their own jobs
    const { body } = await getJson("/knowledge/jobs", userActor.apiKey);
    const data = body as { jobs: any[] };
    for (const job of data.jobs) {
      expect(job.triggered_by).toBe(userActor.id);
    }
  });

  test("non-admin cannot view another actor's job detail", async () => {
    // Get an admin-triggered job
    const { body: adminJobs } = await getJson("/knowledge/jobs?limit=1", adminApiKey);
    const adminJob = (adminJobs as any).jobs.find((j: any) => j.triggered_by !== userActor.id);
    if (!adminJob) {
      console.warn("Skipped: no admin-only jobs available for this test");
      return;
    }

    const { response } = await getJson(`/knowledge/jobs/${adminJob.id}`, userActor.apiKey);
    expect(response.status).toBe(403);
  });

  test("non-admin can view own job detail", async () => {
    const { body: userJobs } = await getJson("/knowledge/jobs?limit=1", userActor.apiKey);
    const jobs = (userJobs as any).jobs;
    if (jobs.length === 0) {
      console.warn("Skipped: no user jobs available for this test");
      return;
    }

    const { response } = await getJson(`/knowledge/jobs/${jobs[0].id}`, userActor.apiKey);
    expect(response.status).toBe(200);
  });

  test("non-admin cannot view usage", async () => {
    const { response } = await getJson("/knowledge/usage", userActor.apiKey);
    expect(response.status).toBe(403);
  });
});

describe("Knowledge Usage", () => {
  test("GET /knowledge/usage returns usage summary", async () => {
    const { response, body } = await getJson("/knowledge/usage", adminApiKey);
    expect(response.status).toBe(200);
    const data = body as { totals: any; by_model: any };
    expect(data.totals).toBeDefined();
    expect(typeof data.totals.calls).toBe("number");
    expect(typeof data.totals.tokens_in).toBe("number");
    expect(typeof data.totals.tokens_out).toBe("number");
  });
});

describe("Knowledge Poller", () => {
  test("uploading content to an entity should auto-create a job via poller", async () => {
    // Create entity
    const entity = await createEntity(adminApiKey, "document", {
      label: "Poller Test Document",
    });

    // Upload text content to trigger the poller
    await uploadDirectContent(
      adminApiKey,
      entity.id,
      "original",
      entity.ver,
      "This is a test document with some text content for the knowledge extraction pipeline to process.",
      "test.txt",
    );

    // Wait for the poller to pick it up. The poller drains its full backlog
    // per cycle, but in CI the test suite generates ~200 activity events that
    // must be processed first. Give it 60s to be safe under load.
    let found = false;
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const { body } = await getJson(`/knowledge/jobs?entity_id=${entity.id}`, adminApiKey);
      const data = body as { jobs: any[] };
      // Find the ingest job (not child jobs)
      const ingestJob = data.jobs.find((j: any) => j.job_type === "ingest" && j.trigger === "poller");
      if (ingestJob) {
        found = true;
        break;
      }
    }

    expect(found).toBe(true);
  });
});
