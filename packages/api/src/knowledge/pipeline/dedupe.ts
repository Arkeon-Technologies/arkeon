/**
 * Post-write deduplication: search for potential duplicates among
 * newly created entities and use LLM to judge matches.
 */

import { LlmClient } from "../lib/llm";
import { search, getEntity } from "../lib/arke-client";
import type { EntityCandidate, MergeDecision } from "../lib/types";
import type { LlmUsage } from "../lib/llm";
import { normalizeLabel as normalize } from "../lib/normalize";

function buildQueries(label: string): string[] {
  const parts = normalize(label).split(" ").filter(Boolean);
  const queries = new Set<string>([label, normalize(label)]);
  for (const part of parts) queries.add(part);
  return [...queries].filter(Boolean).slice(0, 5);
}

const DEDUPE_PROMPT = `You are an entity dedupe judge.

Given one graph entity and a set of graph candidates, decide which candidate IDs are the same real-world entity.

Return JSON:
{
  "self_ref": "01ABCSELF",
  "self_label": "Gregor Brask",
  "same_as_ids": ["01CAND1"],
  "different_ids": ["01OTHER"],
  "rationale": "short explanation"
}

Rules:
- Be conservative — same means exact or near-exact identity
- Use type as a hint, not a hard constraint
- Exclude the entity itself from results
- If uncertain, put the candidate in different_ids`;

async function dedupeOne(
  llm: LlmClient,
  entityId: string,
  arkeId: string,
  spaceId?: string,
): Promise<{
  duplicate?: { entityId: string; duplicateIds: string[]; rationale: string };
  usage?: LlmUsage;
}> {
  const entity = await getEntity(entityId);
  if (!entity) return {};

  const label = entity.properties?.label ?? "";
  if (!label) return {};

  const SKIP_TYPES = new Set(["document", "text_chunk"]);
  const MAX_DESC_CHARS = 200;
  const MAX_CANDIDATES = 10;

  const queries = buildQueries(label);
  const hits = new Map<string, EntityCandidate>();

  for (const q of queries) {
    const results = await search(q, { arke_id: arkeId, space_id: spaceId, limit: 20 });
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
  if (candidates.length === 0) return {};

  const exactMatch = candidates.find(
    (c) => normalize(c.label) === normalize(label),
  );
  if (exactMatch) {
    return {
      duplicate: {
        entityId,
        duplicateIds: [exactMatch.id],
        rationale: `Exact label match: "${exactMatch.label}"`,
      },
    };
  }

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
  arkeId: string,
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
      dedupeOne(llm, id, arkeId, spaceId).catch((err) => {
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
