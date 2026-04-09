/**
 * Universal group finalization: merge plans from sibling jobs → pipeline tail.
 *
 * Any fan-out job type (text.chunk_extract, pdf.page_group, etc.) stores an
 * ExtractPlan in its result. The last sibling to complete claims finalization
 * via an atomic gate, merges all sibling plans, and runs the shared pipeline.
 */

import type { SqlClient } from "../../lib/sql";
import type { ExtractPlan } from "../lib/types";
import type { ChatJsonResult } from "../lib/llm";
import { appendLog } from "../lib/logger";
import { setJobStatus } from "../queue";

import { mergeGroupPlans } from "./merge";
import { runExtractionPipeline, type PipelineOpts } from "./run-pipeline";
import { writeSourceProvenance } from "./write";

/**
 * Atomic gate: claim finalization only if all siblings are done.
 * Single query avoids the race where a sibling completes between
 * the claim and the check, then sees 'finalizing' and gives up.
 */
export async function claimFinalization(
  parentJobId: string,
  siblingJobType: string,
  sql: SqlClient,
): Promise<boolean> {
  const [claimed] = await sql.query(
    `UPDATE knowledge_jobs SET status = 'finalizing'
     WHERE id = $1 AND status = 'waiting'
       AND NOT EXISTS (
         SELECT 1 FROM knowledge_jobs
         WHERE parent_job_id = $1 AND job_type = $2
           AND status != 'completed'
       )
     RETURNING id`,
    [parentJobId, siblingJobType],
  );

  return !!claimed;
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
  sql: SqlClient,
): Promise<void> {
  try {
    await _runGroupFinalization(parentJobId, siblingJobType, opts, sql);
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
  sql: SqlClient,
): Promise<void> {
  // Fetch all sibling results ordered by ordinal
  const siblingJobs = await sql.query(
    `SELECT result, metadata FROM knowledge_jobs
     WHERE parent_job_id = $1 AND job_type = $2 AND status = 'completed'
     ORDER BY (result->>'groupOrdinal')::int`,
    [parentJobId, siblingJobType],
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
  let refToSourceOrdinal: Map<string, number> | undefined;

  if (groupResults.length === 1) {
    mergedPlan = groupResults[0].data;
  } else {
    const mergeResult = mergeGroupPlans(groupResults);
    mergedPlan = mergeResult.plan;
    refToSourceOrdinal = mergeResult.refToSourceOrdinal;
  }

  appendLog(parentJobId, "info", `Merged: ${mergedPlan.entities.length} entities, ${mergedPlan.relationships.length} relationships`);

  if (mergedPlan.entities.length === 0) {
    await setJobStatus(parentJobId, "completed", {
      result: { createdEntities: 0, createdRelationships: 0, potentialDuplicates: 0, childJobs: groupResults.length },
    });
    return;
  }

  // Run the pipeline tail
  const pipelineResult = await runExtractionPipeline(mergedPlan, {
    ...opts,
    jobId: parentJobId,
  });

  // Write source provenance (link extracted entities → source entities)
  const [parentMeta] = await sql.query(
    `SELECT metadata FROM knowledge_jobs WHERE id = $1`,
    [parentJobId],
  );
  const sourceEntityIds = ((parentMeta?.metadata as any)?.source_entity_ids ?? []) as string[];

  if (refToSourceOrdinal && sourceEntityIds.length > 0) {
    appendLog(parentJobId, "info", "Writing source provenance");
    await writeSourceProvenance(pipelineResult.refToId, refToSourceOrdinal, sourceEntityIds, opts.spaceId);
  }

  // Aggregate token usage from all siblings + finalization
  const tokenAgg = await sql.query(
    `SELECT COALESCE(SUM(tokens_in), 0)::int AS tin,
            COALESCE(SUM(tokens_out), 0)::int AS tout,
            COALESCE(SUM(llm_calls), 0)::int AS calls
     FROM knowledge_jobs WHERE parent_job_id = $1 AND job_type = $2`,
    [parentJobId, siblingJobType],
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
      potentialDuplicates: pipelineResult.potentialDuplicates,
      childJobs: groupResults.length,
    },
    model: pipelineResult.usage.model || undefined,
    tokens_in: totalTokensIn,
    tokens_out: totalTokensOut,
    llm_calls: totalLlmCalls,
  });

  console.log(`[knowledge:queue] Finalized group extraction for ${parentJobId}: ${pipelineResult.createdEntities} entities, ${pipelineResult.createdRelationships} rels`);
}
