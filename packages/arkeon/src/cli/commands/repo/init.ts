// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `arkeon init [space-name]` — bind a repository to an Arkeon space.
 *
 * Creates an agent actor, a space, and writes .arkeon/state.json.
 * API key is stored in the global credential store, not in state.json.
 */

import type { Command } from "commander";
import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { basename, join } from "node:path";

import { credentials } from "../../lib/credentials.js";
import { resolveAdminKeyForUrl } from "../../lib/instances.js";
import { output } from "../../lib/output.js";
import { readSecrets } from "../../lib/local-runtime.js";
import { saveRepoState, stateFilePath } from "../../lib/repo-state.js";

interface InitOptions {
  apiUrl?: string;
  force?: boolean;
}

type ActorResponse = {
  actor: { id: string };
  api_key: string;
};

type SpaceResponse = {
  space: { id: string; name: string };
};

function resolveAdminKey(apiUrl: string): string {
  // 1. Env var
  const envKey = process.env.ARKE_ADMIN_KEY?.trim();
  if (envKey) return envKey;

  // 2. Instance registry — find the stack serving this URL and read its secrets
  const registryKey = resolveAdminKeyForUrl(apiUrl);
  if (registryKey) return registryKey;

  // 3. Default ARKEON_HOME secrets.json (fallback for single-stack setups)
  const secrets = readSecrets();
  if (secrets?.adminBootstrapKey) return secrets.adminBootstrapKey;

  throw new Error(
    "No admin key found for " + apiUrl + ". Set ARKE_ADMIN_KEY or start the local stack first (`arkeon up`).",
  );
}

function resolveApiUrl(flag?: string): string {
  if (flag) return flag.replace(/\/$/, "");
  if (process.env.ARKE_API_URL) return process.env.ARKE_API_URL.replace(/\/$/, "");
  return "http://localhost:8000";
}

function ensureGitignore(cwd: string): void {
  const gitignorePath = join(cwd, ".gitignore");
  const entry = ".arkeon/state.json";
  if (existsSync(gitignorePath)) {
    const content = readFileSync(gitignorePath, "utf-8");
    if (content.includes(entry)) return;
    appendFileSync(gitignorePath, `\n${entry}\n`);
  } else {
    appendFileSync(gitignorePath, `${entry}\n`);
  }
}

async function apiFetch<T>(apiUrl: string, path: string, apiKey: string, body: unknown): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `ApiKey ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as
      | { error?: { message?: string } }
      | null;
    throw new Error(payload?.error?.message ?? `${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description("Bind this repo to an Arkeon space — creates a space, an agent actor, and writes .arkeon/state.json")
    .argument("[space-name]", "Name for the space (defaults to directory name)")
    .option("--api-url <url>", "Override API base URL")
    .option("--force", "Re-initialize even if .arkeon/state.json exists")
    .action(async (spaceName: string | undefined, opts: InitOptions) => {
      try {
        const cwd = process.cwd();

        // Check if already initialized
        if (!opts.force && existsSync(stateFilePath(cwd))) {
          output.error(
            new Error(".arkeon/state.json already exists. Use --force to re-initialize."),
            { operation: "init" },
          );
          process.exitCode = 1;
          return;
        }

        const apiUrl = resolveApiUrl(opts.apiUrl);
        const adminKey = resolveAdminKey(apiUrl);
        const name = spaceName ?? basename(cwd);

        // Verify stack is reachable
        output.progress(`Connecting to ${apiUrl}...`);
        try {
          const healthResp = await fetch(`${apiUrl}/health`);
          if (!healthResp.ok) throw new Error(`Health check returned ${healthResp.status}`);
        } catch (err) {
          throw new Error(
            `Cannot reach ${apiUrl}. Is the stack running? Try \`arkeon up\` first.\n(${(err as Error).message})`,
          );
        }

        // Create agent actor
        output.progress("Creating agent actor...");
        const actorResp = await apiFetch<ActorResponse>(apiUrl, "/actors", adminKey, {
          kind: "agent",
          properties: { label: `ingestor-${name}` },
        });
        const actorId = actorResp.actor.id;
        const actorApiKey = actorResp.api_key;

        // Store key in global credential store
        credentials.saveActorKey(actorId, actorApiKey, `ingestor-${name}`);

        // Create space (using the new actor's key — actor becomes owner)
        output.progress(`Creating space "${name}"...`);
        const spaceResp = await apiFetch<SpaceResponse>(apiUrl, "/spaces", actorApiKey, {
          name,
          description: `Repository: ${name}`,
          properties: { repo_root: cwd },
        });

        // Write state file
        saveRepoState(
          {
            api_url: apiUrl,
            space_id: spaceResp.space.id,
            space_name: spaceResp.space.name,
            actors: {
              ingestor: { actor_id: actorId },
            },
            created_at: new Date().toISOString(),
          },
          cwd,
        );

        // Gitignore the state file (contains no secrets but keep it out of version control by default)
        ensureGitignore(cwd);

        output.result({
          operation: "init",
          space_id: spaceResp.space.id,
          space_name: spaceResp.space.name,
          actor_id: actorId,
          api_url: apiUrl,
          state_file: stateFilePath(cwd),
          next: "arkeon diff / arkeon add <files>",
        });
      } catch (error) {
        output.error(error, { operation: "init" });
        process.exitCode = 1;
      }
    });
}
