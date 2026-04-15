// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Space-level batch consolidation handler.
 *
 * After extraction jobs write entities, a debounced consolidate job
 * fetches all recently extracted entities in the space, sends them to
 * the LLM in one batch, and merges duplicates. This replaces the
 * per-entity dedupe with a holistic view of the space.
 */

import { withAdminSql } from "../lib/admin-sql";
import { LlmClient } from "../lib/llm";
import { resolveLlmConfig } from "../lib/config";
import { appendLog } from "../lib/logger";
import { setJobStatus } from "../queue";
import { post } from "../lib/arke-client";
import type { JobRecord } from "../queue";
import type { SqlClient } from "../../lib/sql";

const DEBOUNCE_MS = 15_000;
const MAX_ENTITIES_PER_BATCH = 200;
const DESC_SNIPPET_CHARS = 150;

const CONSOLIDATE_PROMPT = `You are consolidating a knowledge graph. Below are recently extracted entities from multiple documents. Find groups that refer to the same real-world thing and should be merged.

Return JSON:
{
  "merge_groups": [
    {"keep": "01ID_BEST", "merge": ["01ID_DUP1", "01ID_DUP2"], "rationale": "Same person, different name forms"}
  ]
}

Rules:
- Merge when entities clearly refer to the same real-world entity despite different labels (e.g., "J. Robert Oppenheimer" and "Dr. Oppenheimer" are the same person; "University of Manchester" and "Manchester University" are the same organization)
- "keep" should be the entity with the longest/richest description
- Keep SEPARATE when entities are genuinely different (a person vs an organization, a place vs an event, father vs son, "Mercury" the planet vs "Mercury" the element)
- Type is a hint but not absolute -- the same entity may have been typed differently
- If uncertain or descriptions are too sparse to confirm, do NOT merge -- false merges are irreversible and worse than missed merges
- Return an empty merge_groups array if no duplicates are found`;

export async function handleConsolidate(job: JobRecord, _sql: SqlClient): Promise<void> {
  const jobId = job.id as string;
  const metadata = (job.metadata ?? {}) as Record<string, unknown>;
  const spaceId = metadata.space_id as string | undefined;

  if (!spaceId) {
    await setJobStatus(jobId, "completed", { result: { reason: "no space_id" } });
    return;
  }

  // Debounce: wait for more extraction jobs to finish and entities to be indexed
  appendLog(jobId, "info", `Debouncing ${DEBOUNCE_MS}ms for space ${spaceId}`);
  await new Promise((r) => setTimeout(r, DEBOUNCE_MS));

  // Fetch recently extracted entities in this space.
  // Look back from NOW (after debounce) rather than job creation time,
  // since parallel extraction jobs may write entities after this job was created.
  // Must set admin actor context for RLS to allow reading all entities.
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
      result: { entities_checked: entities.length, merged: 0, reason: "too few entities" },
    });
    return;
  }

  // Build compact entity list for LLM
  const entityList = entities.map((e: Record<string, unknown>) => ({
    id: e.id as string,
    label: (e.label as string) || "?",
    type: e.type as string,
    description: (e.description as string) || "",
  }));

  appendLog(jobId, "info", `Sending ${entityList.length} entities to LLM for batch merge analysis`);

  // Call LLM
  const resolverConfig = await resolveLlmConfig("resolver");
  const resolverLlm = new LlmClient(resolverConfig);

  const result = await resolverLlm.chatJson<{
    merge_groups: Array<{ keep: string; merge: string[]; rationale: string }>;
  }>(
    CONSOLIDATE_PROMPT,
    JSON.stringify({ entities: entityList }),
    { maxTokens: 2000 },
  );

  const mergeGroups = result.data.merge_groups ?? [];

  if (mergeGroups.length === 0) {
    appendLog(jobId, "info", "No duplicates found");
    await setJobStatus(jobId, "completed", {
      result: { entities_checked: entities.length, merged: 0 },
      model: result.usage.model,
      tokens_in: result.usage.tokensIn,
      tokens_out: result.usage.tokensOut,
      llm_calls: 1,
    });
    return;
  }

  // Execute merges via merge-batch API
  appendLog(jobId, "info", `Found ${mergeGroups.length} merge group(s), executing`);

  for (const group of mergeGroups) {
    console.log(`[knowledge:consolidate] Merging: keep "${entityList.find((e) => e.id === group.keep)?.label}" <- [${group.merge.map((id: string) => entityList.find((e) => e.id === id)?.label).join(", ")}] -- ${group.rationale}`);
  }

  // Filter out groups with no actual merges (empty merge array)
  const validGroups = mergeGroups.filter((g) => g.merge && g.merge.length > 0);
  if (validGroups.length === 0) {
    appendLog(jobId, "info", "All merge groups were empty (no actual duplicates)");
    await setJobStatus(jobId, "completed", {
      result: { entities_checked: entities.length, merge_groups: mergeGroups.length, merged: 0 },
      model: result.usage.model,
      tokens_in: result.usage.tokensIn,
      tokens_out: result.usage.tokensOut,
      llm_calls: 1,
    });
    return;
  }

  const batchGroups = validGroups.map((g) => ({
    entity_ids: [g.keep, ...g.merge],
  }));

  try {
    const mergeResult = (await post("/entities/merge-batch", {
      groups: batchGroups,
      property_strategy: "accumulate",
    })) as { merged: number; failed: number };

    appendLog(jobId, "info", `Merged ${mergeResult.merged} group(s), ${mergeResult.failed} failed`);

    await setJobStatus(jobId, "completed", {
      result: {
        entities_checked: entities.length,
        merge_groups: mergeGroups.length,
        merged: mergeResult.merged,
        failed: mergeResult.failed,
      },
      model: result.usage.model,
      tokens_in: result.usage.tokensIn,
      tokens_out: result.usage.tokensOut,
      llm_calls: 1,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[knowledge:consolidate] Merge-batch failed: ${message}`);
    appendLog(jobId, "error", `Merge-batch failed: ${message}`);
    await setJobStatus(jobId, "completed", {
      result: {
        entities_checked: entities.length,
        merge_groups: mergeGroups.length,
        merged: 0,
        failed: mergeGroups.length,
        error: message,
      },
      model: result.usage.model,
      tokens_in: result.usage.tokensIn,
      tokens_out: result.usage.tokensOut,
      llm_calls: 1,
    });
  }
}
