// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Post-write deduplication via component-based search + LLM judge.
 *
 * Algorithm:
 * 1. Search: for each entity, find candidates via Meilisearch
 * 2. Build components: union-find on (entity, candidate) edges
 * 3. LLM judge per component: "which of these are the same?"
 * 4. Rectify: union-find on LLM output to merge overlapping subgroups
 * 5. Merge: execute each rectified group (no overlaps possible)
 */

import { LlmClient } from "../lib/llm";
import { search, getEntity, post } from "../lib/arke-client";
import type { EntityCandidate } from "../lib/types";
import type { LlmUsage } from "../lib/llm";
import { normalizeLabel as normalize } from "../lib/normalize";

// ---------------------------------------------------------------------------
// Union-find
// ---------------------------------------------------------------------------

class UnionFind {
  private parent = new Map<string, string>();

  find(x: string): string {
    if (!this.parent.has(x)) this.parent.set(x, x);
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root)!;
    this.parent.set(x, root);
    return root;
  }

  union(a: string, b: string): void {
    const ra = this.find(a), rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }

  components(): Map<string, Set<string>> {
    const groups = new Map<string, Set<string>>();
    for (const id of this.parent.keys()) {
      const root = this.find(id);
      if (!groups.has(root)) groups.set(root, new Set());
      groups.get(root)!.add(id);
    }
    return groups;
  }
}

// ---------------------------------------------------------------------------
// Stop words & query building
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  "the", "a", "an",
  "of", "in", "on", "at", "to", "for", "from", "with", "by", "into",
  "through", "during", "before", "after", "above", "below", "between",
  "under", "over", "about", "against", "among", "upon", "within",
  "and", "or", "but", "nor", "yet", "so",
  "is", "was", "are", "were", "be", "been", "being",
  "has", "had", "have", "having",
  "do", "does", "did",
  "that", "this", "these", "those", "it", "its",
  "he", "she", "they", "we", "his", "her", "their", "our",
  "as", "if", "not", "no", "all", "also", "more", "most", "very",
  "which", "who", "whom", "whose", "when", "where", "how", "what",
]);

function buildQueries(label: string): string[] {
  const normalized = normalize(label);
  const parts = normalized.split(" ").filter(Boolean);
  const queries = new Set<string>([label, normalized]);
  for (const part of parts) {
    if (!STOP_WORDS.has(part)) queries.add(part);
  }
  return [...queries].filter(Boolean).slice(0, 10);
}

// ---------------------------------------------------------------------------
// LLM prompt for component-level judging
// ---------------------------------------------------------------------------

const COMPONENT_JUDGE_PROMPT = `You are deduplicating a knowledge graph. Below are entities that search identified as potentially referring to the same things. Decide which ones are truly the same real-world entity.

Return JSON:
{
  "merge_groups": [
    {"ids": ["ID1", "ID2"], "rationale": "Same person, different name forms"},
    {"ids": ["ID3", "ID4", "ID5"], "rationale": "Same organization"}
  ],
  "no_merge": ["ID6", "ID7"]
}

Rules:
- Group entities that are THE SAME real-world noun (person, place, thing, org) under different labels
- Examples of true duplicates: "Columbia" = "Command Module Columbia", "Dr. Oppenheimer" = "J. Robert Oppenheimer", "AEC" = "Atomic Energy Commission", "USSR" = "Soviet Union"
- Do NOT merge an event/action with the entity it describes: "Armstrong walks on Moon" ≠ "Neil Armstrong"
- Do NOT merge a concept with an event referencing it: "Depression" ≠ "Aldrin's depression struggles"
- Do NOT merge related but distinct things: "State Department" ≠ "Sidelining of the State Department"
- Type differences are OK if it's truly the same thing: "Oak Ridge" (location) = "Oak Ridge facility" (org)
- When uncertain, put entities in no_merge — false merges are irreversible
- Every entity ID must appear in exactly one merge group OR in no_merge`;

const MAX_DESC_CHARS = 200;
const SKIP_TYPES = new Set(["document", "text_chunk"]);

// ---------------------------------------------------------------------------
// Step 1: Search for candidates per entity, build entity info map
// ---------------------------------------------------------------------------

async function searchForCandidates(
  entityIds: string[],
  spaceId?: string,
): Promise<{
  edges: Array<[string, string]>;
  entityInfo: Map<string, EntityCandidate>;
}> {
  const edges: Array<[string, string]> = [];
  const entityInfo = new Map<string, EntityCandidate>();
  const entitySet = new Set(entityIds);

  for (const entityId of entityIds) {
    const entity = await getEntity(entityId);
    if (!entity) continue;
    const label = entity.properties?.label ?? "";
    if (!label) continue;
    if (SKIP_TYPES.has(entity.type)) continue;

    // Store info for this entity
    if (!entityInfo.has(entityId)) {
      entityInfo.set(entityId, {
        id: entityId,
        label,
        type: entity.type,
        description: typeof entity.properties?.description === "string"
          ? entity.properties.description.slice(0, MAX_DESC_CHARS) : "",
      });
    }

    const queries = buildQueries(label);
    for (const q of queries) {
      // Search only on label field to avoid matching entities that merely
      // mention this entity in their description (which creates false
      // candidate edges and produces mega-components).
      const results = await search(q, { space_id: spaceId, limit: 20, search_on: "label" });
      for (const hit of results) {
        if (!hit.id || hit.id === entityId) continue;
        // Only consider candidates that are in our entity set OR are existing graph entities
        if (entityInfo.has(hit.id)) {
          edges.push([entityId, hit.id]);
          continue;
        }

        const full = await getEntity(hit.id);
        if (!full) continue;
        if (full.kind === "relationship") continue;
        if (SKIP_TYPES.has(full.type)) continue;
        const candidateLabel = full?.properties?.label ?? "";
        if (normalize(candidateLabel) === "") continue;

        entityInfo.set(hit.id, {
          id: hit.id,
          label: candidateLabel,
          type: full.type ?? "",
          description: typeof full.properties?.description === "string"
            ? full.properties.description.slice(0, MAX_DESC_CHARS) : "",
        });
        edges.push([entityId, hit.id]);
      }
    }
  }

  return { edges, entityInfo };
}

// ---------------------------------------------------------------------------
// Main dedupe function
// ---------------------------------------------------------------------------

export async function dedupeEntities(
  llm: LlmClient,
  entityIds: string[],
  spaceId?: string,
  _opts?: { concurrency?: number },
): Promise<{
  duplicates: Array<{ entityId: string; duplicateIds: string[]; rationale: string }>;
  usage: LlmUsage[];
}> {
  // Wait for Meilisearch indexing
  await new Promise((r) => setTimeout(r, 3000));

  console.log(`[knowledge:dedupe] Searching for candidates among ${entityIds.length} entities`);

  // Step 1: Search for all candidates
  const { edges, entityInfo } = await searchForCandidates(entityIds, spaceId);

  if (edges.length === 0) {
    console.log(`[knowledge:dedupe] No candidate edges found`);
    return { duplicates: [], usage: [] };
  }

  console.log(`[knowledge:dedupe] Found ${edges.length} candidate edges, ${entityInfo.size} unique entities`);

  // Step 2: Build components via union-find on search edges
  const uf = new UnionFind();
  for (const [a, b] of edges) {
    uf.union(a, b);
  }

  const components = uf.components();
  const multiComponents = [...components.values()].filter((s) => s.size >= 2);

  console.log(`[knowledge:dedupe] ${multiComponents.length} component(s) with 2+ entities`);

  if (multiComponents.length === 0) {
    return { duplicates: [], usage: [] };
  }

  // Step 3: LLM judge per component
  const allUsage: LlmUsage[] = [];
  const llmMergeGroups: Array<{ ids: string[]; rationale: string }> = [];

  for (const component of multiComponents) {
    const entityList = [...component]
      .map((id) => entityInfo.get(id))
      .filter((e): e is EntityCandidate => !!e);

    if (entityList.length < 2) continue;

    console.log(`[knowledge:dedupe] Judging component of ${entityList.length}: ${entityList.map((e) => `"${e.label}"`).join(", ")}`);

    // Check for exact normalized label matches first (no LLM needed)
    const labelGroups = new Map<string, EntityCandidate[]>();
    for (const e of entityList) {
      const key = normalize(e.label);
      if (!labelGroups.has(key)) labelGroups.set(key, []);
      labelGroups.get(key)!.push(e);
    }

    const exactGroups = [...labelGroups.values()].filter((g) => g.length >= 2);
    const needsLlm = entityList.length > exactGroups.reduce((n, g) => n + g.length, 0);

    if (!needsLlm && exactGroups.length > 0) {
      // All entities have exact label matches — no LLM needed
      for (const group of exactGroups) {
        llmMergeGroups.push({
          ids: group.map((e) => e.id),
          rationale: `Exact label match: "${group[0].label}"`,
        });
      }
      console.log(`[knowledge:dedupe] Exact matches only — ${exactGroups.length} group(s), no LLM needed`);
      continue;
    }

    // Call LLM for fuzzy matching
    try {
      const result = await llm.chatJson<{
        merge_groups: Array<{ ids: string[]; rationale: string }>;
        no_merge?: string[];
      }>(
        COMPONENT_JUDGE_PROMPT,
        JSON.stringify({ entities: entityList }),
        { maxTokens: 2000 },
      );

      allUsage.push(result.usage);

      const groups = result.data.merge_groups ?? [];
      for (const g of groups) {
        if (g.ids && g.ids.length >= 2) {
          llmMergeGroups.push(g);
          console.log(`[knowledge:dedupe] LLM merge: [${g.ids.map((id) => entityInfo.get(id)?.label ?? id).join(", ")}] — ${g.rationale}`);
        }
      }
    } catch (err) {
      console.warn(`[knowledge:dedupe] LLM judge failed for component, skipping:`, err instanceof Error ? err.message : err);
    }
  }

  if (llmMergeGroups.length === 0) {
    console.log(`[knowledge:dedupe] No duplicates confirmed`);
    return { duplicates: [], usage: allUsage };
  }

  // Step 4: Rectify — union-find on LLM output to merge overlapping subgroups
  const rectifyUf = new UnionFind();
  for (const group of llmMergeGroups) {
    for (let i = 1; i < group.ids.length; i++) {
      rectifyUf.union(group.ids[0], group.ids[i]);
    }
  }

  const rectifiedComponents = rectifyUf.components();
  const finalGroups = [...rectifiedComponents.values()]
    .filter((s) => s.size >= 2);

  console.log(`[knowledge:dedupe] Rectified into ${finalGroups.length} final merge group(s)`);

  // Convert to the format expected by mergeConfirmedDuplicates
  const duplicates = finalGroups.map((group) => {
    const ids = [...group];
    return {
      entityId: ids[0],
      duplicateIds: ids.slice(1),
      rationale: llmMergeGroups.find((g) => g.ids.some((id) => group.has(id)))?.rationale ?? "Component merge",
    };
  });

  return { duplicates, usage: allUsage };
}

// ---------------------------------------------------------------------------
// Execute merges
// ---------------------------------------------------------------------------

/**
 * Merge confirmed duplicate groups via POST /entities/merge-batch.
 * Processes one group at a time to handle cascading merges cleanly.
 */
export async function mergeConfirmedDuplicates(
  duplicates: Array<{ entityId: string; duplicateIds: string[]; rationale: string }>,
): Promise<{ merged: number; failed: number }> {
  if (duplicates.length === 0) return { merged: 0, failed: 0 };

  let merged = 0;
  let failed = 0;

  for (const d of duplicates) {
    const group = { entity_ids: [d.entityId, ...d.duplicateIds] };
    try {
      const result = (await post("/entities/merge-batch", {
        groups: [group],
        property_strategy: "accumulate",
      })) as { merged: number; failed: number };
      merged += result.merged ?? 0;
      failed += result.failed ?? 0;
    } catch {
      failed++;
    }
  }

  if (merged > 0) {
    console.log(`[knowledge:dedupe] Auto-merged ${merged} duplicate(s)`);
  }
  return { merged, failed };
}
