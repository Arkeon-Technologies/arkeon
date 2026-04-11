// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Map local refs to canonical IDs based on merge decisions.
 * Entities matched to existing graph entries get linked rather than duplicated.
 */

import type {
  ExtractPlan,
  MergeDecision,
  CanonicalEntity,
  CanonicalRelationship,
} from "../lib/types";

export function rewritePlanToCanonical(
  plan: ExtractPlan,
  decisions: MergeDecision[],
): { entities: CanonicalEntity[]; relationships: CanonicalRelationship[] } {
  const decisionMap = new Map(decisions.map((d) => [d.self_ref, d]));

  const entities = plan.entities.map((entity) => ({
    ref: entity.ref,
    canonical_id: decisionMap.get(entity.ref)?.same_as_ids?.[0],
    label: entity.label,
    type: entity.type,
    description: entity.description,
  }));

  const relationships = plan.relationships.map((rel) => ({
    source_ref: rel.source_ref,
    target_ref: rel.target_ref,
    source_id: decisionMap.get(rel.source_ref)?.same_as_ids?.[0],
    target_id: decisionMap.get(rel.target_ref)?.same_as_ids?.[0],
    predicate: rel.predicate,
    source_span: rel.source_span,
    detail: rel.detail,
  }));

  return { entities, relationships };
}
