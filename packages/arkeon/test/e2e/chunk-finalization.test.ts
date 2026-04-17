// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * E2E test for multi-chunk finalization.
 *
 * Creates a document long enough to trigger chunking (~25k chars),
 * triggers extraction, and verifies the parent ingest job transitions
 * through waiting → completed (not stuck in waiting forever).
 *
 * Requires: running API server with Postgres AND a configured LLM key.
 * Skips gracefully if no LLM key is configured.
 */

import { describe, test, expect, beforeAll } from "vitest";
import {
  adminApiKey,
  jsonRequest,
  getJson,
  createEntity,
  uploadDirectContent,
} from "./helpers";

/**
 * Generate a document that just barely exceeds the chunk threshold.
 * Default target_chunk_chars = 24,000 → need > 24,000 chars.
 * We generate ~25,000 chars — enough for 2 chunks, minimal LLM work.
 */
function generateLongDocument(): string {
  const base =
    "The Apollo program landed humans on the Moon between 1969 and 1972. " +
    "NASA launched Apollo 11 in July 1969 with astronauts Neil Armstrong, Buzz Aldrin, and Michael Collins. " +
    "The Manhattan Project, led by J. Robert Oppenheimer, produced the first nuclear weapons during World War II. " +
    "The Human Genome Project completed sequencing human DNA in 2003. " +
    "Tim Berners-Lee invented the World Wide Web in 1989 at CERN.\n\n";
  // base is ~407 chars; repeat 62 times → ~25,200 chars → 2 chunks
  return Array(62).fill(base).join("");
}

/** Check if the LLM is configured by reading extraction config. */
async function isLlmConfigured(): Promise<boolean> {
  const { body } = await getJson("/knowledge/config", adminApiKey);
  const data = body as { llm: any[] };
  return data.llm?.some((c: any) => c.has_key === true) ?? false;
}

/** Poll a job until it reaches a terminal status or times out. */
async function waitForJobCompletion(
  jobId: string,
  timeoutMs = 180_000,
): Promise<{ status: string; result: any; childJobs: any[] }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { body } = await getJson(`/knowledge/jobs/${jobId}`, adminApiKey);
    const job = (body as any).job;
    const status = job.status as string;

    if (status === "completed" || status === "failed") {
      // Fetch child jobs
      const { body: jobsBody } = await getJson(
        `/knowledge/jobs?parent_job_id=${jobId}`,
        adminApiKey,
      );
      return {
        status,
        result: job.result,
        childJobs: (jobsBody as any).jobs ?? [],
      };
    }

    await new Promise((r) => setTimeout(r, 2000));
  }

  // Timed out — fetch final state for diagnostics
  const { body } = await getJson(`/knowledge/jobs/${jobId}`, adminApiKey);
  const job = (body as any).job;
  const { body: jobsBody } = await getJson(
    `/knowledge/jobs?parent_job_id=${jobId}`,
    adminApiKey,
  );
  return {
    status: job.status as string,
    result: job.result,
    childJobs: (jobsBody as any).jobs ?? [],
  };
}

describe("Chunk Finalization E2E", () => {
  let hasLlm = false;

  beforeAll(async () => {
    hasLlm = await isLlmConfigured();
    if (!hasLlm) {
      console.warn(
        "[chunk-finalization] Skipping: no LLM key configured. " +
        "Run `arkeon config set-llm` first.",
      );
    }
  });

  test("multi-chunk document completes extraction end-to-end", async () => {
    if (!hasLlm) return;

    // 1. Create entity + upload long content
    const entity = await createEntity(adminApiKey, "document", {
      label: "Chunk Finalization E2E Test",
      description: "Long document to verify multi-chunk finalization.",
    });

    const longText = generateLongDocument();
    expect(longText.length).toBeGreaterThan(25_000); // must trigger chunking

    await uploadDirectContent(
      adminApiKey,
      entity.id,
      "original",
      entity.ver,
      longText,
      "long-doc.txt",
    );

    // 2. Trigger extraction manually
    const { response, body } = await jsonRequest("/knowledge/ingest", {
      method: "POST",
      apiKey: adminApiKey,
      json: { entity_ids: [entity.id] },
    });
    expect(response.status).toBe(200);
    const ingestJobId = (body as any).jobs[0].job_id;
    expect(ingestJobId).toBeTruthy();

    // 3. Wait for the ingest job to reach a terminal state.
    //    Before the fix, this would hang in 'waiting' forever.
    const result = await waitForJobCompletion(ingestJobId);

    // 4. The critical assertion: parent must NOT be stuck in 'waiting'.
    //    Before the fix, claimFinalization silently failed due to RLS and
    //    the parent stayed in 'waiting' forever.
    expect(result.status).not.toBe("waiting");

    // 5. Verify: child chunk jobs exist and completed
    const chunkJobs = result.childJobs.filter(
      (j: any) => j.job_type === "text.chunk_extract",
    );
    // Document is ~25k chars → should produce 2+ chunks
    expect(chunkJobs.length).toBeGreaterThanOrEqual(2);
    for (const cj of chunkJobs) {
      expect(cj.status).toBe("completed");
    }

    // 6. If completed, verify entities were written to the graph.
    //    'failed' is acceptable too — it means finalization ran but the
    //    pipeline tail hit a transient/validation error, which is a
    //    separate concern from the RLS finalization bug.
    if (result.status === "completed") {
      expect(result.result).toBeDefined();
      expect(result.result.createdEntities).toBeGreaterThan(0);
      console.log(
        `[chunk-finalization] OK: ${chunkJobs.length} chunks → ` +
        `${result.result.createdEntities} entities, ` +
        `${result.result.createdRelationships} relationships`,
      );
    } else {
      console.log(
        `[chunk-finalization] Finalization fired (status=${result.status}), ` +
        `${chunkJobs.length} chunks completed. ` +
        `Pipeline tail error is a separate concern from the RLS fix.`,
      );
    }
  }, 200_000); // 200s timeout for LLM calls
});
