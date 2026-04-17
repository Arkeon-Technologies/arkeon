// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * E2E test for ingestion idempotency.
 *
 * Uploads a document, waits for extraction to complete, then re-uploads
 * the exact same content. The second extraction should reconnect existing
 * entities via upsert — NOT create duplicates. Entity and relationship
 * counts should stay stable across runs.
 *
 * Requires:
 *   - Running arkeon stack with ENABLE_KNOWLEDGE_PIPELINE=true
 *   - Configured LLM provider (PUT /knowledge/config)
 *   - Real LLM calls — expect ~60-120s runtime
 */

import { describe, expect, test } from "vitest";
import {
  adminApiKey,
  createActor,
  createEntity,
  createSpace,
  getJson,
  jsonRequest,
  uniqueName,
  uploadDirectContent,
} from "./helpers";

const PIPELINE_ENABLED = process.env.ENABLE_KNOWLEDGE_PIPELINE === "true";

// ---------------------------------------------------------------------------
// Test document — short enough to stay in one chunk, rich enough to produce
// a meaningful number of entities and relationships.
// ---------------------------------------------------------------------------

const DOCUMENT_TEXT = `
CONFIDENTIAL — MEMORANDUM 1962-WASH-00317

Subject: Briefing on Cuban Missile Crisis developments

National Security Advisor McGeorge Bundy briefed President John F. Kennedy
on the latest reconnaissance findings over Cuba on October 16, 1962.
The Central Intelligence Agency confirmed the presence of Soviet SS-4
medium-range ballistic missiles at San Cristobal, capable of reaching
Washington, D.C. within minutes of launch.

Secretary of Defense Robert McNamara presented three response options to
the Executive Committee of the National Security Council (ExComm):
a naval blockade, surgical air strikes against the missile sites, or a
full-scale invasion of Cuba.

Attorney General Robert Kennedy argued forcefully against the air strike
option, warning it would be a "Pearl Harbor in reverse" and damage
America's moral standing. Secretary of State Dean Rusk favored the
blockade approach, which he termed a "quarantine" to avoid the legal
implications of an act of war.

The Joint Chiefs of Staff, led by General Maxwell Taylor, unanimously
recommended air strikes followed by invasion. CIA Director John McCone
provided intelligence indicating that Soviet Premier Nikita Khrushchev
might be willing to negotiate if faced with a credible show of force.

Ambassador Adlai Stevenson was instructed to prepare a presentation for
the United Nations Security Council. The Defense Intelligence Agency
confirmed additional missile sites under construction at Sagua la Grande.

President Kennedy authorized the naval quarantine, effective October 24.
The Strategic Air Command was placed on DEFCON 2, the highest alert level
short of nuclear war.
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function waitForEntityExtraction(
  apiKey: string,
  entityId: string,
  timeoutMs = 120_000,
  pollMs = 3_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { body } = await getJson(
      `/knowledge/jobs?entity_id=${entityId}&limit=10`,
      apiKey,
    );
    const jobs = (body as any).jobs as Array<Record<string, unknown>>;
    const topJob = jobs.find(
      (j) => j.job_type === "ingest" && !j.parent_job_id,
    );
    if (topJob && (topJob.status === "completed" || topJob.status === "failed")) {
      return topJob;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`Extraction for entity ${entityId} did not complete within ${timeoutMs}ms`);
}

/** Wait for a *new* ingest job (created after `afterVer`) to complete. */
async function waitForNewExtraction(
  apiKey: string,
  entityId: string,
  afterVer: number,
  timeoutMs = 120_000,
  pollMs = 3_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { body } = await getJson(
      `/knowledge/jobs?entity_id=${entityId}&limit=20`,
      apiKey,
    );
    const jobs = (body as any).jobs as Array<Record<string, unknown>>;
    // Find a completed ingest job for a version higher than the first run
    const newJob = jobs.find(
      (j) =>
        j.job_type === "ingest" &&
        !j.parent_job_id &&
        (j.entity_ver as number) > afterVer &&
        (j.status === "completed" || j.status === "failed"),
    );
    if (newJob) return newJob;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`New extraction for entity ${entityId} (ver > ${afterVer}) did not complete within ${timeoutMs}ms`);
}

async function listSpaceEntities(
  apiKey: string,
  spaceId: string,
  limit = 200,
): Promise<Array<Record<string, unknown>>> {
  const { body } = await getJson(
    `/spaces/${spaceId}/entities?limit=${limit}`,
    apiKey,
  );
  return ((body as any).entities ?? []) as Array<Record<string, unknown>>;
}

async function getEntityRelationships(
  apiKey: string,
  entityId: string,
): Promise<Array<Record<string, unknown>>> {
  const { body } = await getJson(
    `/entities/${entityId}/relationships?limit=200`,
    apiKey,
  );
  return ((body as any).relationships ?? []) as Array<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!PIPELINE_ENABLED)(
  "Ingestion idempotency (e2e)",
  { timeout: 300_000 },
  () => {
    let actor: Awaited<ReturnType<typeof createActor>>;
    let spaceId: string;
    let docId: string;
    let firstVer: number;

    // Snapshots after each extraction run
    let entitiesAfterFirst: Array<Record<string, unknown>>;
    let entitiesAfterSecond: Array<Record<string, unknown>>;
    let relsAfterFirst: Array<Record<string, unknown>>;
    let relsAfterSecond: Array<Record<string, unknown>>;

    // --- Setup ---

    test("setup: create actor and isolated space", async () => {
      actor = await createActor(adminApiKey, {
        maxReadLevel: 3,
        maxWriteLevel: 3,
      });
      const space = await createSpace(actor.apiKey, uniqueName("idempotency-test"));
      spaceId = space.id;
    });

    test("setup: enable scope_to_space", async () => {
      const { response } = await jsonRequest("/knowledge/config", {
        method: "PUT",
        apiKey: adminApiKey,
        json: { extraction: { scope_to_space: true } },
      });
      expect(response.status).toBe(200);
    });

    // --- First ingestion ---

    test("first ingest: upload document and wait for extraction", async () => {
      const entity = await createEntity(actor.apiKey, "document", {
        label: uniqueName("cuban-missile-crisis-memo"),
      }, { space_id: spaceId });
      docId = entity.id;
      firstVer = entity.ver;

      await uploadDirectContent(
        actor.apiKey,
        entity.id,
        "body",
        entity.ver,
        DOCUMENT_TEXT,
        "cuban-missile-crisis-1962.txt",
      );

      const job = await waitForEntityExtraction(adminApiKey, docId);
      expect(job.status).toBe("completed");

      const result = job.result as Record<string, unknown>;
      console.log("[first ingest] result:", JSON.stringify(result, null, 2));
      expect((result.createdEntities as number) ?? 0).toBeGreaterThan(0);
    });

    test("first ingest: snapshot entity and relationship counts", async () => {
      entitiesAfterFirst = await listSpaceEntities(actor.apiKey, spaceId);
      // Exclude the source document, text_chunk, and relationship entities from the count.
      // The space listing returns relationship edges as kind='relationship' — those aren't
      // extracted entities and have no label, so skip them.
      entitiesAfterFirst = entitiesAfterFirst.filter(
        (e) => e.type !== "document" && e.type !== "text_chunk" && e.kind !== "relationship",
      );

      // Gather relationships from all extracted entities
      relsAfterFirst = [];
      for (const entity of entitiesAfterFirst) {
        const rels = await getEntityRelationships(actor.apiKey, entity.id as string);
        relsAfterFirst.push(...rels);
      }

      console.log(`[first ingest] extracted entities: ${entitiesAfterFirst.length}`);
      console.log(`[first ingest] relationships: ${relsAfterFirst.length}`);
      console.log(
        "[first ingest] entity labels:",
        entitiesAfterFirst.map((e) => `${(e.properties as any)?.label} (${e.type})`),
      );

      // Sanity: should have extracted at least a few entities
      expect(entitiesAfterFirst.length).toBeGreaterThanOrEqual(3);
    });

    // --- Second ingestion (same content) ---

    test("second ingest: re-upload identical content and wait for extraction", async () => {
      // Re-fetch entity to get current ver
      const { body } = await getJson(`/entities/${docId}`, actor.apiKey);
      const currentVer = (body as any).entity.ver as number;

      // Re-upload the exact same text — this bumps ver, creating a new ingest job
      await uploadDirectContent(
        actor.apiKey,
        docId,
        "body",
        currentVer,
        DOCUMENT_TEXT,
        "cuban-missile-crisis-1962.txt",
      );

      const job = await waitForNewExtraction(adminApiKey, docId, firstVer);
      expect(job.status).toBe("completed");

      const result = job.result as Record<string, unknown>;
      console.log("[second ingest] result:", JSON.stringify(result, null, 2));
    });

    test("second ingest: snapshot entity and relationship counts", async () => {
      entitiesAfterSecond = await listSpaceEntities(actor.apiKey, spaceId);
      entitiesAfterSecond = entitiesAfterSecond.filter(
        (e) => e.type !== "document" && e.type !== "text_chunk" && e.kind !== "relationship",
      );

      relsAfterSecond = [];
      for (const entity of entitiesAfterSecond) {
        const rels = await getEntityRelationships(actor.apiKey, entity.id as string);
        relsAfterSecond.push(...rels);
      }

      console.log(`[second ingest] extracted entities: ${entitiesAfterSecond.length}`);
      console.log(`[second ingest] relationships: ${relsAfterSecond.length}`);
      console.log(
        "[second ingest] entity labels:",
        entitiesAfterSecond.map((e) => `${(e.properties as any)?.label} (${e.type})`),
      );
    });

    // --- Assertions ---

    test("entity count should be stable after re-ingestion", () => {
      const firstCount = entitiesAfterFirst.length;
      const secondCount = entitiesAfterSecond.length;
      const delta = secondCount - firstCount;

      console.log(`[idempotency] entities: ${firstCount} -> ${secondCount} (delta: ${delta})`);

      // Allow a small tolerance for LLM non-determinism (±2 entities).
      // The key property: re-ingesting should NOT double the count.
      expect(
        Math.abs(delta),
        `Entity count changed by ${delta} (${firstCount} -> ${secondCount}) — expected stable`,
      ).toBeLessThanOrEqual(2);
    });

    test("relationship count should be stable after re-ingestion", () => {
      const firstCount = relsAfterFirst.length;
      const secondCount = relsAfterSecond.length;
      const delta = secondCount - firstCount;

      console.log(`[idempotency] relationships: ${firstCount} -> ${secondCount} (delta: ${delta})`);

      // Relationships are more variable due to LLM extraction, but should
      // not explode. Allow ±5 for non-determinism.
      expect(
        Math.abs(delta),
        `Relationship count changed by ${delta} (${firstCount} -> ${secondCount}) — expected stable`,
      ).toBeLessThanOrEqual(5);
    });

    test("no duplicate entity labels within the same type", () => {
      const seen = new Map<string, number>();
      for (const e of entitiesAfterSecond) {
        const label = ((e.properties as any)?.label ?? "").toLowerCase().trim();
        const type = (e.type as string) ?? "unknown";
        const key = `${type}::${label}`;
        seen.set(key, (seen.get(key) ?? 0) + 1);
      }

      const duplicates = [...seen.entries()].filter(([, count]) => count > 1);
      if (duplicates.length > 0) {
        console.warn(
          "[idempotency] duplicate label+type pairs:",
          duplicates.map(([key, count]) => `${key} (x${count})`),
        );
      }

      // Strict: no exact label+type duplicates should exist after upsert
      expect(
        duplicates.length,
        `Found ${duplicates.length} duplicate label+type pairs: ${duplicates.map(([k]) => k).join(", ")}`,
      ).toBe(0);
    });

    // --- Cleanup ---

    test("cleanup: restore scope_to_space=false", async () => {
      await jsonRequest("/knowledge/config", {
        method: "PUT",
        apiKey: adminApiKey,
        json: { extraction: { scope_to_space: false } },
      });
    });
  },
);
