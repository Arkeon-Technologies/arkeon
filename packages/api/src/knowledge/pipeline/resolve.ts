/**
 * Resolve extracted entities against the existing graph.
 * For each entity, search for candidates, then use LLM to judge matches.
 */

import { LlmClient } from "../lib/llm";
import { search, getEntity } from "../lib/arke-client";
import type {
  ExtractOpEntity,
  ExtractPlan,
  EntityCandidate,
  MergeDecision,
} from "../lib/types";
import type { LlmUsage } from "../lib/llm";
import { normalizeLabel as normalize } from "../lib/normalize";

function buildQueries(label: string): string[] {
  const parts = normalize(label).split(" ").filter(Boolean);
  const queries = new Set<string>([label, normalize(label)]);
  for (const part of parts) queries.add(part);
  return [...queries].filter(Boolean).slice(0, 5);
}

const JUDGE_PROMPT = `You are an entity dedupe judge.

Given one extracted entity and a set of graph candidates, decide which candidate IDs are the same real-world entity.

Return JSON:
{
  "self_ref": "person_brask_01",
  "self_label": "Gregor Brask",
  "same_as_ids": ["01ABC..."],
  "different_ids": ["01DEF..."],
  "rationale": "short explanation"
}

Rules:
- Be conservative
- Prefer exact or near-exact identity, not thematic relatedness
- Use type as a hint, not a hard constraint
- Different types can still be the same entity if one was typed incorrectly
- Consider every candidate independently
- If uncertain, put candidate in different_ids`;

async function resolveOne(
  llm: LlmClient,
  entity: ExtractOpEntity,
  arkeId: string,
  spaceId?: string,
): Promise<{
  candidates: EntityCandidate[];
  decision: MergeDecision;
  usage?: LlmUsage;
}> {
  const queries = buildQueries(entity.label);
  const hits = new Map<string, EntityCandidate>();

  const SKIP_TYPES = new Set(["document", "text_chunk"]);
  const MAX_DESC_CHARS = 200;
  const MAX_CANDIDATES = 10;

  for (const q of queries) {
    const results = await search(q, { arke_id: arkeId, space_id: spaceId, limit: 20 });
    for (const hit of results) {
      if (hit.id && !hits.has(hit.id)) {
        const full = await getEntity(hit.id);
        if (!full) continue;
        if (full.kind === "relationship") continue;
        if (SKIP_TYPES.has(full.type)) continue;
        const label = full?.properties?.label ?? "";
        if (normalize(label) !== "") {
          const desc = full?.properties?.description ?? "";
          hits.set(hit.id, {
            id: hit.id,
            label,
            type: full?.type ?? "",
            description: typeof desc === "string" ? desc.slice(0, MAX_DESC_CHARS) : "",
          });
        }
      }
    }
  }

  const candidateList = [...hits.values()].slice(0, MAX_CANDIDATES);

  if (candidateList.length === 0) {
    return {
      candidates: candidateList,
      decision: {
        self_ref: entity.ref,
        self_label: entity.label,
        same_as_ids: [],
        different_ids: [],
        rationale: "No candidates found in graph",
      },
    };
  }

  const exactMatch = candidateList.find(
    (c) => normalize(c.label) === normalize(entity.label) && c.type === entity.type,
  );
  if (exactMatch) {
    return {
      candidates: candidateList,
      decision: {
        self_ref: entity.ref,
        self_label: entity.label,
        same_as_ids: [exactMatch.id],
        different_ids: candidateList
          .filter((c) => c.id !== exactMatch.id)
          .map((c) => c.id),
        rationale: `Exact label match: "${exactMatch.label}"`,
      },
    };
  }

  const result = await llm.chatJson<MergeDecision>(
    JUDGE_PROMPT,
    JSON.stringify({
      self_ref: entity.ref,
      self_label: entity.label,
      self_type: entity.type,
      self_description: entity.description,
      candidates: candidateList,
    }),
    { maxTokens: 800 },
  );

  const decision: MergeDecision = {
    self_ref: result.data.self_ref ?? entity.ref,
    self_label: result.data.self_label ?? entity.label,
    same_as_ids: Array.isArray(result.data.same_as_ids) ? result.data.same_as_ids : [],
    different_ids: Array.isArray(result.data.different_ids) ? result.data.different_ids : [],
    rationale: result.data.rationale ?? "",
  };

  return {
    candidates: candidateList,
    decision,
    usage: result.usage,
  };
}

export async function resolveEntities(
  llm: LlmClient,
  plan: ExtractPlan,
  arkeId: string,
  spaceId?: string,
): Promise<{
  candidates: Record<string, EntityCandidate[]>;
  decisions: MergeDecision[];
  usage: LlmUsage[];
}> {
  const results = await Promise.all(
    plan.entities.map((entity) =>
      resolveOne(llm, entity, arkeId, spaceId).catch((err) => {
        console.warn(`[knowledge:resolve] Failed for "${entity.label}":`, err instanceof Error ? err.message : err);
        return {
          candidates: [] as EntityCandidate[],
          decision: {
            self_ref: entity.ref,
            self_label: entity.label,
            same_as_ids: [],
            different_ids: [],
            rationale: `Resolution failed: ${err instanceof Error ? err.message : String(err)}`,
          } as MergeDecision,
          usage: undefined,
        };
      }),
    ),
  );

  const candidates: Record<string, EntityCandidate[]> = {};
  const decisions: MergeDecision[] = [];
  const usage: LlmUsage[] = [];

  for (let i = 0; i < plan.entities.length; i++) {
    const r = results[i];
    candidates[plan.entities[i].ref] = r.candidates;
    decisions.push(r.decision);
    if (r.usage) usage.push(r.usage);
  }

  return { candidates, decisions, usage };
}
