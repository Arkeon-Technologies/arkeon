// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * arke.ops/v1 parser + validator.
 *
 * Pure function — no DB, no HTTP. Walks a validated OpsEnvelope in order,
 * builds the @local-ref namespace, and produces a fully-resolved OpsPlan
 * where every source/target on an edge is either:
 *   - a preallocated ULID (for @local refs defined earlier in this batch), or
 *   - a bare ULID (for GlobalRefs that reference existing entities).
 *
 * Errors are collected with op_index so the caller can return an LLM-actionable
 * response. The parser fails fast per-error-type to keep messages focused:
 * if an @ref is undefined, the response names THAT ref, not a cascade.
 */
import { generateUlid } from "./ids";
import {
  ENTITY_OP_RESERVED_KEYS,
  RELATE_OP_RESERVED_KEYS,
  isLocalRef,
  normalizeGlobalRef,
  type EntityOp,
  type OpsDefaults,
  type OpsEnvelope,
  type RelateOp,
  type MergeOp,
} from "./ops-schema";
import { deepMergeObjects } from "./properties";
import type { PermissionGrant } from "./entities";

// ---------------------------------------------------------------------------
// Plan shape — what the executor consumes
// ---------------------------------------------------------------------------

export interface PlannedEntity {
  /** Zero-based op_index in the original envelope — used for diagnostic errors. */
  op_index: number;
  /** The @local ref from the request, e.g. "@jane". */
  local_ref: string;
  /** Preallocated ULID — the entity will be inserted with this id (overwritten for upserts). */
  id: string;
  type: string;
  /** label extracted from properties for echo-back; may be null. */
  label: string | null;
  /** Everything from the op beyond reserved keys. */
  properties: Record<string, unknown>;
  read_level: number | null;
  write_level: number | null;
  space_id: string | null;
  permissions: PermissionGrant[];
  /**
   * Set when upsert_on is active and this entity has a label + space_id.
   * Used by the executor to look up existing entities pre-flight.
   * Key format: `type|lower(label)` for Map lookups.
   */
  upsert_key: string | null;
  /** Set by the executor after pre-flight lookup when an existing entity matches. */
  is_upsert?: boolean;
  /** The existing entity's version, set by executor for CAS on upsert UPDATE. */
  existing_ver?: number;
  /** The existing entity's properties, set by executor for accumulate-mode merging. */
  existing_properties?: Record<string, unknown>;
}

export interface PlannedEdge {
  /** Zero-based op_index in the original envelope — used for diagnostic errors. */
  op_index: number;
  /** Preallocated ULID for the relationship entity. */
  id: string;
  /** Either a ULID (from a global ref) or a ULID that will exist post-commit (from @local ref). */
  source_id: string;
  target_id: string;
  /** True if source refers to an entity being created in THIS batch (vs. a pre-existing entity). */
  source_is_local: boolean;
  target_is_local: boolean;
  predicate: string;
  properties: Record<string, unknown>;
  read_level: number | null;
  write_level: number | null;
  space_id: string | null;
  permissions: PermissionGrant[];
}

export interface PlannedMerge {
  op_index: number;
  target_id: string;
  source_ids: string[];
}

export interface OpsPlan {
  entities: PlannedEntity[];
  edges: PlannedEdge[];
  merges: PlannedMerge[];
  /** Global ULIDs referenced by edges — need an existence + read-visibility check before execute. */
  referenced_global_ids: Set<string>;
  /** True when upsert_on is set in defaults — signals executor to run pre-flight upsert lookup. */
  upsert_active: boolean;
  /** Controls how properties are merged on upsert: "accumulate" deep-merges, "replace" overwrites. */
  upsert_mode: "accumulate" | "replace";
}

// ---------------------------------------------------------------------------
// Error shape
// ---------------------------------------------------------------------------

export type OpsErrorCode =
  | "unresolved_ref"
  | "invalid_ref_format"
  | "duplicate_ref"
  | "self_reference"
  | "missing_required_field"
  | "invalid_classification";

export interface OpsParseError {
  op_index: number;
  code: OpsErrorCode;
  field: string;
  message: string;
  fix: string;
  offending_value?: string;
}

export interface ParseResult {
  plan: OpsPlan | null;
  errors: OpsParseError[];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function parseOps(envelope: OpsEnvelope): ParseResult {
  const errors: OpsParseError[] = [];
  const entities: PlannedEntity[] = [];
  const edges: PlannedEdge[] = [];
  const merges: PlannedMerge[] = [];
  const referenced_global_ids = new Set<string>();

  /** @local ref → preallocated ULID */
  const localRefs = new Map<string, string>();
  const defaults = envelope.defaults ?? {};
  const upsertActive = !!(defaults.upsert_on?.includes("label") && defaults.upsert_on?.includes("type"));

  /**
   * Within-batch dedup: when upsert_on is active, two entity ops with the
   * same (type, lower(label)) within the same space merge into one. The
   * second op's properties are shallow-merged into the first, and its @local
   * ref is aliased to the first entity's preallocated ULID.
   *
   * Key: `type|lower(label)|space_id`
   */
  const batchDedup = upsertActive ? new Map<string, PlannedEntity>() : null;

  envelope.ops.forEach((op, op_index) => {
    if (op.op === "entity") {
      processEntityOp(op, op_index, defaults, localRefs, entities, errors, upsertActive, batchDedup);
    } else if (op.op === "relate") {
      processRelateOp(
        op,
        op_index,
        defaults,
        localRefs,
        edges,
        referenced_global_ids,
        errors,
      );
    } else if (op.op === "merge") {
      processMergeOp(op as MergeOp, op_index, localRefs, merges, referenced_global_ids, errors);
    }
  });

  if (errors.length > 0) {
    return { plan: null, errors };
  }

  return {
    plan: { entities, edges, merges, referenced_global_ids, upsert_active: upsertActive, upsert_mode: defaults.upsert_mode ?? "accumulate" },
    errors: [],
  };
}

// ---------------------------------------------------------------------------
// Per-op handlers
// ---------------------------------------------------------------------------

function processEntityOp(
  op: EntityOp,
  op_index: number,
  defaults: OpsDefaults,
  localRefs: Map<string, string>,
  entities: PlannedEntity[],
  errors: OpsParseError[],
  upsertActive: boolean,
  batchDedup: Map<string, PlannedEntity> | null,
): void {
  // Duplicate ref in the same batch
  if (localRefs.has(op.ref)) {
    errors.push({
      op_index,
      code: "duplicate_ref",
      field: "ref",
      message: `Op #${op_index} defines ref '${op.ref}', but that ref was already defined by an earlier entity op in this batch.`,
      fix: `Each @local ref must be unique within a single request. Rename this entity's ref (e.g. '${op.ref}_2') or remove the duplicate op.`,
      offending_value: op.ref,
    });
    return;
  }

  const properties = collectPassthroughProperties(op, ENTITY_OP_RESERVED_KEYS);
  const label = extractLabel(properties);
  const spaceId = op.space_id ?? defaults.space_id ?? null;

  // Within-batch dedup: if upsert is active and we have a label + space,
  // check if an earlier op in this batch already covers the same (type, label).
  // If so, merge properties into the earlier entity and alias this ref to it.
  if (upsertActive && batchDedup && label && spaceId) {
    const dedupKey = `${op.type}|${label.toLowerCase()}|${spaceId}`;
    const existing = batchDedup.get(dedupKey);
    if (existing) {
      // Merge properties according to upsert_mode
      const upsertMode = defaults.upsert_mode ?? "accumulate";
      if (upsertMode === "accumulate") {
        existing.properties = deepMergeObjects(existing.properties, properties);
      } else {
        Object.assign(existing.properties, properties);
      }
      existing.label = label; // update to latest casing
      // Alias this ref to the existing entity's ULID
      localRefs.set(op.ref, existing.id);
      return;
    }
  }

  const id = generateUlid();

  // Build the upsert key for cross-batch matching (executor will use it)
  let upsertKey: string | null = null;
  if (upsertActive && label && spaceId) {
    upsertKey = `${op.type}|${label.toLowerCase()}`;
  }

  localRefs.set(op.ref, id);
  const entity: PlannedEntity = {
    op_index,
    local_ref: op.ref,
    id,
    type: op.type,
    label,
    properties,
    read_level: op.read_level ?? defaults.read_level ?? null,
    write_level: op.write_level ?? defaults.write_level ?? null,
    space_id: spaceId,
    permissions: op.permissions ?? defaults.permissions ?? [],
    upsert_key: upsertKey,
  };
  entities.push(entity);

  // Register in batch dedup map so later ops with same (type, label) merge here
  if (upsertActive && batchDedup && upsertKey) {
    batchDedup.set(`${op.type}|${label!.toLowerCase()}|${spaceId}`, entity);
  }
}

function processRelateOp(
  op: RelateOp,
  op_index: number,
  defaults: OpsDefaults,
  localRefs: Map<string, string>,
  edges: PlannedEdge[],
  referenced_global_ids: Set<string>,
  errors: OpsParseError[],
): void {
  const resolvedSource = resolveRef(op.source, "source", op_index, localRefs, referenced_global_ids, errors);
  const resolvedTarget = resolveRef(op.target, "target", op_index, localRefs, referenced_global_ids, errors);

  if (!resolvedSource || !resolvedTarget) {
    // Errors already pushed
    return;
  }

  if (resolvedSource.id === resolvedTarget.id) {
    errors.push({
      op_index,
      code: "self_reference",
      field: "target",
      message: `Op #${op_index} has source and target resolving to the same entity (${resolvedSource.id}).`,
      fix: "A relationship cannot connect an entity to itself in a single op. Use two different entities.",
      offending_value: resolvedSource.id,
    });
    return;
  }

  const properties = collectPassthroughProperties(op, RELATE_OP_RESERVED_KEYS);

  edges.push({
    op_index,
    id: generateUlid(),
    source_id: resolvedSource.id,
    target_id: resolvedTarget.id,
    source_is_local: resolvedSource.local,
    target_is_local: resolvedTarget.local,
    predicate: op.predicate,
    properties,
    read_level: op.read_level ?? defaults.read_level ?? null,
    write_level: op.write_level ?? defaults.write_level ?? null,
    space_id: op.space_id ?? defaults.space_id ?? null,
    permissions: op.permissions ?? defaults.permissions ?? [],
  });
}

function processMergeOp(
  op: MergeOp,
  op_index: number,
  localRefs: Map<string, string>,
  merges: PlannedMerge[],
  referenced_global_ids: Set<string>,
  errors: OpsParseError[],
): void {
  // Resolve target ref
  const resolvedTarget = resolveRef(op.target, "target", op_index, localRefs, referenced_global_ids, errors);
  if (!resolvedTarget) return;

  // Resolve source refs
  const sourceIds: string[] = [];
  for (const source of op.sources) {
    const resolved = resolveRef(source, "sources", op_index, localRefs, referenced_global_ids, errors);
    if (!resolved) return;
    sourceIds.push(resolved.id);
  }

  merges.push({ op_index, target_id: resolvedTarget.id, source_ids: sourceIds });
}

// ---------------------------------------------------------------------------
// Ref resolution
// ---------------------------------------------------------------------------

function resolveRef(
  ref: string,
  field: "source" | "target" | "sources",
  op_index: number,
  localRefs: Map<string, string>,
  referenced_global_ids: Set<string>,
  errors: OpsParseError[],
): { id: string; local: boolean } | null {
  if (isLocalRef(ref)) {
    const id = localRefs.get(ref);
    if (!id) {
      errors.push({
        op_index,
        code: "unresolved_ref",
        field,
        message: `Op #${op_index} references ${ref} as ${field}, but no entity op with that ref was defined earlier in this batch.`,
        fix: `Either add an entity op with ref '${ref}' BEFORE this relate op, or replace '${ref}' with the ULID of an existing entity.`,
        offending_value: ref,
      });
      return null;
    }
    return { id, local: true };
  }

  // normalizeGlobalRef uppercases the ULID (and strips any `arke:` prefix),
  // so every global ref stored in the plan is canonical uppercase. This
  // matches the DB's storage format (generateUlid() uses the Crockford
  // uppercase alphabet) and means assertGlobalRefsVisible's bulk SELECT
  // compares apples to apples without a per-row LOWER() / UPPER() cast.
  const ulid = normalizeGlobalRef(ref);
  if (!ulid) {
    errors.push({
      op_index,
      code: "invalid_ref_format",
      field,
      message: `Op #${op_index} has an invalid ${field} ref: '${ref}'.`,
      fix: "Refs must be either '@local-name' (local to this batch) or a 26-char ULID (optionally 'arke:' prefixed).",
      offending_value: ref,
    });
    return null;
  }
  referenced_global_ids.add(ulid);
  return { id: ulid, local: false };
}

// ---------------------------------------------------------------------------
// Passthrough properties
// ---------------------------------------------------------------------------

/**
 * Return everything on the op EXCEPT the reserved keys. This is the
 * "inline properties" contract — LLMs can emit any domain field and it
 * lands in properties without a schema change.
 */
function collectPassthroughProperties(
  op: Record<string, unknown>,
  reserved: Set<string>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(op)) {
    if (!reserved.has(key) && value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Pull a display label out of properties for echo-back in the response.
 * Prefers `label`, falls back to `name`. Does NOT remove it from properties —
 * it stays in the entity record as well.
 */
function extractLabel(properties: Record<string, unknown>): string | null {
  if (typeof properties.label === "string") return properties.label;
  if (typeof properties.name === "string") return properties.name;
  return null;
}
