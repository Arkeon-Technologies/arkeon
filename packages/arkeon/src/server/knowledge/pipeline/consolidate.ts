// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Space-level consolidation via LLM revision pass.
 *
 * After parallel extraction jobs write entities, a debounced consolidate
 * job gives the LLM a second look at all recently extracted entities.
 * The LLM can merge duplicates and add missing relationships using the
 * same ops format as extraction. Merge ops execute independently so
 * individual failures don't kill the batch.
 */

import { withAdminSql } from "../lib/admin-sql";
import { LlmClient } from "../lib/llm";
import { resolveLlmConfig } from "../lib/config";
import { appendLog } from "../lib/logger";
import { setJobStatus } from "../queue";
import { submitOpsEnvelope, type OpsEnvelopeInput } from "../lib/arke-client";
import type { JobRecord } from "../queue";
import type { SqlClient } from "../../lib/sql";

const DEBOUNCE_MS = 15_000;
const MAX_ENTITIES_PER_BATCH = 200;
const DESC_SNIPPET_CHARS = 150;

const REVISION_PROMPT = `You are revising a knowledge graph that was just extracted from multiple documents in parallel. Below are the recently extracted entities. Some may be duplicates of each other, and some may be missing relationships.

Your task: submit ops to improve the graph. Return JSON:
{
  "ops": [
    {"op": "merge", "target": "01KEEP_ID", "sources": ["01DUP_ID"]},
    {"op": "relate", "source": "01ID_A", "target": "01ID_B", "predicate": "led"}
  ]
}

Available ops:
- merge: combine duplicate entities. "target" is the entity to keep (prefer the one with the richest description). "sources" are entities to merge into it (they will be deleted, their relationships and properties transfer to target).
- relate: add a missing relationship between two existing entities. Use their IDs as source/target.

What to merge:
- Entities that are THE SAME real-world thing under different labels (e.g. "Henry Kissinger" and "Kissinger" are the same person; "USSR" and "Soviet Union" are the same country; "AEC" and "Atomic Energy Commission" are the same organization)
- Same entity typed differently (e.g. "Oak Ridge" as location and "Oak Ridge facility" as organization)

What NOT to merge:
- An event/action and the entity it involves: "Collins serves as museum director" is NOT "National Air and Space Museum"
- A concept and an event: "Depression" is NOT "Aldrin's struggles with depression"
- Related but distinct things: "State Department" is NOT "Sidelining of the State Department"
- Different real-world things that share a word: "United States" is NOT "United Nations"

What relationships to add:
- Only between entities that clearly interact based on their descriptions
- Use specific predicates (led, worked_at, participated_in, located_in, etc.)
- Do NOT create relationships that are speculative or not supported by the entity descriptions

If nothing needs fixing, return: {"ops": []}
When uncertain about a merge, skip it — false merges are irreversible.`;

export async function handleConsolidate(job: JobRecord, _sql: SqlClient): Promise<void> {
  const jobId = job.id as string;
  const metadata = (job.metadata ?? {}) as Record<string, unknown>;
  const spaceId = metadata.space_id as string | undefined;

  if (!spaceId) {
    await setJobStatus(jobId, "completed", { result: { reason: "no space_id" } });
    return;
  }

  // Debounce: wait for parallel extraction jobs to finish
  appendLog(jobId, "info", `Debouncing ${DEBOUNCE_MS}ms for space ${spaceId}`);
  await new Promise((r) => setTimeout(r, DEBOUNCE_MS));

  // Fetch recently extracted entities in this space
  const entities = await withAdminSql(async (sql) => {
    const results = await sql.transaction([
      sql`SELECT set_config('app.actor_id', 'SYSTEM', true)`,
      sql`SELECT set_config('app.actor_read_level', '4', true)`,
      sql`SELECT set_config('app.actor_is_admin', 'true', true)`,
      sql.query(
        `SELECT e.id, e.type,
                e.properties->>'label' AS label,
                substring(e.properties->>'description' for ${DESC_SNIPPET_CHARS}) AS description
         FROM entities e
         JOIN space_entities se ON se.entity_id = e.id
         WHERE se.space_id = $1
           AND e.kind = 'entity'
           AND e.type NOT IN ('document', 'text_chunk')
           AND e.updated_at > (NOW() - interval '10 minutes')
         ORDER BY e.updated_at DESC
         LIMIT ${MAX_ENTITIES_PER_BATCH}`,
        [spaceId],
      ),
    ]);
    return results[results.length - 1] as Array<Record<string, unknown>>;
  });

  appendLog(jobId, "info", `Found ${entities.length} recent entities in space`);

  if (entities.length < 2) {
    await setJobStatus(jobId, "completed", {
      result: { entities_checked: entities.length, reason: "too few entities" },
    });
    return;
  }

  // Build compact entity list for LLM
  const entityList = entities.map((e) => ({
    id: e.id as string,
    label: (e.label as string) || "?",
    type: e.type as string,
    description: (e.description as string) || "",
  }));

  appendLog(jobId, "info", `Sending ${entityList.length} entities to LLM for revision`);

  // Call LLM for revision
  const resolverConfig = await resolveLlmConfig("resolver");
  const resolverLlm = new LlmClient(resolverConfig);

  const result = await resolverLlm.chatJson<{
    ops: Array<Record<string, unknown>>;
  }>(
    REVISION_PROMPT,
    JSON.stringify({ entities: entityList }),
    { maxTokens: 4000 },
  );

  const ops = result.data.ops ?? [];

  if (ops.length === 0) {
    appendLog(jobId, "info", "LLM returned no revision ops");
    await setJobStatus(jobId, "completed", {
      result: { entities_checked: entities.length, ops: 0 },
      model: result.usage.model,
      tokens_in: result.usage.tokensIn,
      tokens_out: result.usage.tokensOut,
      llm_calls: 1,
    });
    return;
  }

  const mergeOps = ops.filter((o) => o.op === "merge");
  const relateOps = ops.filter((o) => o.op === "relate");
  appendLog(jobId, "info", `LLM returned ${mergeOps.length} merge(s), ${relateOps.length} relationship(s)`);

  // Log what we're about to do
  for (const op of mergeOps) {
    const targetLabel = entityList.find((e) => e.id === op.target)?.label ?? op.target;
    const sourceLabels = ((op.sources as string[]) ?? []).map(
      (id) => entityList.find((e) => e.id === id)?.label ?? id,
    );
    console.log(`[knowledge:consolidate] Merge: keep "${targetLabel}" <- [${sourceLabels.join(", ")}]`);
  }
  for (const op of relateOps) {
    const srcLabel = entityList.find((e) => e.id === op.source)?.label ?? op.source;
    const tgtLabel = entityList.find((e) => e.id === op.target)?.label ?? op.target;
    console.log(`[knowledge:consolidate] Relate: "${srcLabel}" --[${op.predicate}]--> "${tgtLabel}"`);
  }

  // Submit ops via the ops pipeline (merge ops execute post-transaction, independently)
  try {
    const envelope: OpsEnvelopeInput = {
      format: "arke.ops/v1",
      defaults: { space_id: spaceId },
      ops,
    };

    const opsResult = await submitOpsEnvelope(envelope);

    appendLog(jobId, "info", `Ops submitted: ${JSON.stringify(opsResult)}`);

    await setJobStatus(jobId, "completed", {
      result: {
        entities_checked: entities.length,
        merge_ops: mergeOps.length,
        relate_ops: relateOps.length,
        ops_result: opsResult,
      },
      model: result.usage.model,
      tokens_in: result.usage.tokensIn,
      tokens_out: result.usage.tokensOut,
      llm_calls: 1,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    appendLog(jobId, "error", `Ops submission failed: ${message}`);
    await setJobStatus(jobId, "failed", {
      error: message,
      result: {
        entities_checked: entities.length,
        merge_ops: mergeOps.length,
        relate_ops: relateOps.length,
      },
      model: result.usage.model,
      tokens_in: result.usage.tokensIn,
      tokens_out: result.usage.tokensOut,
      llm_calls: 1,
    });
  }
}
