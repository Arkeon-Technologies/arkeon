import { describe, expect, test } from "vitest";
import {
  adminApiKey,
  createActor,
  createWorker,
  getJson,
  grantWorkerPermission,
  jsonRequest,
} from "./helpers";

/**
 * Wait for a batch to reach a terminal state (completed or failed).
 * Polls GET /workers/batch/{batchId} until no items are queued/running.
 */
async function waitForBatch(
  batchId: string,
  apiKey: string,
  { maxAttempts = 30, delayMs = 500 } = {},
): Promise<Record<string, any>> {
  for (let i = 0; i < maxAttempts; i++) {
    const { body } = await getJson(`/workers/batch/${batchId}`, apiKey);
    const data = body as Record<string, any>;
    if (data.status === "completed" || data.status === "failed") {
      return data;
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  // Return whatever we have after timeout
  const { body } = await getJson(`/workers/batch/${batchId}`, apiKey);
  return body as Record<string, any>;
}

describe("Worker Batch Invocations", () => {
  // --- Submit & basic structure ---

  test("Submit batch returns 202 with batch_id and invocation list", async () => {
    const workerA = await createWorker(adminApiKey);
    const workerB = await createWorker(adminApiKey);

    const { response, body } = await jsonRequest("/workers/invoke-batch", {
      method: "POST",
      apiKey: adminApiKey,
      json: {
        items: [
          { worker_id: workerA.id, prompt: "step 1" },
          { worker_id: workerB.id, prompt: "step 2" },
          { worker_id: workerA.id, prompt: "step 3" },
        ],
        on_fail: "continue",
      },
    });

    expect(response.status).toBe(202);
    const data = body as Record<string, any>;
    expect(data.batch_id).toBeTruthy();
    expect(data.on_fail).toBe("continue");
    expect(data.invocations).toHaveLength(3);

    // Verify sequence numbers and worker IDs
    expect(data.invocations[0].batch_seq).toBe(0);
    expect(data.invocations[0].worker_id).toBe(workerA.id);
    expect(data.invocations[0].status).toBe("queued");
    expect(data.invocations[1].batch_seq).toBe(1);
    expect(data.invocations[1].worker_id).toBe(workerB.id);
    expect(data.invocations[2].batch_seq).toBe(2);
    expect(data.invocations[2].worker_id).toBe(workerA.id);

    // All invocation IDs should be unique
    const ids = data.invocations.map((i: any) => i.invocation_id);
    expect(new Set(ids).size).toBe(3);
  });

  test("Empty items array returns 400", async () => {
    const { response, body } = await jsonRequest("/workers/invoke-batch", {
      method: "POST",
      apiKey: adminApiKey,
      json: { items: [] },
    });
    expect(response.status).toBe(400);
  });

  test("Single-item batch works", async () => {
    const worker = await createWorker(adminApiKey);
    const { response, body } = await jsonRequest("/workers/invoke-batch", {
      method: "POST",
      apiKey: adminApiKey,
      json: {
        items: [{ worker_id: worker.id, prompt: "solo" }],
      },
    });
    expect(response.status).toBe(202);
    const data = body as Record<string, any>;
    expect(data.invocations).toHaveLength(1);
    expect(data.on_fail).toBe("continue"); // default
  });

  // --- Sequential execution ---

  test("Batch items execute sequentially (each completes before next starts)", async () => {
    const worker = await createWorker(adminApiKey);

    const { body } = await jsonRequest("/workers/invoke-batch", {
      method: "POST",
      apiKey: adminApiKey,
      json: {
        items: [
          { worker_id: worker.id, prompt: "seq-1" },
          { worker_id: worker.id, prompt: "seq-2" },
          { worker_id: worker.id, prompt: "seq-3" },
        ],
        on_fail: "continue",
      },
    });
    const data = body as Record<string, any>;

    // Wait for all items to finish
    const batch = await waitForBatch(data.batch_id, adminApiKey);
    const invocations = batch.invocations as Array<Record<string, any>>;

    // All 3 should have run (workers have fake LLM so they fail fast, but they run)
    expect(invocations).toHaveLength(3);
    for (const inv of invocations) {
      expect(["completed", "failed"]).toContain(inv.status);
      expect(inv.started_at).toBeTruthy();
      expect(inv.completed_at).toBeTruthy();
    }

    // Verify sequential ordering: each item started after the previous completed
    for (let i = 1; i < invocations.length; i++) {
      const prevCompleted = new Date(invocations[i - 1].completed_at).getTime();
      const currStarted = new Date(invocations[i].started_at).getTime();
      expect(currStarted).toBeGreaterThanOrEqual(prevCompleted);
    }
  });

  // --- on_fail: continue ---

  test("on_fail=continue: subsequent items run even after failure", async () => {
    const worker = await createWorker(adminApiKey);

    const { body } = await jsonRequest("/workers/invoke-batch", {
      method: "POST",
      apiKey: adminApiKey,
      json: {
        items: [
          { worker_id: worker.id, prompt: "will-fail-1" },
          { worker_id: worker.id, prompt: "will-fail-2" },
          { worker_id: worker.id, prompt: "will-fail-3" },
        ],
        on_fail: "continue",
      },
    });
    const data = body as Record<string, any>;

    const batch = await waitForBatch(data.batch_id, adminApiKey);
    const invocations = batch.invocations as Array<Record<string, any>>;

    // All 3 should have executed (all will fail due to fake LLM)
    expect(invocations).toHaveLength(3);
    for (const inv of invocations) {
      expect(["completed", "failed"]).toContain(inv.status);
      expect(inv.started_at).toBeTruthy();
    }
  });

  // --- on_fail: cancel ---

  test("on_fail=cancel: remaining items are cancelled after failure", async () => {
    const worker = await createWorker(adminApiKey);

    const { body } = await jsonRequest("/workers/invoke-batch", {
      method: "POST",
      apiKey: adminApiKey,
      json: {
        items: [
          { worker_id: worker.id, prompt: "cancel-1" },
          { worker_id: worker.id, prompt: "cancel-2" },
          { worker_id: worker.id, prompt: "cancel-3" },
        ],
        on_fail: "cancel",
      },
    });
    const data = body as Record<string, any>;

    // Wait for batch to settle (first item fails, rest get cancelled)
    const batch = await waitForBatch(data.batch_id, adminApiKey);
    const invocations = batch.invocations as Array<Record<string, any>>;
    expect(invocations).toHaveLength(3);

    // First item should have run (and failed due to fake LLM)
    expect(invocations[0].status).toBe("failed");
    expect(invocations[0].started_at).toBeTruthy();

    // Remaining items should be cancelled (never started)
    expect(invocations[1].status).toBe("cancelled");
    expect(invocations[1].started_at).toBeNull();
    expect(invocations[2].status).toBe("cancelled");
    expect(invocations[2].started_at).toBeNull();
  });

  // --- Batch polling ---

  test("GET /workers/batch/{batchId} returns progress and derived status", async () => {
    const worker = await createWorker(adminApiKey);

    const { body } = await jsonRequest("/workers/invoke-batch", {
      method: "POST",
      apiKey: adminApiKey,
      json: {
        items: [
          { worker_id: worker.id, prompt: "poll-1" },
          { worker_id: worker.id, prompt: "poll-2" },
        ],
      },
    });
    const data = body as Record<string, any>;

    // Poll immediately — should be queued or running
    const { response: pollResp, body: pollBody } = await getJson(
      `/workers/batch/${data.batch_id}`,
      adminApiKey,
    );
    expect(pollResp.status).toBe(200);
    const poll = pollBody as Record<string, any>;
    expect(poll.batch_id).toBe(data.batch_id);
    expect(poll.progress).toBeTruthy();
    expect(poll.progress.total).toBe(2);
    expect(["queued", "running"]).toContain(poll.status);

    // Wait for completion
    const final = await waitForBatch(data.batch_id, adminApiKey);
    expect(final.progress.total).toBe(2);
    expect(["completed", "failed"]).toContain(final.status);
    // All items should have a terminal status
    expect(final.progress.queued).toBe(0);
    expect(final.progress.running).toBe(0);
  });

  test("GET /workers/batch/{batchId} with invalid ID returns 404", async () => {
    const { response } = await getJson("/workers/batch/NONEXISTENT", adminApiKey);
    expect(response.status).toBe(404);
  });

  // --- Individual invocation polling shows batch fields ---

  test("Individual invocation includes batch_id and batch_seq", async () => {
    const worker = await createWorker(adminApiKey);

    const { body } = await jsonRequest("/workers/invoke-batch", {
      method: "POST",
      apiKey: adminApiKey,
      json: {
        items: [
          { worker_id: worker.id, prompt: "field-check-1" },
          { worker_id: worker.id, prompt: "field-check-2" },
        ],
      },
    });
    const data = body as Record<string, any>;
    const invId = data.invocations[1].invocation_id;

    // Wait a moment for DB records to be created
    await new Promise((r) => setTimeout(r, 200));

    const { response, body: invBody } = await getJson(
      `/workers/invocations/${invId}`,
      adminApiKey,
    );
    expect(response.status).toBe(200);
    const inv = invBody as Record<string, any>;
    expect(inv.batch_id).toBe(data.batch_id);
    expect(inv.batch_seq).toBe(1);
  });

  // --- Cross-worker batches ---

  test("Batch can invoke different workers in sequence", async () => {
    const workerA = await createWorker(adminApiKey, { name: "batch-cross-a" });
    const workerB = await createWorker(adminApiKey, { name: "batch-cross-b" });

    const { response, body } = await jsonRequest("/workers/invoke-batch", {
      method: "POST",
      apiKey: adminApiKey,
      json: {
        items: [
          { worker_id: workerA.id, prompt: "cross-1" },
          { worker_id: workerB.id, prompt: "cross-2" },
        ],
        on_fail: "continue",
      },
    });
    expect(response.status).toBe(202);
    const data = body as Record<string, any>;

    const batch = await waitForBatch(data.batch_id, adminApiKey);
    const invocations = batch.invocations as Array<Record<string, any>>;

    // Both should have run
    expect(invocations).toHaveLength(2);
    expect(invocations[0].worker_id).toBe(workerA.id);
    expect(invocations[1].worker_id).toBe(workerB.id);
    for (const inv of invocations) {
      expect(["completed", "failed"]).toContain(inv.status);
    }
  });

  // --- Permission checks ---

  test("Batch fails if caller lacks permission on any worker", async () => {
    const workerA = await createWorker(adminApiKey);
    const workerB = await createWorker(adminApiKey);
    const other = await createActor(adminApiKey);

    // Grant permission on workerA but not workerB
    await grantWorkerPermission(adminApiKey, workerA.id, "actor", other.id);

    const { response } = await jsonRequest("/workers/invoke-batch", {
      method: "POST",
      apiKey: other.apiKey,
      json: {
        items: [
          { worker_id: workerA.id, prompt: "has-perm" },
          { worker_id: workerB.id, prompt: "no-perm" },
        ],
      },
    });
    expect(response.status).toBe(403);
  });

  test("Batch succeeds when caller has permission on all workers", async () => {
    const workerA = await createWorker(adminApiKey);
    const workerB = await createWorker(adminApiKey);
    const invoker = await createActor(adminApiKey);

    await grantWorkerPermission(adminApiKey, workerA.id, "actor", invoker.id);
    await grantWorkerPermission(adminApiKey, workerB.id, "actor", invoker.id);

    const { response, body } = await jsonRequest("/workers/invoke-batch", {
      method: "POST",
      apiKey: invoker.apiKey,
      json: {
        items: [
          { worker_id: workerA.id, prompt: "perm-ok-1" },
          { worker_id: workerB.id, prompt: "perm-ok-2" },
        ],
      },
    });
    expect(response.status).toBe(202);
    const data = body as Record<string, any>;
    expect(data.invocations).toHaveLength(2);
  });

  test("Batch with nonexistent worker returns error", async () => {
    const worker = await createWorker(adminApiKey);
    const { response } = await jsonRequest("/workers/invoke-batch", {
      method: "POST",
      apiKey: adminApiKey,
      json: {
        items: [
          { worker_id: worker.id, prompt: "ok" },
          { worker_id: "01NONEXISTENT0000000000000", prompt: "missing" },
        ],
      },
    });
    expect([400, 404]).toContain(response.status);
  });

  // --- Unauthenticated ---

  test("Batch without auth returns error", async () => {
    const { response } = await jsonRequest("/workers/invoke-batch", {
      method: "POST",
      json: {
        items: [{ worker_id: "01FAKE", prompt: "no auth" }],
      },
    });
    expect([400, 401]).toContain(response.status);
  });
});
