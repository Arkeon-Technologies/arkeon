// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `arkeon rm <files/globs>` — delete document entities and their extracted children.
 *
 * Looks up document entities by source_file property, then cascade-deletes
 * all entities with extracted_from relationships pointing to them.
 */

import type { Command } from "commander";

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

async function apiFetchGet<T>(apiUrl: string, path: string, apiKey: string): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    headers: { accept: "application/json", authorization: `ApiKey ${apiKey}` },
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as
      | { error?: { message?: string } }
      | null;
    throw new Error(payload?.error?.message ?? `${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

async function apiDelete(apiUrl: string, path: string, apiKey: string): Promise<void> {
  const response = await fetch(`${apiUrl}${path}`, {
    method: "DELETE",
    headers: { authorization: `ApiKey ${apiKey}` },
  });
  if (!response.ok && response.status !== 404) {
    const payload = (await response.json().catch(() => null)) as
      | { error?: { message?: string } }
      | null;
    throw new Error(payload?.error?.message ?? `${response.status} ${response.statusText}`);
  }
}

async function findDocBySourceFile(
  apiUrl: string,
  apiKey: string,
  spaceId: string,
  sourceFile: string,
): Promise<string | null> {
  const filter = `type:document,properties.source_file:${sourceFile}`;
  const resp = await apiFetchGet<ListResponse>(
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
    const resp: RelationshipsResponse = await apiFetchGet<RelationshipsResponse>(
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

export function registerRmCommand(program: Command): void {
  program
    .command("rm")
    .description("Delete document entities and their extracted children from the graph")
    .argument("<paths...>", "Source file paths to remove (matches source_file property)")
    .action(async (paths: string[]) => {
      try {
        const cwd = process.cwd();
        const state = requireRepoState(cwd);
        const actorId = state.actors.ingestor?.actor_id;
        if (!actorId) throw new Error("No ingestor actor in state. Run `arkeon init` first.");
        const apiKey = credentials.requireActorKey(actorId);

        let removedDocs = 0;
        let cascadedEntities = 0;
        const removed: Array<{ path: string; entity_id: string; cascaded: number }> = [];

        for (const sourcePath of paths) {
          const entityId = await findDocBySourceFile(state.api_url, apiKey, state.space_id, sourcePath);
          if (!entityId) {
            output.warn(`No document entity found for: ${sourcePath}`);
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
