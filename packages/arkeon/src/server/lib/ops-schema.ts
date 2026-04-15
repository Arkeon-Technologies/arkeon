// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * arke.ops/v1 — batch ingestion format.
 *
 * One request, one transaction, many entities + relationships. This is the
 * canonical path for creating more than one thing at a time. Any LLM or client
 * that needs to build a subgraph should prefer this over N+M calls to
 * POST /entities + POST /entities/{id}/relationships.
 *
 * Key design points:
 *   - @local refs scope to one request only. Use ULIDs to reference existing
 *     entities from previous batches.
 *   - Every non-reserved field on an op is stored as a property. No schema
 *     changes needed to carry new metadata.
 *   - Ops run in order. Any @ref used as a relate source/target must be
 *     defined by an earlier entity op in the same batch.
 */
import { z } from "@hono/zod-openapi";

import {
  ClassificationLevel,
  UlidSchema,
} from "./schemas";
import { InlinePermissionGrant } from "./entities";

// ---------------------------------------------------------------------------
// Ref types
// ---------------------------------------------------------------------------

/** A @local ref, scoped to a single request. Must match `@[a-zA-Z0-9_.-]+`. */
export const LocalRefSchema = z
  .string()
  .regex(/^@[a-zA-Z0-9_.-]+$/, "Local refs must match @[a-zA-Z0-9_.-]+ (e.g. '@jane', '@org_acme')")
  .openapi({ example: "@jane" });

/** A bare ULID or `arke:ULID` — references an existing entity across requests. */
export const GlobalRefSchema = z
  .string()
  .regex(
    /^(arke:)?[0-9A-HJKMNP-TV-Z]{26}$/i,
    "Global refs must be a 26-char ULID, optionally prefixed with 'arke:'",
  )
  .openapi({ example: "01ARZ3NDEKTSV4RRFFQ69G5FAV" });

/** A source/target on a relate op — either @local or a ULID. */
export const OpRefSchema = z
  .union([LocalRefSchema, GlobalRefSchema])
  .describe(
    "Either an @local ref (defined by an earlier entity op in this same batch) " +
      "or a ULID referencing an existing entity. Bare ULIDs and 'arke:ULID' are equivalent.",
  );

// ---------------------------------------------------------------------------
// Op shapes
// ---------------------------------------------------------------------------

/**
 * Reserved top-level keys on an entity op. Everything else is collapsed
 * into properties at parse time. Kept in sync with EntityOpSchema below.
 */
export const ENTITY_OP_RESERVED_KEYS = new Set([
  "op",
  "ref",
  "type",
  "space_id",
  "read_level",
  "write_level",
  "permissions",
]);

/**
 * Reserved top-level keys on a relate op. Everything else is collapsed into
 * the relationship's properties at parse time.
 */
export const RELATE_OP_RESERVED_KEYS = new Set([
  "op",
  "source",
  "target",
  "predicate",
  "space_id",
  "read_level",
  "write_level",
  "permissions",
]);

export const EntityOpSchema = z
  .object({
    op: z.literal("entity"),
    ref: LocalRefSchema.describe(
      "Local ref for this entity, scoped to this request. Later ops in the same batch can reference it as source/target.",
    ),
    type: z.string().min(1).describe("Entity type (e.g. 'person', 'organization', 'event')"),
    space_id: UlidSchema.optional().describe(
      "Optional — add this entity to a space atomically. Requires contributor role or above on the space.",
    ),
    read_level: ClassificationLevel.optional().describe(
      "Optional read clearance required to see this entity. Defaults to actor's arke default.",
    ),
    write_level: ClassificationLevel.optional().describe(
      "Optional write clearance required to edit this entity. Defaults to actor's arke default.",
    ),
    permissions: z
      .array(InlinePermissionGrant)
      .optional()
      .describe("Optional — grant permissions to actors or groups atomically with creation."),
  })
  .passthrough()
  .describe(
    "Create a new entity. Any field beyond the reserved keys (op, ref, type, space_id, read_level, write_level, permissions) is stored as a property — inline label, description, and any domain-specific fields directly.",
  );

export const RelateOpSchema = z
  .object({
    op: z.literal("relate"),
    source: OpRefSchema.describe("Source of the relationship — @local ref or existing ULID."),
    target: OpRefSchema.describe("Target of the relationship — @local ref or existing ULID."),
    predicate: z
      .string()
      .min(1)
      .describe("Relationship predicate — prefer specific verbs (e.g. 'recruited', 'founded', 'reports_to') over generic ones ('relates_to')."),
    space_id: UlidSchema.optional().describe(
      "Optional — add the relationship to a space atomically.",
    ),
    read_level: ClassificationLevel.optional().describe(
      "Optional. If omitted, auto-lifts to max(source.read_level, target.read_level).",
    ),
    write_level: ClassificationLevel.optional().describe(
      "Optional. If omitted, auto-lifts to max(source.write_level, target.write_level).",
    ),
    permissions: z.array(InlinePermissionGrant).optional(),
  })
  .passthrough()
  .describe(
    "Create a relationship between two entities. Any field beyond the reserved keys (op, source, target, predicate, space_id, read_level, write_level, permissions) is stored as a property — inline 'span', 'detail', 'confidence', or any other provenance/metadata directly.",
  );

export const OpSchema = z
  .discriminatedUnion("op", [EntityOpSchema, RelateOpSchema])
  .describe("A single operation — 'entity' or 'relate'.");

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

export const MAX_OPS_PER_REQUEST = 2000;

export const UpsertOnSchema = z
  .array(z.enum(["label", "type"]))
  .min(2, "upsert_on must include both 'label' and 'type'")
  .max(2, "upsert_on must include both 'label' and 'type'")
  .refine((arr) => arr.includes("label") && arr.includes("type"), {
    message: "upsert_on must contain exactly ['label', 'type']",
  })
  .describe(
    "When set to ['label', 'type'], entity ops with matching (label, type) within the same space will update the existing entity instead of creating a duplicate. Requires space_id on the op or in defaults. Entities without a label or space are always created fresh.",
  );

export const OpsDefaultsSchema = z
  .object({
    space_id: UlidSchema.optional(),
    read_level: ClassificationLevel.optional(),
    write_level: ClassificationLevel.optional(),
    permissions: z.array(InlinePermissionGrant).optional(),
    upsert_on: UpsertOnSchema.optional(),
    upsert_mode: z.enum(["accumulate", "replace"]).default("accumulate").optional(),
  })
  .describe(
    "Defaults applied to every op that does not set them individually. Per-op values override.",
  );

export const OpsSourceSchema = z
  .object({
    entity_id: UlidSchema.describe(
      "Source document ULID. Every created entity in this batch will get an 'extracted_from' relationship to this entity. Caller must have read access on it.",
    ),
    extracted_by: z
      .record(z.string(), z.any())
      .optional()
      .describe(
        "Optional extraction metadata — e.g. { model: 'gpt-4.1', run_id: '...', at: ISO8601 }. Stored on created entities as provenance.",
      ),
  })
  .describe("Optional provenance — links every created entity back to a source document.");

export const OpsEnvelopeSchema = z
  .object({
    format: z
      .literal("arke.ops/v1")
      .describe("Format version. Current: 'arke.ops/v1'."),
    defaults: OpsDefaultsSchema.optional(),
    source: OpsSourceSchema.optional(),
    ops: z
      .array(OpSchema)
      .min(1, "ops must contain at least one operation")
      .max(MAX_OPS_PER_REQUEST, `ops must contain at most ${MAX_OPS_PER_REQUEST} operations per request — split larger batches into multiple calls`)
      .describe(
        "Ordered list of operations. Entity ops define @local refs; relate ops reference them as source/target. Each @ref must be defined by an earlier entity op in the same list.",
      ),
  })
  .openapi("OpsEnvelope");

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

export const CreatedEntityResultSchema = z
  .object({
    ref: LocalRefSchema.describe("The @local ref from the request — maps back to the original op."),
    id: UlidSchema.describe("The entity's ULID — use this in subsequent requests. For upserts, this is the existing entity's ID."),
    type: z.string(),
    label: z.string().nullable().describe("Echoed label if provided in the op, otherwise null."),
    action: z.enum(["created", "updated"]).describe("Whether this entity was newly created or updated via upsert."),
  })
  .openapi("CreatedEntityResult");

export const CreatedEdgeResultSchema = z
  .object({
    id: UlidSchema,
    source: UlidSchema,
    predicate: z.string(),
    target: UlidSchema,
  })
  .openapi("CreatedEdgeResult");

export const OpsResultSchema = z
  .object({
    format: z.literal("arke.ops/v1"),
    committed: z.boolean().describe("True if writes were persisted, false for dry_run."),
    entities: z
      .array(CreatedEntityResultSchema)
      .describe(
        "Ordered list of entities touched by this batch. Each entry maps a @local ref to a ULID (new or existing for upserts). Check the 'action' field to distinguish creates from updates.",
      ),
    created: z
      .array(CreatedEntityResultSchema)
      .optional()
      .describe("Deprecated — use 'entities' instead. Same array, included for backwards compatibility."),
    edges: z
      .array(CreatedEdgeResultSchema)
      .describe("Created relationships, with all refs resolved to ULIDs."),
    stats: z.object({
      entities: z.number().int().nonnegative(),
      edges: z.number().int().nonnegative(),
    }),
  })
  .openapi("OpsResult");

// ---------------------------------------------------------------------------
// Narrow TypeScript types (inferred from schemas)
// ---------------------------------------------------------------------------

export type LocalRef = z.infer<typeof LocalRefSchema>;
export type GlobalRef = z.infer<typeof GlobalRefSchema>;
export type OpRef = z.infer<typeof OpRefSchema>;
export type EntityOp = z.infer<typeof EntityOpSchema>;
export type RelateOp = z.infer<typeof RelateOpSchema>;
export type Op = z.infer<typeof OpSchema>;
export type OpsEnvelope = z.infer<typeof OpsEnvelopeSchema>;
export type OpsDefaults = z.infer<typeof OpsDefaultsSchema>;
export type OpsSource = z.infer<typeof OpsSourceSchema>;
export type CreatedEntityResult = z.infer<typeof CreatedEntityResultSchema>;
export type CreatedEdgeResult = z.infer<typeof CreatedEdgeResultSchema>;
export type OpsResult = z.infer<typeof OpsResultSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

/** Normalize a GlobalRef to a bare ULID (strip optional `arke:` prefix). */
export function normalizeGlobalRef(ref: string): string | null {
  const stripped = ref.startsWith("arke:") ? ref.slice(5) : ref;
  return ULID_RE.test(stripped) ? stripped.toUpperCase() : null;
}

/** True if ref is in @local form (may or may not be defined yet). */
export function isLocalRef(ref: string): boolean {
  return ref.startsWith("@");
}
