/**
 * Write resolved entities and relationships to the graph via the Arkeon API.
 * Also handles creating chunk entities for large-document extraction.
 *
 * All entity operations go through the SDK (HTTP API), not direct SQL.
 * This ensures activity logging, permission validation, and consistency
 * with the rest of the platform.
 */

import {
  createEntity,
  createRelationship,
  transferOwnership,
} from "../lib/arke-client";

const WRITE_CONCURRENCY = 10;

async function parallelLimit<T, R>(items: T[], fn: (item: T) => Promise<R>, limit: number): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += limit) {
    const chunk = items.slice(i, i + limit);
    const chunkResults = await Promise.all(chunk.map(fn));
    results.push(...chunkResults);
  }
  return results;
}
import type {
  CanonicalEntity,
  CanonicalRelationship,
  WriteResult,
  TextChunk,
} from "../lib/types";

export interface WriteOpts {
  spaceId?: string;
  readLevel?: number;
  writeLevel?: number;
  ownerId?: string;
  permissions?: Array<{ grantee_type: string; grantee_id: string; role: string }>;
}

export async function writeSubgraph(
  entities: CanonicalEntity[],
  relationships: CanonicalRelationship[],
  documentId: string,
  arkeId: string,
  opts?: WriteOpts,
): Promise<WriteResult> {
  const refToId: Record<string, string> = {};
  const createdEntityIds: string[] = [];
  const createdRelationshipIds: string[] = [];

  const entityResults = await parallelLimit(
    entities, async (entity) => {
      if (entity.canonical_id && /^[0-9A-Z]{26}$/i.test(entity.canonical_id)) {
        return { ref: entity.ref, id: entity.canonical_id, created: false };
      }

      try {
        // Create entity with permissions inline (atomic — entity + grants in one call)
        const id = await createEntity({
          type: entity.type,
          arke_id: arkeId,
          properties: {
            label: entity.label,
            description: entity.description,
            source_document_id: documentId,
          },
          space_id: opts?.spaceId,
          read_level: opts?.readLevel,
          write_level: opts?.writeLevel,
          permissions: opts?.permissions,
        });

        if (!id) return null;

        // Link to source document
        await createRelationship(id, {
          predicate: "derived_from",
          target_id: documentId,
          space_id: opts?.spaceId,
        }).catch(() => {});

        return { ref: entity.ref, id, created: true };
      } catch (err) {
        console.warn(`[knowledge:write] Failed to create entity "${entity.label}":`, err instanceof Error ? err.message : err);
        return null;
      }
    }, WRITE_CONCURRENCY);

  for (const result of entityResults) {
    if (!result) continue;
    refToId[result.ref] = result.id;
    if (result.created) createdEntityIds.push(result.id);
  }

  // Transfer ownership from service actor to source document's owner.
  // Uses PUT /entities/{id}/owner which handles activity logging automatically.
  if (opts?.ownerId) {
    await parallelLimit(
      createdEntityIds, (id) =>
        transferOwnership(id, opts.ownerId!).catch((err) => {
          console.warn(`[knowledge:write] Failed to transfer ownership for ${id}:`, err instanceof Error ? err.message : err);
        }),
      WRITE_CONCURRENCY,
    );
  }

  const relResults = await parallelLimit(
    relationships, async (rel) => {
      const sourceId = rel.source_id ?? refToId[rel.source_ref];
      const targetId = rel.target_id ?? refToId[rel.target_ref];
      if (!sourceId || !targetId) return null;
      if (!/^[0-9A-Z]{26}$/i.test(sourceId) || !/^[0-9A-Z]{26}$/i.test(targetId)) return null;

      try {
        const relId = await createRelationship(sourceId, {
          predicate: rel.predicate,
          target_id: targetId,
          properties: {
            source_spans: rel.source_span ? [{ text: rel.source_span }] : [],
            detail: rel.detail,
            source_document_id: documentId,
          },
          space_id: opts?.spaceId,
        });

        return relId;
      } catch (err) {
        console.warn(`[knowledge:write] Failed to create relationship ${sourceId} --[${rel.predicate}]--> ${targetId}:`, err instanceof Error ? err.message : err);
        return null;
      }
    }, WRITE_CONCURRENCY);

  for (const relId of relResults) {
    if (relId) createdRelationshipIds.push(relId);
  }

  return { createdEntityIds, createdRelationshipIds, refToId };
}

export async function writeChunkEntities(
  chunks: TextChunk[],
  parentEntityId: string,
  parentLabel: string,
  arkeId: string,
  opts?: WriteOpts,
): Promise<{ chunkIds: string[] }> {
  const results = await parallelLimit(
    chunks, async (chunk) => {
      const id = await createEntity({
        type: "text_chunk",
        arke_id: arkeId,
        space_id: opts?.spaceId,
        read_level: opts?.readLevel,
        write_level: opts?.writeLevel,
        permissions: opts?.permissions,
        properties: {
          label: `Chunk ${chunk.ordinal + 1} of ${parentLabel}`,
          text: chunk.text,
          ordinal: chunk.ordinal,
          start_offset: chunk.startOffset,
          end_offset: chunk.endOffset,
          source_document_id: parentEntityId,
        },
      });

      if (id) {
        await createRelationship(id, {
          predicate: "part_of",
          target_id: parentEntityId,
          space_id: opts?.spaceId,
        }).catch(() => {});
      }

      return id;
    }, WRITE_CONCURRENCY);

  // Transfer chunk ownership too
  if (opts?.ownerId) {
    const chunkIds = results.filter((id): id is string => !!id);
    await parallelLimit(
      chunkIds, (id) => transferOwnership(id, opts.ownerId!).catch(() => {}),
      WRITE_CONCURRENCY,
    );
  }

  return { chunkIds: results.filter((id): id is string => !!id) };
}

export async function writeChunkProvenance(
  refToId: Record<string, string>,
  refToChunkOrdinal: Map<string, number>,
  chunkIds: string[],
  spaceId?: string,
): Promise<void> {
  const entries = [...refToChunkOrdinal.entries()].filter(([ref, ord]) => {
    const eid = refToId[ref];
    const cid = chunkIds[ord];
    return eid && cid && /^[0-9A-Z]{26}$/i.test(eid) && /^[0-9A-Z]{26}$/i.test(cid);
  });

  await parallelLimit(
    entries, async ([ref, chunkOrdinal]) => {
      const entityId = refToId[ref];
      const chunkId = chunkIds[chunkOrdinal];

      try {
        await createRelationship(entityId, {
          predicate: "extracted_from",
          target_id: chunkId,
          space_id: spaceId,
        });
      } catch (err) {
        console.warn(`[knowledge:write] Failed to create provenance ${entityId} -> chunk ${chunkId}:`, err instanceof Error ? err.message : err);
      }
    }, WRITE_CONCURRENCY,
  );
}
