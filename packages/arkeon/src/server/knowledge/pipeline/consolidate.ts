// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Space-level batch consolidation handler.
 *
 * After extraction jobs write entities, a debounced consolidate job
 * runs the existing dedupe logic (search + LLM judge per entity) on
 * all recently extracted entities in the space. This is the same dedupe
 * that used to run inline after each extraction, but with better timing:
 * it waits for parallel jobs to finish so the search index has all
 * entities before deduping.
 */

import { withAdminSql } from "../lib/admin-sql";
import { LlmClient } from "../lib/llm";
import { resolveLlmConfig, getExtractionConfig } from "../lib/config";
import { appendLog } from "../lib/logger";
import { setJobStatus } from "../queue";
import { dedupeEntities, mergeConfirmedDuplicates } from "./dedupe";
import type { JobRecord } from "../queue";
import type { SqlClient } from "../../lib/sql";

const DEBOUNCE_MS = 15_000;
const MAX_ENTITIES_PER_BATCH = 200;

export async function handleConsolidate(job: JobRecord, _sql: SqlClient): Promise<void> {
  const jobId = job.id as string;
  const metadata = (job.metadata ?? {}) as Record<string, unknown>;
  const spaceId = metadata.space_id as string | undefined;

  if (!spaceId) {
    await setJobStatus(jobId, "completed", { result: { reason: "no space_id" } });
    return;
  }

  // Debounce: wait for parallel extraction jobs to finish and
  // Meilisearch to index their entities before searching for duplicates.
  appendLog(jobId, "info", `Debouncing ${DEBOUNCE_MS}ms for space ${spaceId}`);
  await new Promise((r) => setTimeout(r, DEBOUNCE_MS));

  // Fetch IDs of recently extracted entities in this space.
  const entityIds = await withAdminSql(async (sql) => {
    const results = await sql.transaction([
      sql`SELECT set_config('app.actor_id', 'SYSTEM', true)`,
      sql`SELECT set_config('app.actor_read_level', '4', true)`,
      sql`SELECT set_config('app.actor_is_admin', 'true', true)`,
      sql.query(
        `SELECT e.id
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
    return (results[results.length - 1] as Array<Record<string, unknown>>).map(
      (r) => r.id as string,
    );
  });

  appendLog(jobId, "info", `Found ${entityIds.length} recent entities in space`);

  if (entityIds.length < 2) {
    await setJobStatus(jobId, "completed", {
      result: { entities_checked: entityIds.length, merged: 0, reason: "too few entities" },
    });
    return;
  }

  // Run the same dedupe logic that used to run inline after each extraction.
  // Each entity gets searched against the space, LLM judges matches.
  const resolverConfig = await resolveLlmConfig("resolver");
  const resolverLlm = new LlmClient(resolverConfig);
  const extractionConfig = await getExtractionConfig();

  appendLog(jobId, "info", `Running dedupe on ${entityIds.length} entities`);

  const dedupeResult = await dedupeEntities(
    resolverLlm,
    entityIds,
    spaceId,
    { concurrency: extractionConfig.max_concurrency },
  );

  let tokensIn = 0;
  let tokensOut = 0;
  let llmCalls = 0;
  let model = "";
  for (const u of dedupeResult.usage) {
    tokensIn += u.tokensIn;
    tokensOut += u.tokensOut;
    llmCalls++;
    if (!model && u.model) model = u.model;
  }

  if (dedupeResult.duplicates.length === 0) {
    appendLog(jobId, "info", "No duplicates found");
    await setJobStatus(jobId, "completed", {
      result: { entities_checked: entityIds.length, duplicates_found: 0, merged: 0 },
      model, tokens_in: tokensIn, tokens_out: tokensOut, llm_calls: llmCalls,
    });
    return;
  }

  appendLog(jobId, "info", `Found ${dedupeResult.duplicates.length} duplicate group(s), merging`);

  const mergeResult = await mergeConfirmedDuplicates(dedupeResult.duplicates);

  appendLog(jobId, "info", `Merged ${mergeResult.merged}, failed ${mergeResult.failed}`);

  await setJobStatus(jobId, "completed", {
    result: {
      entities_checked: entityIds.length,
      duplicates_found: dedupeResult.duplicates.length,
      merged: mergeResult.merged,
      failed: mergeResult.failed,
    },
    model, tokens_in: tokensIn, tokens_out: tokensOut, llm_calls: llmCalls,
  });
}
