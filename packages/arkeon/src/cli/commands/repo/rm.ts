// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `arkeon rm <files/globs>` — delete document entities and their extracted children.
 *
 * Looks up document entities by source_file property, then cascade-deletes
 * all entities with extracted_from relationships pointing to them.
 */

import type { Command } from "commander";

import { apiGet, apiDelete } from "../../lib/api-client.js";
import { credentials } from "../../lib/credentials.js";
import { output } from "../../lib/output.js";
import { requireRepoState } from "../../lib/repo-state.js";

type EntityResult = {
  id: string;
  properties: Record<string, unknown>;
};

type ListResponse = {
  entities: EntityResult[];
  cursor: string | null;
};

type RelationshipResult = {
  id: string;
  source_id: string;
};

type RelationshipsResponse = {
  relationships: RelationshipResult[];
  cursor: string | null;
};

async function findDocBySourceFile(
  apiUrl: string,
  apiKey: string,
  spaceId: string,
  sourceFile: string,
): Promise<string | null> {
  const filter = `type:document,properties.source_file:${sourceFile}`;
  const resp = await apiGet<ListResponse>(
    apiUrl,
    `/entities?filter=${encodeURIComponent(filter)}&space_id=${spaceId}&limit=1`,
    apiKey,
  );
  return resp.entities[0]?.id ?? null;
}

async function deleteDocumentAndChildren(
  apiUrl: string,
  apiKey: string,
  entityId: string,
): Promise<number> {
  let cascaded = 0;

  let cursor: string | null = null;
  for (;;) {
    const cursorParam = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
    const resp: RelationshipsResponse = await apiGet<RelationshipsResponse>(
      apiUrl,
      `/entities/${entityId}/relationships?direction=in&predicate=extracted_from&limit=200${cursorParam}`,
      apiKey,
    );

    for (const rel of resp.relationships) {
      await apiDelete(apiUrl, `/entities/${rel.source_id}`, apiKey);
      cascaded++;
    }

    cursor = resp.cursor;
    if (!cursor) break;
  }

  await apiDelete(apiUrl, `/entities/${entityId}`, apiKey);
  return cascaded;
}

async function countExtractedChildren(
  apiUrl: string,
  apiKey: string,
  entityId: string,
): Promise<number> {
  let count = 0;
  let cursor: string | null = null;
  for (;;) {
    const cursorParam = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
    const resp: RelationshipsResponse = await apiGet<RelationshipsResponse>(
      apiUrl,
      `/entities/${entityId}/relationships?direction=in&predicate=extracted_from&limit=200${cursorParam}`,
      apiKey,
    );
    count += resp.relationships.length;
    cursor = resp.cursor;
    if (!cursor) break;
  }
  return count;
}

export function registerRmCommand(program: Command): void {
  program
    .command("rm")
    .description("Delete document entities and their extracted children from the graph")
    .argument("<paths...>", "Source file paths to remove (matches source_file property)")
    .option("--dry-run", "Show what would be deleted without actually deleting")
    .action(async (paths: string[], opts: { dryRun?: boolean }) => {
      try {
        const cwd = process.cwd();
        const state = requireRepoState(cwd);
        const actorId = state.actors.ingestor?.actor_id;
        if (!actorId) throw new Error("No ingestor actor in state. Run `arkeon init` first.");
        const apiKey = credentials.requireActorKey(actorId);
        const dryRun = opts.dryRun ?? false;

        if (dryRun) output.progress("(dry run — no changes will be made)");

        let removedDocs = 0;
        let cascadedEntities = 0;
        const removed: Array<{ path: string; entity_id: string; cascaded: number }> = [];

        for (const sourcePath of paths) {
          const entityId = await findDocBySourceFile(state.api_url, apiKey, state.space_id, sourcePath);
          if (!entityId) {
            output.warn(`No document entity found for: ${sourcePath}`);
            continue;
          }

          if (dryRun) {
            // Count children without deleting
            const rels = await countExtractedChildren(state.api_url, apiKey, entityId);
            output.progress(`  - ${sourcePath} (${entityId}) — would delete ${rels} extracted entities`);
            removed.push({ path: sourcePath, entity_id: entityId, cascaded: rels });
            removedDocs++;
            cascadedEntities += rels;
            continue;
          }

          output.progress(`  - ${sourcePath} (${entityId})`);
          const cascaded = await deleteDocumentAndChildren(state.api_url, apiKey, entityId);
          if (cascaded > 0) {
            output.progress(`    (deleted ${cascaded} extracted entities)`);
          }

          removed.push({ path: sourcePath, entity_id: entityId, cascaded });
          removedDocs++;
          cascadedEntities += cascaded;
        }

        output.result({
          operation: "rm",
          dry_run: dryRun,
          removed: removedDocs,
          cascaded_entities: cascadedEntities,
          documents: removed,
        });
      } catch (error) {
        output.error(error, { operation: "rm" });
        process.exitCode = 1;
      }
    });
}
