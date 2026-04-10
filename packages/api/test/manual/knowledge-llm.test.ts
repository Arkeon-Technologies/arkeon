/**
 * Manual test: knowledge extraction permission inheritance.
 *
 * Requires a real LLM API key — not run in CI.
 * Run with: npm run test:knowledge-llm
 *
 * Tests that extracted entities inherit read_level, write_level,
 * owner_id, and permission grants from the source document.
 */

import { describe, test, expect, beforeAll } from "vitest";
import {
  adminApiKey,
  jsonRequest,
  getJson,
  apiRequest,
  createActor,
  createEntity,
  createSpace,
  addEntityToSpace,
  grantEntityPermission,
  type CreatedActor,
} from "../e2e/helpers";

let ownerActor: CreatedActor;
let editorActor: CreatedActor;
let viewerActor: CreatedActor;

beforeAll(async () => {
  // Create actors at different clearance levels
  ownerActor = await createActor(adminApiKey, {
    maxReadLevel: 3,
    maxWriteLevel: 3,
    properties: { label: "doc-owner" },
  });
  editorActor = await createActor(adminApiKey, {
    maxReadLevel: 2,
    maxWriteLevel: 2,
    properties: { label: "doc-editor" },
  });
  viewerActor = await createActor(adminApiKey, {
    maxReadLevel: 1,
    maxWriteLevel: 1,
    properties: { label: "viewer-only" },
  });

  // Configure LLM for minimal extraction
  await jsonRequest("/knowledge/config", {
    method: "PUT",
    apiKey: adminApiKey,
    json: {
      llm: {
        default: {
          provider: "openai",
          base_url: "https://api.openai.com/v1",
          api_key: process.env.OPENAI_API_KEY!,
          model: "gpt-4.1-nano",
          max_tokens: 4096,
        },
      },
    },
  });
});

async function waitForJob(jobId: string, timeoutMs = 60000): Promise<any> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { body } = await getJson(`/knowledge/jobs/${jobId}`, adminApiKey);
    const job = (body as any).job;
    if (job.status === "completed" || job.status === "failed") return job;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Job ${jobId} timed out`);
}

async function waitForIngestComplete(entityId: string, timeoutMs = 60000): Promise<any> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { body } = await getJson(`/knowledge/jobs?entity_id=${entityId}`, adminApiKey);
    const jobs = (body as any).jobs;
    const ingest = jobs.find((j: any) => j.job_type === "ingest");
    if (ingest && (ingest.status === "completed" || ingest.status === "failed")) return ingest;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Ingest for ${entityId} timed out`);
}

describe("Knowledge Permission Inheritance", () => {
  beforeAll(() => {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY env var required for LLM tests");
    }
  });
  let sourceEntityId: string;
  let extractedEntityIds: string[];

  test("setup: create document with owner, editor, and read_level=2", async () => {
    // Owner creates a document at read_level=2
    const entity = await createEntity(ownerActor.apiKey, "document", {
      label: "Classified Report",
      description: "Alice works at Globex Corporation. Bob manages the Tokyo office. Alice reports to Bob.",
    }, { read_level: 2, write_level: 2 });

    sourceEntityId = entity.id;

    // Grant editor access to editorActor
    await grantEntityPermission(ownerActor.apiKey, sourceEntityId, "actor", editorActor.id, "editor");

    // Verify setup
    const { body } = await getJson(`/entities/${sourceEntityId}/permissions`, ownerActor.apiKey);
    const perms = body as any;
    expect(perms.owner_id).toBe(ownerActor.id);
    expect(perms.permissions).toContainEqual(
      expect.objectContaining({ grantee_id: editorActor.id, role: "editor" }),
    );
  });

  test("trigger extraction and wait for completion", async () => {
    const { response, body } = await jsonRequest("/knowledge/ingest", {
      method: "POST",
      apiKey: ownerActor.apiKey,
      json: { entity_ids: [sourceEntityId] },
    });
    expect(response.status).toBe(200);

    const ingest = await waitForIngestComplete(sourceEntityId);
    expect(ingest.status).toBe("completed");

    // Collect created entity IDs from the child job results
    const { body: jobsBody } = await getJson(`/knowledge/jobs?entity_id=${sourceEntityId}`, adminApiKey);
    const jobs = (jobsBody as any).jobs;
    extractedEntityIds = [];
    for (const job of jobs) {
      const result = job.result;
      if (result?.createdEntities > 0 || result?.documentId) {
        // The text.extract job has the actual entity IDs in its writeResult
        // We'll find them by searching for entities with source_document_id
      }
    }

    // Wait for Meilisearch indexing
    await new Promise((r) => setTimeout(r, 2000));

    // Find extracted entities by searching and filtering to source_document_id
    const { body: searchBody } = await getJson(
      `/search?q=Alice+Bob+Globex+Tokyo&limit=20`,
      adminApiKey,
    );
    const results = (searchBody as any).results ?? [];
    extractedEntityIds = results
      .filter((r: any) => r.type !== "document" && r.type !== "text_chunk"
        && r.properties?.source_document_id === sourceEntityId)
      .map((r: any) => r.id);

    expect(extractedEntityIds.length).toBeGreaterThan(0);
  });

  test("extracted entities inherit read_level from source", async () => {
    for (const eid of extractedEntityIds) {
      const { body } = await getJson(`/entities/${eid}`, adminApiKey);
      const entity = (body as any).entity;
      expect(entity.read_level).toBe(2);
    }
  });

  test("extracted entities inherit write_level from source", async () => {
    for (const eid of extractedEntityIds) {
      const { body } = await getJson(`/entities/${eid}`, adminApiKey);
      const entity = (body as any).entity;
      expect(entity.write_level).toBe(2);
    }
  });

  test("extracted entities are owned by the source document's owner", async () => {
    for (const eid of extractedEntityIds) {
      const { body } = await getJson(`/entities/${eid}`, adminApiKey);
      const entity = (body as any).entity;
      expect(entity.owner_id).toBe(ownerActor.id);
    }
  });

  test("extracted entities have editor grant copied from source", async () => {
    for (const eid of extractedEntityIds) {
      const { body } = await getJson(`/entities/${eid}/permissions`, adminApiKey);
      const perms = (body as any).permissions ?? [];
      const editorGrant = perms.find((p: any) => p.grantee_id === editorActor.id);
      expect(editorGrant).toBeDefined();
      expect(editorGrant.role).toBe("editor");
    }
  });

  test("owner can read extracted entities", async () => {
    for (const eid of extractedEntityIds) {
      const { response } = await getJson(`/entities/${eid}`, ownerActor.apiKey);
      expect(response.status).toBe(200);
    }
  });

  test("editor can read extracted entities", async () => {
    for (const eid of extractedEntityIds) {
      const { response } = await getJson(`/entities/${eid}`, editorActor.apiKey);
      expect(response.status).toBe(200);
    }
  });

  test("extracted entities have correct read_level set (RLS enforced in production)", async () => {
    // In local dev, RLS is bypassed because the DB user owns the tables.
    // In production (arke_app role), max_read_level=1 actors cannot read read_level=2 entities.
    // Here we just verify the level is correctly set.
    for (const eid of extractedEntityIds) {
      const { body } = await getJson(`/entities/${eid}`, adminApiKey);
      expect((body as any).entity.read_level).toBe(2);
    }
  });

  test("space_ids returned on entity GET", async () => {
    const { body } = await getJson(`/entities/${sourceEntityId}`, ownerActor.apiKey);
    const entity = (body as any).entity;
    expect(entity).toHaveProperty("space_ids");
    expect(entity.space_ids).toBeInstanceOf(Array);
  });
});
