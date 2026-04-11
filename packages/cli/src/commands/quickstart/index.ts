// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Quickstart commands: `arkeon init`, `up`, `down`, `logs`, `status`, `seed`.
 *
 * These let a user run `npm i -g arkeon && arkeon init && arkeon up` from
 * an empty directory and end up with a working local stack — no `git clone`
 * required. The bundled docker-compose.yml, .env.example, and Genesis seed
 * envelope are inlined into dist/index.js at build time by
 * scripts/bundle-assets.ts.
 */

import { Command } from "commander";
import { createInterface } from "node:readline/promises";

import {
  DOCKER_COMPOSE_YML,
  ENV_EXAMPLE,
  GENESIS_OPS,
} from "../../generated/assets.js";
import { config } from "../../lib/config.js";
import { credentials } from "../../lib/credentials.js";
import { ApiError, apiRequest } from "../../lib/http.js";
import {
  composeExists,
  dockerCompose,
  envExists,
  generateSecrets,
  parseEnv,
  readEnv,
  renderEnv,
  waitForHealth,
  writeCompose,
  writeEnv,
} from "../../lib/local.js";
import { output } from "../../lib/output.js";
import { pendingConfig, type PendingLlmConfig } from "../../lib/pending-config.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the API base URL the local stack will be reachable at, based on
 * the .env in cwd. Returns http://localhost:${PORT} or the documented
 * default if .env is missing.
 */
function localApiUrl(env: Record<string, string>): string {
  const port = env.PORT?.trim() || "8000";
  return `http://localhost:${port}`;
}

async function prompt(
  rl: ReturnType<typeof createInterface>,
  label: string,
  options: { default?: string; required?: boolean; hint?: string } = {},
): Promise<string> {
  while (true) {
    const suffix = options.default ? ` [${options.default}]` : "";
    const hint = options.hint ? `\n  ${options.hint}\n` : "";
    const answer = (await rl.question(`${hint}${label}${suffix}: `)).trim();
    if (answer) return answer;
    if (options.default) return options.default;
    if (!options.required) return "";
    output.warn("This field is required.");
  }
}

async function collectLlmConfig(rl: ReturnType<typeof createInterface>): Promise<PendingLlmConfig | null> {
  output.progress("");
  output.progress("LLM provider configuration");
  output.progress("---------------------------");
  output.progress("The knowledge extraction pipeline needs an OpenAI-compatible LLM endpoint.");
  output.progress("This is optional — press enter at the first prompt to skip and configure later");
  output.progress("via `arkeon knowledge-config update` or PUT /knowledge/config.");
  output.progress("");

  const provider = await prompt(rl, "Provider label", {
    default: "",
    hint: "e.g. openai, anthropic, openrouter, local — free-form, no behavioral meaning",
  });

  if (!provider) {
    return null;
  }

  const base_url = await prompt(rl, "Base URL", {
    required: true,
    hint:
      "openai:     https://api.openai.com/v1\n  " +
      "anthropic:  https://api.anthropic.com/v1\n  " +
      "openrouter: https://openrouter.ai/api/v1",
  });

  const api_key = await prompt(rl, "API key", {
    required: true,
    hint: "stored locally in the CLI conf store; pushed to the API by `arkeon up`",
  });

  const model = await prompt(rl, "Model", {
    required: true,
    hint: "e.g. gpt-4.1-nano, claude-3-5-sonnet-20241022, anthropic/claude-3.5-sonnet",
  });

  return { provider, base_url, api_key, model };
}

// ---------------------------------------------------------------------------
// arkeon init
// ---------------------------------------------------------------------------

function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description("Generate .env, docker-compose.yml, and LLM provider config for a fresh local stack")
    .option("--force", "Overwrite an existing .env in cwd")
    .option("--no-llm", "Skip the interactive LLM provider prompts")
    .action(async (opts: { force?: boolean; llm?: boolean }) => {
      try {
        if (envExists() && !opts.force) {
          throw new Error(".env already exists in this directory. Re-run with --force to overwrite (this rotates all secrets).");
        }

        const secrets = generateSecrets();
        const envContent = renderEnv(ENV_EXAMPLE, secrets);
        const envPath = writeEnv(envContent);

        let composePath: string | null = null;
        let composeWritten = false;
        if (!composeExists()) {
          composePath = writeCompose(DOCKER_COMPOSE_YML);
          composeWritten = true;
        }

        let llm: PendingLlmConfig | null = null;
        if (opts.llm !== false) {
          const rl = createInterface({ input: process.stdin, output: process.stdout });
          try {
            llm = await collectLlmConfig(rl);
          } finally {
            rl.close();
          }
          if (llm) {
            pendingConfig.setLlm(llm);
          } else {
            // Make sure no stale pending state survives a re-init.
            pendingConfig.clearLlm();
          }
        }

        output.result({
          operation: "init",
          env_path: envPath,
          compose_path: composePath ?? "(already present, left untouched)",
          compose_written: composeWritten,
          api_url: localApiUrl(parseEnv(envContent)),
          admin_key_prefix: `${secrets.ADMIN_BOOTSTRAP_KEY.slice(0, 8)}...`,
          llm_pending: llm
            ? { provider: llm.provider, base_url: llm.base_url, model: llm.model }
            : null,
          next: "arkeon up",
        });
      } catch (error) {
        output.error(error, { operation: "init" });
        process.exitCode = 1;
      }
    });
}

// ---------------------------------------------------------------------------
// arkeon up
// ---------------------------------------------------------------------------

async function pushPendingLlmConfig(adminKey: string, apiUrl: string): Promise<PendingLlmConfig | null> {
  const llm = pendingConfig.getLlm();
  if (!llm) return null;

  // PUT directly with the admin key — we may not have called credentials.save
  // yet, and we want this to work even if the user has another key cached.
  const response = await fetch(`${apiUrl.replace(/\/$/, "")}/knowledge/config`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      authorization: `ApiKey ${adminKey}`,
    },
    body: JSON.stringify({
      llm: {
        default: {
          provider: llm.provider,
          base_url: llm.base_url,
          api_key: llm.api_key,
          model: llm.model,
        },
      },
    }),
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as
      | { error?: { message?: string } }
      | null;
    throw new Error(
      `Failed to push LLM config to ${apiUrl}/knowledge/config: ${response.status} ${response.statusText} — ${body?.error?.message ?? "no detail"}`,
    );
  }

  pendingConfig.clearLlm();
  return llm;
}

function registerUpCommand(program: Command): void {
  program
    .command("up")
    .description("Start the local stack via docker compose, wait for it to be healthy, and finish setup")
    .option("--build", "Force `docker compose up --build` (rebuild images)")
    .option("--timeout <seconds>", "Health-check timeout in seconds", "120")
    .action(async (opts: { build?: boolean; timeout?: string }) => {
      try {
        if (!envExists()) {
          throw new Error("No .env in cwd. Run `arkeon init` first.");
        }
        if (!composeExists()) {
          throw new Error("No docker-compose.yml in cwd. Run `arkeon init` first to write the bundled copy.");
        }

        const env = readEnv();
        if (!env.ADMIN_BOOTSTRAP_KEY) {
          throw new Error(".env is missing ADMIN_BOOTSTRAP_KEY. Run `arkeon init --force` to regenerate.");
        }

        const apiUrl = localApiUrl(env);
        const timeoutMs = (Number.parseInt(opts.timeout ?? "120", 10) || 120) * 1000;

        output.progress(`Starting docker compose stack...`);
        await dockerCompose(["up", "-d", ...(opts.build ? ["--build"] : [])]);

        output.progress(`Waiting for ${apiUrl}/health (timeout ${timeoutMs / 1000}s)...`);
        await waitForHealth(`${apiUrl}/health`, {
          timeoutMs,
          onTick: (attempt) => {
            if (attempt % 5 === 0) {
              output.progress(`  still waiting (attempt ${attempt})...`);
            }
          },
        });

        // Wire up the CLI for the user: point at the local instance and
        // store the admin bootstrap key as the active API key.
        config.set("apiUrl", apiUrl);
        credentials.save({
          apiKey: env.ADMIN_BOOTSTRAP_KEY,
          keyPrefix: env.ADMIN_BOOTSTRAP_KEY.slice(0, 8),
        });

        let pushedLlm: PendingLlmConfig | null = null;
        try {
          pushedLlm = await pushPendingLlmConfig(env.ADMIN_BOOTSTRAP_KEY, apiUrl);
        } catch (error) {
          output.warn(
            `Stack is up, but pushing the pending LLM config failed: ${(error as Error).message}. ` +
              `Re-run \`arkeon up\` later or configure manually via PUT /knowledge/config.`,
          );
        }

        output.result({
          operation: "up",
          api_url: apiUrl,
          explorer_url: `${apiUrl}/explore`,
          health_url: `${apiUrl}/health`,
          admin_key_stored: true,
          admin_key_prefix: `${env.ADMIN_BOOTSTRAP_KEY.slice(0, 8)}...`,
          llm_configured: pushedLlm
            ? { provider: pushedLlm.provider, base_url: pushedLlm.base_url, model: pushedLlm.model }
            : null,
          next: "arkeon seed   # load the bundled Genesis knowledge graph",
        });
      } catch (error) {
        output.error(error, { operation: "up" });
        process.exitCode = 1;
      }
    });
}

// ---------------------------------------------------------------------------
// arkeon down
// ---------------------------------------------------------------------------

function registerDownCommand(program: Command): void {
  program
    .command("down")
    .description("Stop the local stack via docker compose")
    .option("--volumes", "Also drop the postgres/meili/redis volumes (DESTRUCTIVE — wipes all data)")
    .action(async (opts: { volumes?: boolean }) => {
      try {
        if (!composeExists()) {
          throw new Error("No docker-compose.yml in cwd — nothing to bring down.");
        }
        await dockerCompose(["down", ...(opts.volumes ? ["-v"] : [])]);
        output.result({
          operation: "down",
          volumes_removed: Boolean(opts.volumes),
        });
      } catch (error) {
        output.error(error, { operation: "down" });
        process.exitCode = 1;
      }
    });
}

// ---------------------------------------------------------------------------
// arkeon logs
// ---------------------------------------------------------------------------

function registerLogsCommand(program: Command): void {
  program
    .command("logs [services...]")
    .description("Tail logs from one or more docker compose services (default: all)")
    .option("--no-follow", "Print existing logs and exit instead of tailing")
    .option("--tail <n>", "Number of lines to show from the end", "200")
    .action(async (services: string[], opts: { follow?: boolean; tail?: string }) => {
      try {
        if (!composeExists()) {
          throw new Error("No docker-compose.yml in cwd — nothing to tail.");
        }
        const args = ["logs", `--tail=${opts.tail ?? "200"}`];
        if (opts.follow !== false) {
          args.push("-f");
        }
        if (services.length > 0) {
          args.push(...services);
        }
        await dockerCompose(args);
      } catch (error) {
        output.error(error, { operation: "logs" });
        process.exitCode = 1;
      }
    });
}

// ---------------------------------------------------------------------------
// arkeon status
// ---------------------------------------------------------------------------

interface EntitiesListResponse {
  entities: Array<{ id: string; type?: string; properties?: Record<string, unknown> }>;
  next_cursor?: string | null;
}

interface ActorsListResponse {
  actors: Array<{ id: string; properties?: Record<string, unknown> }>;
}

interface KnowledgeConfigResponse {
  llm: Array<{ id: string; provider: string; model: string; has_key: boolean }>;
}

async function safeFetch<T>(path: string): Promise<T | null> {
  try {
    return await apiRequest<T>(path, { method: "GET", auth: "optional" });
  } catch (error) {
    if (error instanceof ApiError && (error.statusCode === 401 || error.statusCode === 403)) {
      return null;
    }
    throw error;
  }
}

async function checkSeedLoaded(): Promise<{ loaded: boolean; book_id: string | null }> {
  // The Genesis seed creates exactly one `book` entity. If we can find it,
  // assume the seed has been loaded.
  const result = await safeFetch<EntitiesListResponse>("/entities?type=book&limit=10");
  if (!result?.entities) {
    return { loaded: false, book_id: null };
  }
  const book = result.entities.find((e) => {
    const label = (e.properties?.label as string | undefined) ?? "";
    return label.toLowerCase().includes("genesis");
  });
  return { loaded: Boolean(book), book_id: book?.id ?? null };
}

async function checkDreamerConfigured(): Promise<{ configured: boolean; actor_id: string | null }> {
  const result = await safeFetch<ActorsListResponse>("/actors?limit=200");
  if (!result?.actors) {
    return { configured: false, actor_id: null };
  }
  const dreamer = result.actors.find((a) => {
    const label = ((a.properties?.label as string | undefined) ?? "").toLowerCase();
    return label.includes("dreamer");
  });
  return { configured: Boolean(dreamer), actor_id: dreamer?.id ?? null };
}

async function checkLlmProvider(): Promise<{ configured: boolean; provider: string | null; model: string | null }> {
  const result = await safeFetch<KnowledgeConfigResponse>("/knowledge/config");
  if (!result?.llm) {
    return { configured: false, provider: null, model: null };
  }
  const def = result.llm.find((c) => c.id === "default" && c.has_key);
  return {
    configured: Boolean(def),
    provider: def?.provider ?? null,
    model: def?.model ?? null,
  };
}

function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description("Report local stack health, seed state, dreamer state, and LLM provider state")
    .action(async () => {
      try {
        const env = envExists() ? readEnv() : {};
        const apiUrl = env.PORT ? localApiUrl(env) : config.get("apiUrl");

        // Probe /health and /ready directly (no auth needed) so we get a
        // clear answer regardless of which key is stored.
        let healthOk = false;
        let readyOk = false;
        try {
          const r = await fetch(`${apiUrl}/health`);
          healthOk = r.ok;
        } catch {
          /* unreachable */
        }
        try {
          const r = await fetch(`${apiUrl}/ready`);
          readyOk = r.ok;
        } catch {
          /* unreachable */
        }

        if (!healthOk) {
          output.result({
            operation: "status",
            api_url: apiUrl,
            health: "unreachable",
            ready: false,
            hint: "Run `arkeon up` to start the local stack, or `arkeon config set-url` to point at a remote instance.",
          });
          return;
        }

        // Force apiRequest to use this apiUrl for the auth-side probes,
        // even if the CLI's stored apiUrl points elsewhere.
        const previousUrl = config.get("apiUrl");
        if (apiUrl !== previousUrl) {
          process.env.ARKE_API_URL = apiUrl;
        }

        const [seed, dreamer, llm] = await Promise.all([
          checkSeedLoaded().catch(() => ({ loaded: false, book_id: null })),
          checkDreamerConfigured().catch(() => ({ configured: false, actor_id: null })),
          checkLlmProvider().catch(() => ({ configured: false, provider: null, model: null })),
        ]);

        output.result({
          operation: "status",
          api_url: apiUrl,
          health: "ok",
          ready: readyOk,
          seed_loaded: seed.loaded,
          seed_book_id: seed.book_id,
          dreamer_configured: dreamer.configured,
          dreamer_actor_id: dreamer.actor_id,
          llm_provider_configured: llm.configured,
          llm_provider: llm.provider,
          llm_model: llm.model,
        });
      } catch (error) {
        output.error(error, { operation: "status" });
        process.exitCode = 1;
      }
    });
}

// ---------------------------------------------------------------------------
// arkeon seed
// ---------------------------------------------------------------------------

interface OpsResponse {
  created?: Record<string, string>;
  entities?: Array<{ id: string }>;
  relationships?: Array<{ id: string }>;
  errors?: unknown[];
}

function registerSeedCommand(program: Command): void {
  program
    .command("seed")
    .description("Load the bundled Genesis knowledge graph (76 entities, ~220 relationships) via POST /ops")
    .option("--dry-run", "Validate the envelope and return planned IDs without writing")
    .option("--force", "Re-run even if a Genesis book entity already exists")
    .action(async (opts: { dryRun?: boolean; force?: boolean }) => {
      try {
        credentials.requireApiKey();

        if (!opts.force && !opts.dryRun) {
          const existing = await checkSeedLoaded();
          if (existing.loaded) {
            output.result({
              operation: "seed",
              skipped: true,
              reason: "Genesis book entity already exists",
              book_id: existing.book_id,
              hint: "Re-run with --force to seed again (creates duplicates — see seed README).",
            });
            return;
          }
        }

        output.progress(
          `Posting Genesis ops envelope (${GENESIS_OPS.ops.length} ops)${opts.dryRun ? " in dry-run mode" : ""}...`,
        );

        const result = await apiRequest<OpsResponse>(
          `/ops${opts.dryRun ? "?dry_run=true" : ""}`,
          {
            method: "POST",
            auth: true,
            body: JSON.stringify(GENESIS_OPS),
          },
        );

        const entityCount = result.entities?.length ?? Object.keys(result.created ?? {}).length;
        const relationshipCount = result.relationships?.length ?? 0;

        output.result({
          operation: "seed",
          dry_run: Boolean(opts.dryRun),
          entities_created: entityCount,
          relationships_created: relationshipCount,
          errors: result.errors ?? [],
          next: "arkeon entities list --type book   # see the Genesis book entity",
        });
      } catch (error) {
        output.error(error, { operation: "seed" });
        process.exitCode = 1;
      }
    });
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function registerQuickstartCommands(program: Command): void {
  registerInitCommand(program);
  registerUpCommand(program);
  registerDownCommand(program);
  registerLogsCommand(program);
  registerStatusCommand(program);
  registerSeedCommand(program);
}
