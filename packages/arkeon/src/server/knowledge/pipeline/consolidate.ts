// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Space-level consolidation via LLM revision pass.
 *
 * After parallel extraction jobs write entities, a debounced consolidate
 * job identifies groups of entities with overlapping labels and gives the
 * LLM a focused revision pass on each group. The LLM can merge duplicates
 * and add missing relationships using the same ops format as extraction.
 *
 * Pre-filtering: only entities whose labels share significant content words
 * with at least one other entity are sent to the LLM. This keeps each
 * revision batch small (<20 entities) and avoids overwhelming the model.
 */

import { withAdminSql } from "../lib/admin-sql";
import { LlmClient } from "../lib/llm";
import { resolveLlmConfig } from "../lib/config";
import { appendLog } from "../lib/logger";
import { setJobStatus } from "../queue";
import { submitOpsEnvelope, type OpsEnvelopeInput } from "../lib/arke-client";
import { normalizeLabel as normalize } from "../lib/normalize";
import type { JobRecord } from "../queue";
import type { SqlClient } from "../../lib/sql";

const DEBOUNCE_MS = 15_000;
const MAX_ENTITIES_PER_BATCH = 200;
const DESC_SNIPPET_CHARS = 150;

// Words too common to be meaningful for overlap detection
const OVERLAP_STOP_WORDS = new Set([
  "the", "a", "an", "of", "in", "on", "at", "to", "for", "from", "with",
  "by", "and", "or", "but", "is", "was", "are", "were", "be", "not",
  "as", "that", "this", "it", "its", "no", "all",
]);

const REVISION_PROMPT = `You are revising a knowledge graph. Below are entities that may be duplicates of each other based on overlapping names. Review them and submit ops.

Return JSON:
{
  "ops": [
    {"op": "merge", "target": "01KEEP_ID", "sources": ["01DUP_ID"]},
    {"op": "relate", "source": "01ID_A", "target": "01ID_B", "predicate": "led"}
  ]
}

Available ops:
- merge: combine duplicate entities. "target" is the entity to keep (prefer richest description). "sources" are entities to delete (their relationships transfer to target).
- relate: add a missing relationship between two existing entities.

MERGE only when two entities are the SAME real-world thing:
- Same person: "Henry Kissinger" = "Kissinger" = "Dr. Kissinger"
- Same country: "USSR" = "Soviet Union"
- Same org: "State Department" = "U.S. State Department" = "Dept. of State"
- Same abbreviation: "AEC" = "Atomic Energy Commission"

NEVER merge:
- Different things sharing a word: "United States" ≠ "United Nations"
- A person and a country: "Richard Nixon" ≠ "United States"
- An event about an entity: "Kissinger becomes Secretary" ≠ "Henry Kissinger"
- Different cities: "Beijing" ≠ "Shanghai"
- A policy and its violation: "Detente" ≠ "Soviet intervention"

If nothing needs merging, return {"ops": []}. When uncertain, don't merge.`;

interface CompactEntity {
  id: string;
  label: string;
  type: string;
  description: string;
}

/**
 * Extract significant content words from a label for overlap detection.
 */
function contentWords(label: string): Set<string> {
  return new Set(
    normalize(label)
      .split(" ")
      .filter((w) => w.length > 1 && !OVERLAP_STOP_WORDS.has(w)),
  );
}

/**
 * Group entities by label overlap. Two entities are connected if one's
 * content words are a subset of the other's, or they share >=60% of
 * their content words. This is stricter than single-word overlap to
 * prevent transitive chaining into mega-groups.
 */
function findOverlapGroups(entities: CompactEntity[]): CompactEntity[][] {
  const parent = new Map<string, string>();
  function find(x: string): string {
    if (!parent.has(x)) parent.set(x, x);
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    parent.set(x, root);
    return root;
  }
  function union(a: string, b: string) {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }

  // Pairwise comparison with strict overlap criteria
  for (let i = 0; i < entities.length; i++) {
    const wa = contentWords(entities[i].label);
    if (wa.size === 0) continue;
    for (let j = i + 1; j < entities.length; j++) {
      const wb = contentWords(entities[j].label);
      if (wb.size === 0) continue;

      const shared = new Set([...wa].filter((w) => wb.has(w)));
      if (shared.size === 0) continue;

      // Connect if one is a subset of the other (abbreviation/expansion)
      // or they share >=60% of the smaller label's content words
      const minLen = Math.min(wa.size, wb.size);
      const isSubset = shared.size === wa.size || shared.size === wb.size;
      const highOverlap = shared.size >= Math.max(2, Math.ceil(minLen * 0.6));

      if (isSubset || highOverlap) {
        union(entities[i].id, entities[j].id);
      }
    }
  }

  // Collect groups of 2+
  const groups = new Map<string, CompactEntity[]>();
  for (const e of entities) {
    const root = find(e.id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(e);
  }

  return [...groups.values()].filter((g) => g.length >= 2);
}

export async function handleConsolidate(job: JobRecord, _sql: SqlClient): Promise<void> {
  const jobId = job.id as string;
  const metadata = (job.metadata ?? {}) as Record<string, unknown>;
  const spaceId = metadata.space_id as string | undefined;

  if (!spaceId) {
    await setJobStatus(jobId, "completed", { result: { reason: "no space_id" } });
    return;
  }

  appendLog(jobId, "info", `Debouncing ${DEBOUNCE_MS}ms for space ${spaceId}`);
  await new Promise((r) => setTimeout(r, DEBOUNCE_MS));

  // Fetch recently extracted entities
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

  const entityList: CompactEntity[] = entities.map((e) => ({
    id: e.id as string,
    label: (e.label as string) || "?",
    type: e.type as string,
    description: (e.description as string) || "",
  }));

  // Pre-filter: find groups of entities with overlapping labels
  const overlapGroups = findOverlapGroups(entityList);

  if (overlapGroups.length === 0) {
    appendLog(jobId, "info", "No overlapping label groups found — nothing to revise");
    await setJobStatus(jobId, "completed", {
      result: { entities_checked: entities.length, overlap_groups: 0 },
    });
    return;
  }

  const totalInGroups = overlapGroups.reduce((n, g) => n + g.length, 0);
  appendLog(jobId, "info", `Found ${overlapGroups.length} overlap group(s) with ${totalInGroups} entities total`);

  for (const group of overlapGroups) {
    console.log(`[knowledge:consolidate] Group (${group.length}): ${group.map((e) => `"${e.label}"`).join(", ")}`);
  }

  // LLM revision pass per group
  const resolverConfig = await resolveLlmConfig("resolver");
  const resolverLlm = new LlmClient(resolverConfig);

  let totalMergeOps = 0;
  let totalRelateOps = 0;
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let llmCalls = 0;
  let model = "";

  for (const group of overlapGroups) {
    try {
      const result = await resolverLlm.chatJson<{
        ops: Array<Record<string, unknown>>;
      }>(
        REVISION_PROMPT,
        JSON.stringify({ entities: group }),
        { maxTokens: 2000 },
      );

      if (!model && result.usage.model) model = result.usage.model;
      totalTokensIn += result.usage.tokensIn;
      totalTokensOut += result.usage.tokensOut;
      llmCalls++;

      const ops = result.data.ops ?? [];
      if (ops.length === 0) continue;

      const mergeOps = ops.filter((o) => o.op === "merge");
      const relateOps = ops.filter((o) => o.op === "relate");

      for (const op of mergeOps) {
        const tgtLabel = group.find((e) => e.id === op.target)?.label ?? op.target;
        const srcLabels = ((op.sources as string[]) ?? []).map(
          (id) => group.find((e) => e.id === id)?.label ?? id,
        );
        console.log(`[knowledge:consolidate] Merge: keep "${tgtLabel}" <- [${srcLabels.join(", ")}]`);
      }
      for (const op of relateOps) {
        const srcLabel = group.find((e) => e.id === op.source)?.label ?? op.source;
        const tgtLabel = group.find((e) => e.id === op.target)?.label ?? op.target;
        console.log(`[knowledge:consolidate] Relate: "${srcLabel}" --[${op.predicate}]--> "${tgtLabel}"`);
      }

      // Submit ops
      const envelope: OpsEnvelopeInput = {
        format: "arke.ops/v1",
        defaults: { space_id: spaceId },
        ops,
      };

      await submitOpsEnvelope(envelope);
      totalMergeOps += mergeOps.length;
      totalRelateOps += relateOps.length;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[knowledge:consolidate] Group revision failed: ${message}`);
      appendLog(jobId, "error", `Group revision failed: ${message}`);
    }
  }

  appendLog(jobId, "info", `Revision complete: ${totalMergeOps} merges, ${totalRelateOps} relationships across ${overlapGroups.length} groups`);

  await setJobStatus(jobId, "completed", {
    result: {
      entities_checked: entities.length,
      overlap_groups: overlapGroups.length,
      merge_ops: totalMergeOps,
      relate_ops: totalRelateOps,
    },
    model,
    tokens_in: totalTokensIn,
    tokens_out: totalTokensOut,
    llm_calls: llmCalls,
  });
}
