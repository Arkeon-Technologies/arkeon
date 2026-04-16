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

/** Strip invalid UTF-8 sequences from a string. */
function sanitizeUtf8(s: string): string {
  // Replace any lone surrogates or invalid sequences
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\uFFFD\uFFFE\uFFFF]/g, "").replace(/[^\x09\x0A\x0D\x20-\uD7FF\uE000-\uFFFD]/g, "");
}

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
- Same person, different name: "William Smith" = "W. Smith" = "Dr. Smith"
- Same country, different name: "Deutschland" = "Germany"
- Same org, different form: "Dept. of Defense" = "Department of Defense" = "DoD"
- Same abbreviation: "WHO" = "World Health Organization"

NEVER merge:
- Different things sharing a word: "United States" ≠ "United Nations"
- A person and a country they lead: "Charles de Gaulle" ≠ "France"
- An event about an entity: "Smith appointed Director" ≠ "William Smith"
- Different cities: "Paris" ≠ "Lyon"
- A policy and its violation: "Treaty" ≠ "Treaty violations"

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

const ALIAS_PROMPT = `For each entity label below, list 2-3 alternative names that the same thing might be called elsewhere. Return JSON:
{"aliases": {"ID1": ["alias1", "alias2"], "ID2": ["alias1"]}}

Generate:
- If it's an acronym, expand it: "NATO" → ["North Atlantic Treaty Organization"]
- If it's a full name, give the acronym/abbreviation: "European Union" → ["EU"], "Federal Bureau of Investigation" → ["FBI"]
- If it has a common alternate name: "Germany" → ["Deutschland", "BRD"], "Myanmar" → ["Burma"]
- If it's a person, try short forms: "Theodore Roosevelt" → ["Teddy Roosevelt", "T. Roosevelt"]

Only include real alternative names for the same thing. Omit IDs with no aliases.`;

/**
 * Generate alternative label keywords for each entity via a lightweight
 * LLM call. This catches synonym matches (e.g. abbreviations) that
 * share zero content words.
 */
async function generateLabelAliases(
  llm: LlmClient,
  entities: CompactEntity[],
  jobId: string,
): Promise<Map<string, string[]>> {
  const aliasMap = new Map<string, string[]>();
  if (entities.length === 0) return aliasMap;

  // Build a compact label list — just IDs and labels, no descriptions
  const labelList = entities.map((e) => ({ id: e.id, label: e.label, type: e.type }));

  try {
    const result = await llm.chatJson<{
      aliases: Record<string, string[]>;
    }>(
      ALIAS_PROMPT,
      JSON.stringify({ entities: labelList }),
      { maxTokens: 2000 },
    );

    const aliases = result.data.aliases ?? {};
    for (const [id, alts] of Object.entries(aliases)) {
      if (Array.isArray(alts) && alts.length > 0) {
        aliasMap.set(id, alts.map((a) => String(a).toLowerCase()));
      }
    }

    const emap = new Map(entities.map((e) => [e.id, e.label]));
    for (const [id, alts] of aliasMap) {
      console.log(`[knowledge:consolidate] Aliases for "${emap.get(id) ?? id}": ${JSON.stringify(alts)}`);
    }
    appendLog(jobId, "info", `Generated aliases for ${aliasMap.size} entities`);
  } catch (err) {
    console.warn(`[knowledge:consolidate] Alias generation failed, continuing without:`, err instanceof Error ? err.message : err);
  }

  return aliasMap;
}

/**
 * Group entities by label overlap. Two entities are connected if one's
 * content words are a subset of the other's, they share >=50% of both
 * labels' content words, OR one entity's aliases match another's label.
 */
function findOverlapGroups(entities: CompactEntity[], aliasMap?: Map<string, string[]>): CompactEntity[][] {
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

      // Check alias matches first — works even with zero shared content words
      // (e.g. "USSR" and "Soviet Union" share no words but aliases connect them)
      let aliasMatch = false;
      if (aliasMap) {
        const normA = normalize(entities[i].label);
        const normB = normalize(entities[j].label);
        const aliasesA = aliasMap.get(entities[i].id) ?? [];
        const aliasesB = aliasMap.get(entities[j].id) ?? [];
        aliasMatch = aliasesA.some((a) => normalize(a) === normB || normB.includes(normalize(a)))
                  || aliasesB.some((a) => normalize(a) === normA || normA.includes(normalize(a)));
      }

      if (aliasMatch) {
        union(entities[i].id, entities[j].id);
        continue;
      }

      // Content word overlap check
      const shared = new Set([...wa].filter((w) => wb.has(w)));
      if (shared.size === 0) continue;

      const maxLen = Math.max(wa.size, wb.size);
      const minLen = Math.min(wa.size, wb.size);

      const aOverlap = shared.size / wa.size;
      const bOverlap = shared.size / wb.size;
      const bidirectional = aOverlap >= 0.5 && bOverlap >= 0.5;
      const bothShort = maxLen <= 3 && shared.size >= 1;

      if ((bidirectional && shared.size >= 2) || (bothShort && minLen === shared.size)) {
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
                left(e.properties->>'description', ${DESC_SNIPPET_CHARS}) AS description
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
    label: sanitizeUtf8((e.label as string) || "?"),
    type: e.type as string,
    description: sanitizeUtf8((e.description as string) || ""),
  }));

  // Generate alternative label keywords to catch synonym-type matches
  // (e.g. abbreviations, alternate names, translated forms)
  const resolverConfig = await resolveLlmConfig("resolver");
  const resolverLlm = new LlmClient(resolverConfig);

  const aliasMap = await generateLabelAliases(resolverLlm, entityList, jobId);

  // Pre-filter: find groups of entities with overlapping labels (including aliases)
  const overlapGroups = findOverlapGroups(entityList, aliasMap);

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

  // LLM revision pass per group (reuse resolverLlm from alias step)
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
      const message = sanitizeUtf8(err instanceof Error ? err.message : String(err));
      console.warn(`[knowledge:consolidate] Group revision failed: ${message}`);
      appendLog(jobId, "error", sanitizeUtf8(`Group revision failed: ${message}`));
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
