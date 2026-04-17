// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Universal group finalization: merge plans from sibling jobs → pipeline tail.
 *
 * Any fan-out job type (text.chunk_extract, pdf.page_group, etc.) stores an
 * ExtractPlan in its result. The last sibling to complete claims finalization
 * via an atomic gate, merges all sibling plans, and runs the shared pipeline.
 *
 * Source provenance (extracted_from edges) is now handled automatically by
 * POST /ops via source.entity_id — no separate writeSourceProvenance step.
 */

import type { ExtractPlan } from "../lib/types";
import type { ChatJsonResult } from "../lib/llm";
import { withAdminSql } from "../lib/admin-sql";
import { appendLog } from "../lib/logger";
import { setJobStatus, tryFinalizeParent } from "../queue";

import { mergeGroupPlans } from "./merge";
import { runExtractionPipeline, type PipelineOpts } from "./run-pipeline";

/**
 * Atomic gate: claim finalization only if all siblings are done.
 * Single query avoids the race where a sibling completes between
 * the claim and the check, then sees 'finalizing' and gives up.
 *
 * Uses withAdminSql so the query can see all knowledge_jobs rows
 * regardless of triggered_by (RLS policy requires admin context
 * for rows where triggered_by is non-NULL).
 */
export async function claimFinalization(
  parentJobId: string,
  siblingJobType: string,
): Promise<boolean> {
  const rows = await withAdminSql(async (sql) =>
    sql.query(
      `UPDATE knowledge_jobs SET status = 'finalizing'
       WHERE id = $1 AND status = 'waiting'
         AND NOT EXISTS (
           SELECT 1 FROM knowledge_jobs
           WHERE parent_job_id = $1 AND job_type = $2
             AND status != 'completed'
         )
       RETURNING id`,
      [parentJobId, siblingJobType],
    ),
  );

  return rows.length > 0;
}

/**
 * Merge all sibling plans and run the extraction pipeline tail.
 * Called by the sibling that won claimFinalization().
 * Catches errors and marks parent as failed to avoid stuck 'finalizing' state.
 */
export async function runGroupFinalization(
  parentJobId: string,
  siblingJobType: string,
  opts: PipelineOpts,
): Promise<void> {
  try {
    await _runGroupFinalization(parentJobId, siblingJobType, opts);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[knowledge:queue] Group finalization failed for ${parentJobId}: ${message}`);
    appendLog(parentJobId, "error", `Finalization failed: ${message}`);
    await setJobStatus(parentJobId, "failed", { error: message });
  }
}

async function _runGroupFinalization(
  parentJobId: string,
  siblingJobType: string,
  opts: PipelineOpts,
): Promise<void> {
  // Fetch all sibling results ordered by ordinal (admin context for RLS)
  const siblingJobs = await withAdminSql(async (sql) =>
    sql.query(
      `SELECT result, metadata FROM knowledge_jobs
       WHERE parent_job_id = $1 AND job_type = $2 AND status = 'completed'
       ORDER BY (result->>'groupOrdinal')::int`,
      [parentJobId, siblingJobType],
    ),
  );

  const groupResults: ChatJsonResult<ExtractPlan>[] = siblingJobs.map((j) => {
    const result = j.result as { plan: ExtractPlan; groupOrdinal: number };
    return {
      data: result.plan,
      usage: { model: "", tokensIn: 0, tokensOut: 0 },
    };
  });

  appendLog(parentJobId, "info", `Merging ${groupResults.length} group extraction results`);

  // Merge (skip if single group)
  let mergedPlan: ExtractPlan;

  if (groupResults.length === 1) {
    mergedPlan = groupResults[0].data;
  } else {
    const mergeResult = mergeGroupPlans(groupResults);
    mergedPlan = mergeResult.plan;
  }

  appendLog(parentJobId, "info", `Merged: ${mergedPlan.entities.length} entities, ${mergedPlan.relationships.length} relationships`);

  if (mergedPlan.entities.length === 0) {
    await setJobStatus(parentJobId, "completed", {
      result: { createdEntities: 0, createdRelationships: 0, mergedDuplicates: 0, childJobs: groupResults.length },
    });
    return;
  }

  // Run the pipeline tail
  const pipelineResult = await runExtractionPipeline(mergedPlan, {
    ...opts,
    jobId: parentJobId,
  });

  // Aggregate token usage from all siblings + finalization
  const tokenAgg = await withAdminSql(async (sql) =>
    sql.query(
      `SELECT COALESCE(SUM(tokens_in), 0)::int AS tin,
              COALESCE(SUM(tokens_out), 0)::int AS tout,
              COALESCE(SUM(llm_calls), 0)::int AS calls
       FROM knowledge_jobs WHERE parent_job_id = $1 AND job_type = $2`,
      [parentJobId, siblingJobType],
    ),
  );
  const agg = tokenAgg[0] ?? {};
  const totalTokensIn = ((agg.tin as number) ?? 0) + pipelineResult.usage.tokensIn;
  const totalTokensOut = ((agg.tout as number) ?? 0) + pipelineResult.usage.tokensOut;
  const totalLlmCalls = ((agg.calls as number) ?? 0) + pipelineResult.usage.llmCalls;

  await setJobStatus(parentJobId, "completed", {
    result: {
      documentId: opts.documentId,
      extractedEntities: pipelineResult.extractedEntities,
      extractedRelationships: pipelineResult.extractedRelationships,
      createdEntities: pipelineResult.createdEntities,
      createdRelationships: pipelineResult.createdRelationships,
      mergedDuplicates: pipelineResult.mergedDuplicates,
      childJobs: groupResults.length,
    },
    model: pipelineResult.usage.model || undefined,
    tokens_in: totalTokensIn,
    tokens_out: totalTokensOut,
    llm_calls: totalLlmCalls,
  });

  console.log(`[knowledge:queue] Finalized group extraction for ${parentJobId}: ${pipelineResult.createdEntities} entities, ${pipelineResult.createdRelationships} rels`);

  // Propagate up the parent chain for 3-level hierarchies
  // (e.g., ingest → pdf.extract → pdf.page_group)
  const parentRows = await withAdminSql(async (sql) =>
    sql.query(
      `SELECT parent_job_id FROM knowledge_jobs WHERE id = $1`,
      [parentJobId],
    ),
  );
  if (parentRows[0]?.parent_job_id) {
    await tryFinalizeParent(parentRows[0].parent_job_id as string);
  }
}
