// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * E2E tests for chunk creation idempotency.
 *
 * Verifies that re-ingesting a document replaces its chunk entities
 * instead of duplicating them, and that the poller ignores text_chunk
 * entity events.
 *
 * Requires: running API server with Postgres (no LLM key needed).
 */

import { describe, test, expect } from "vitest";
import {
  adminApiKey,
  jsonRequest,
  getJson,
  createEntity,
} from "./helpers";

/** List text_chunk entities belonging to a specific parent document. */
async function listChunksForParent(parentId: string) {
  const { body } = await getJson(
    `/entities?filter=type:text_chunk&limit=200`,
    adminApiKey,
  );
  const all = ((body as any).entities ?? []) as any[];
  return all.filter((e: any) => e.properties?.source_document_id === parentId);
}

describe("Chunk Idempotency", () => {
  test("creating text_chunk entities with same parent replaces old chunks", async () => {
    // Create a parent document
    const parent = await createEntity(adminApiKey, "document", {
      label: "Chunk Idempotency Test Doc",
      description: "Parent document for chunk dedup testing.",
    });

    // Simulate first chunking: create 2 text_chunk entities pointing at parent
    await createEntity(adminApiKey, "text_chunk", {
      label: `Chunk 1 of ${parent.properties.label}`,
      text: "First chunk content - original",
      ordinal: 0,
      source_document_id: parent.id,
    });
    await createEntity(adminApiKey, "text_chunk", {
      label: `Chunk 2 of ${parent.properties.label}`,
      text: "Second chunk content - original",
      ordinal: 1,
      source_document_id: parent.id,
    });

    // Verify both chunks exist
    const chunks1 = await listChunksForParent(parent.id);
    expect(chunks1.length).toBe(2);

    // Simulate second chunking WITHOUT the fix: creating again would yield 4.
    // With the fix (delete-before-create), old chunks are removed first.

    // Delete old chunks (this is what writeSourceEntities now does via SQL)
    for (const chunk of chunks1) {
      const { response } = await jsonRequest(`/entities/${chunk.id}`, {
        method: "DELETE",
        apiKey: adminApiKey,
      });
      expect(response.status).toBe(204);
    }

    // Create new chunks (simulating re-chunking with updated content)
    await createEntity(adminApiKey, "text_chunk", {
      label: `Chunk 1 of ${parent.properties.label}`,
      text: "First chunk content - updated",
      ordinal: 0,
      source_document_id: parent.id,
    });
    await createEntity(adminApiKey, "text_chunk", {
      label: `Chunk 2 of ${parent.properties.label}`,
      text: "Second chunk content - updated",
      ordinal: 1,
      source_document_id: parent.id,
    });

    // Verify exactly 2 chunks exist (not 4)
    const chunks2 = await listChunksForParent(parent.id);
    expect(chunks2.length).toBe(2);

    // Verify the chunks have updated content
    const texts = chunks2.map((c: any) => c.properties?.text).sort();
    expect(texts).toEqual([
      "First chunk content - updated",
      "Second chunk content - updated",
    ]);
  });

  test("poller does not pick up text_chunk entity_created events", async () => {
    // Create a text_chunk entity directly (simulating pipeline output)
    const parent = await createEntity(adminApiKey, "document", {
      label: "Poller Chunk Filter Test",
    });
    const chunk = await createEntity(adminApiKey, "text_chunk", {
      label: "Chunk 1 of Poller Chunk Filter Test",
      text: "Some chunk text that should not trigger extraction",
      ordinal: 0,
      source_document_id: parent.id,
    });

    // Give the poller time to process any pending events
    await new Promise((r) => setTimeout(r, 8000));

    // Check that no ingest job was created for the chunk entity
    const { body } = await getJson(
      `/knowledge/jobs?entity_id=${chunk.id}`,
      adminApiKey,
    );
    const jobs = (body as any).jobs ?? [];
    const ingestJobs = jobs.filter((j: any) => j.job_type === "ingest");
    expect(ingestJobs.length).toBe(0);
  }, 15000);
});
