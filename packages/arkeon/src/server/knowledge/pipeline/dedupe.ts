// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Post-write deduplication: search for potential duplicates among
 * newly created entities, use LLM to judge matches, and auto-merge
 * confirmed duplicates via POST /entities/merge-batch.
 */

import { LlmClient } from "../lib/llm";
import { search, getEntity, post } from "../lib/arke-client";
import type { EntityCandidate, MergeDecision } from "../lib/types";
import type { LlmUsage } from "../lib/llm";
import { normalizeLabel as normalize } from "../lib/normalize";

const STOP_WORDS = new Set([
  // articles
  "the", "a", "an",
  // prepositions
  "of", "in", "on", "at", "to", "for", "from", "with", "by", "into",
  "through", "during", "before", "after", "above", "below", "between",
  "under", "over", "about", "against", "among", "upon", "within",
  // conjunctions
  "and", "or", "but", "nor", "yet", "so",
  // pronouns / determiners
  "is", "was", "are", "were", "be", "been", "being",
  "has", "had", "have", "having",
  "do", "does", "did",
  "that", "this", "these", "those", "it", "its",
  "he", "she", "they", "we", "his", "her", "their", "our",
  // common filler
  "as", "if", "not", "no", "all", "also", "more", "most", "very",
  "which", "who", "whom", "whose", "when", "where", "how", "what",
]);

function buildQueries(label: string): string[] {
  const normalized = normalize(label);
  const parts = normalized.split(" ").filter(Boolean);
  const queries = new Set<string>([label, normalized]);
  // Add content words first (skip stop words so they don't waste query slots)
  for (const part of parts) {
    if (!STOP_WORDS.has(part)) queries.add(part);
  }
  return [...queries].filter(Boolean).slice(0, 10);
}

const DEDUPE_PROMPT = `You are an entity merge judge for a knowledge graph.

Given one entity and a set of candidates, decide which candidates refer to the same real-world entity and should be merged.

Return JSON:
{
  "self_ref": "01ABCSELF",
  "self_label": "Gregor Brask",
  "same_as_ids": ["01CAND1"],
  "different_ids": ["01OTHER"],
  "rationale": "short explanation"
}

Rules:
- MERGE when candidates clearly refer to the same real-world entity, even if labels differ (e.g. "Henry Kissinger" = "Secretary Kissinger" = "Dr. Kissinger" — same person, different titles)
- Use descriptions to confirm identity — if descriptions reference the same roles, events, or attributes, they are likely the same entity
- Keep SEPARATE when candidates are genuinely different entities that happen to share a name (e.g. a person vs an organization, or father vs son)
- Type is a hint, not absolute — the same entity may have been typed differently
- Exclude the entity itself from results
- When in doubt and descriptions are consistent, prefer merging`;

async function dedupeOne(
  llm: LlmClient,
  entityId: string,
  spaceId?: string,
): Promise<{
  duplicate?: { entityId: string; duplicateIds: string[]; rationale: string };
  usage?: LlmUsage;
}> {
  const entity = await getEntity(entityId);
  if (!entity) {
    console.log(`[knowledge:dedupe] ${entityId} — entity not found, skipping`);
    return {};
  }

  const label = entity.properties?.label ?? "";
  if (!label) {
    console.log(`[knowledge:dedupe] ${entityId} — no label, skipping`);
    return {};
  }

  const SKIP_TYPES = new Set(["document", "text_chunk"]);
  const MAX_DESC_CHARS = 200;
  const MAX_CANDIDATES = 20;

  const queries = buildQueries(label);
  console.log(`[knowledge:dedupe] ${entityId} "${label}" (${entity.type}) — queries: ${JSON.stringify(queries)}`);

  const hits = new Map<string, EntityCandidate>();

  for (const q of queries) {
    const results = await search(q, { space_id: spaceId, limit: 20 });
    for (const hit of results) {
      if (hit.id && hit.id !== entityId && !hits.has(hit.id)) {
        const full = await getEntity(hit.id);
        if (!full) continue;
        if (full.kind === "relationship") continue;
        if (SKIP_TYPES.has(full.type)) continue;
        const candidateLabel = full?.properties?.label ?? "";
        if (normalize(candidateLabel) !== "") {
          const desc = full?.properties?.description ?? "";
          hits.set(hit.id, {
            id: hit.id,
            label: candidateLabel,
            type: full?.type ?? "",
            description: typeof desc === "string" ? desc.slice(0, MAX_DESC_CHARS) : "",
          });
        }
      }
    }
  }

  const candidates = [...hits.values()].slice(0, MAX_CANDIDATES);
  if (candidates.length === 0) {
    console.log(`[knowledge:dedupe] ${entityId} "${label}" — no candidates found`);
    return {};
  }

  console.log(`[knowledge:dedupe] ${entityId} "${label}" — ${candidates.length} candidate(s): ${candidates.map((c) => `"${c.label}" (${c.type})`).join(", ")}`);

  // Collect ALL exact normalized-label matches (not just the first)
  const normalizedSelf = normalize(label);
  const exactMatches = candidates.filter(
    (c) => normalize(c.label) === normalizedSelf,
  );
  if (exactMatches.length > 0) {
    // If all candidates are exact matches, no need for LLM
    const nonExact = candidates.filter((c) => normalize(c.label) !== normalizedSelf);
    if (nonExact.length === 0) {
      console.log(`[knowledge:dedupe] ${entityId} "${label}" — exact match (no LLM): ${exactMatches.map((c) => c.id).join(", ")}`);
      return {
        duplicate: {
          entityId,
          duplicateIds: exactMatches.map((c) => c.id),
          rationale: `Exact label match: "${exactMatches[0].label}"${exactMatches.length > 1 ? ` (+${exactMatches.length - 1} more)` : ""}`,
        },
      };
    }
    // Otherwise, include exact matches in the LLM call for the fuzzy ones too
  }

  console.log(`[knowledge:dedupe] ${entityId} "${label}" — calling LLM for fuzzy match`);
  const result = await llm.chatJson<MergeDecision>(
    DEDUPE_PROMPT,
    JSON.stringify({
      self_ref: entityId,
      self_label: label,
      self_type: entity.type,
      self_description: typeof entity.properties?.description === "string"
        ? entity.properties.description.slice(0, MAX_DESC_CHARS) : "",
      candidates,
    }),
    { maxTokens: 800 },
  );

  const sameIds = (result.data.same_as_ids ?? []).filter(
    (id) => id !== entityId,
  );

  if (sameIds.length > 0) {
    console.log(`[knowledge:dedupe] ${entityId} "${label}" — LLM says merge with: ${sameIds.join(", ")} — ${result.data.rationale ?? ""}`);
  } else {
    console.log(`[knowledge:dedupe] ${entityId} "${label}" — LLM says no duplicates — ${result.data.rationale ?? ""}`);
  }

  return {
    duplicate: sameIds.length > 0
      ? { entityId, duplicateIds: sameIds, rationale: result.data.rationale ?? "" }
      : undefined,
    usage: result.usage,
  };
}

export async function dedupeEntities(
  llm: LlmClient,
  entityIds: string[],
  spaceId?: string,
  opts?: { concurrency?: number },
): Promise<{
  duplicates: Array<{ entityId: string; duplicateIds: string[]; rationale: string }>;
  usage: LlmUsage[];
}> {
  // Wait for Meilisearch to index newly written entities.
  // Jitter scales with concurrency — more parallel jobs means more spread needed.
  // Base 2s for indexing + up to (concurrency * 0.4s) random jitter.
  const concurrency = opts?.concurrency ?? 10;
  const jitter = 2000 + Math.random() * concurrency * 400;
  await new Promise((r) => setTimeout(r, jitter));

  const results = await Promise.all(
    entityIds.map((id) =>
      dedupeOne(llm, id, spaceId).catch((err) => {
        console.warn(`[knowledge:dedupe] Failed for ${id}, skipping:`, err instanceof Error ? err.message : err);
        return {} as { duplicate?: undefined; usage?: undefined };
      }),
    ),
  );

  const duplicates: Array<{ entityId: string; duplicateIds: string[]; rationale: string }> = [];
  const usage: LlmUsage[] = [];

  for (const r of results) {
    if (r.duplicate) duplicates.push(r.duplicate);
    if (r.usage) usage.push(r.usage);
  }

  return { duplicates, usage };
}

/**
 * Auto-merge confirmed duplicates via POST /entities/merge-batch.
 * Each duplicate group becomes [entityId, ...duplicateIds].
 * Failures are logged and swallowed — a 404/410 means another parallel
 * job already merged the entity, which is fine.
 */
export async function mergeConfirmedDuplicates(
  duplicates: Array<{ entityId: string; duplicateIds: string[]; rationale: string }>,
): Promise<{ merged: number; failed: number }> {
  if (duplicates.length === 0) return { merged: 0, failed: 0 };

  // Consolidate overlapping groups using union-find.
  // If entity A matches B and A matches C, merge into one group [A, B, C].
  const parent = new Map<string, string>();
  function find(x: string): string {
    if (!parent.has(x)) parent.set(x, x);
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    parent.set(x, root); // path compression
    return root;
  }
  function union(a: string, b: string) {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }

  for (const d of duplicates) {
    for (const dupId of d.duplicateIds) {
      union(d.entityId, dupId);
    }
  }

  // Collect consolidated groups
  const groupMap = new Map<string, Set<string>>();
  for (const id of parent.keys()) {
    const root = find(id);
    if (!groupMap.has(root)) groupMap.set(root, new Set());
    groupMap.get(root)!.add(id);
  }

  const groups = [...groupMap.values()]
    .filter((s) => s.size >= 2)
    .map((s) => ({ entity_ids: [...s] }));

  try {
    const result = (await post("/entities/merge-batch", {
      groups,
      property_strategy: "accumulate",
    })) as { merged: number; failed: number };

    if (result.merged > 0) {
      console.log(`[knowledge:dedupe] Auto-merged ${result.merged} duplicate(s)`);
    }
    return { merged: result.merged ?? 0, failed: result.failed ?? 0 };
  } catch (err) {
    // Graceful failure — entities may have been merged by another parallel job
    console.warn(
      `[knowledge:dedupe] Merge-batch failed (likely already merged):`,
      err instanceof Error ? err.message : err,
    );
    return { merged: 0, failed: groups.length };
  }
}
