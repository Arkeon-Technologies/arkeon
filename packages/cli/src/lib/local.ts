// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Helpers for the local-instance subcommands (init/up/down/logs/status/seed).
 *
 * These deliberately do not depend on the API spec or any generated code —
 * they only manage cwd-side state (.env, docker-compose) and shell out to
 * `docker compose`. The HTTP-side helpers in lib/http.ts handle the rest.
 */

import { spawn, type SpawnOptions } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import type { PendingLlmConfig } from "./pending-config.js";

// ---------------------------------------------------------------------------
// Secret generation
// ---------------------------------------------------------------------------

/**
 * Generate the five required secrets for a fresh .env. Match the formats
 * documented in .env.example so any human reading the resulting file
 * recognizes the values.
 */
export function generateSecrets(): {
  ADMIN_BOOTSTRAP_KEY: string;
  ENCRYPTION_KEY: string;
  MEILI_MASTER_KEY: string;
  POSTGRES_PASSWORD: string;
  ARKE_APP_PASSWORD: string;
} {
  return {
    // ak_<64 hex>: matches `echo "ak_$(openssl rand -hex 32)"`
    ADMIN_BOOTSTRAP_KEY: `ak_${randomBytes(32).toString("hex")}`,
    // 64 hex chars (32 bytes) — AES-256-GCM key
    ENCRYPTION_KEY: randomBytes(32).toString("hex"),
    // 48 hex chars (24 bytes) — Meilisearch master key
    MEILI_MASTER_KEY: randomBytes(24).toString("hex"),
    // 64 hex chars — Postgres superuser password (URL-safe by construction)
    POSTGRES_PASSWORD: randomBytes(32).toString("hex"),
    // 64 hex chars — arke_app role password (URL-safe by construction)
    ARKE_APP_PASSWORD: randomBytes(32).toString("hex"),
  };
}

// ---------------------------------------------------------------------------
// .env file handling
// ---------------------------------------------------------------------------

const ENV_PATH = () => resolve(process.cwd(), ".env");
const COMPOSE_PATH = () => resolve(process.cwd(), "docker-compose.yml");

/**
 * Render a .env from the bundled .env.example template by substituting the
 * empty `KEY=` lines for the generated secret values. Preserves all comments
 * and the surrounding structure so the resulting file is still navigable by
 * a human reader.
 */
export function renderEnv(template: string, values: Record<string, string>): string {
  let out = template;
  for (const [key, value] of Object.entries(values)) {
    // Match `KEY=` (possibly with trailing whitespace) at the start of a line
    // and only when the value is empty. Don't touch keys that already have
    // a value (e.g. PORT=8000) so we don't clobber the example defaults.
    const pattern = new RegExp(`^${key}=\\s*$`, "m");
    if (!pattern.test(out)) {
      // The key is missing or already has a value — append it at the end so
      // it still ends up in the file. This protects against future edits to
      // .env.example that drop a key we depend on.
      out = `${out.trimEnd()}\n${key}=${value}\n`;
      continue;
    }
    out = out.replace(pattern, `${key}=${value}`);
  }
  return out;
}

/**
 * Parse a .env file into a flat map. Handles:
 *   - blank lines and `# comments` (skipped)
 *   - `KEY=value` and `KEY="value"` (quotes stripped)
 *   - lines without `=` (skipped, with no error)
 *
 * This is intentionally minimal — it does not implement variable expansion
 * or escape sequences. It's only used to read back values that `arkeon init`
 * or the user has written, not to fully simulate dotenv.
 */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function envExists(): boolean {
  return existsSync(ENV_PATH());
}

export function readEnv(): Record<string, string> {
  if (!envExists()) {
    return {};
  }
  return parseEnv(readFileSync(ENV_PATH(), "utf8"));
}

export function writeEnv(content: string): string {
  const path = ENV_PATH();
  writeFileSync(path, content);
  return path;
}

export function composeExists(): boolean {
  return existsSync(COMPOSE_PATH());
}

export function writeCompose(content: string): string {
  const path = COMPOSE_PATH();
  writeFileSync(path, content);
  return path;
}

// ---------------------------------------------------------------------------
// LLM flag handling (shared by `arkeon init`)
// ---------------------------------------------------------------------------

/** Raw commander options for the --llm-* flags on `arkeon init`. */
export interface InitLlmFlags {
  llmProvider?: string;
  llmBaseUrl?: string;
  llmApiKey?: string;
  llmModel?: string;
}

/**
 * Build a PendingLlmConfig from the CLI flags, or null if the caller
 * passed no LLM flags at all. Partial flag sets are an error — either
 * all four of provider/base_url/api_key/model or none. We deliberately
 * do not prompt interactively; `arkeon init` assumes a non-interactive
 * caller (deployment script or LLM agent).
 *
 * Throws Error with a message naming the missing flags on partial input,
 * or naming the offending URL on base-URL validation failure.
 */
export function buildLlmConfigFromFlags(flags: InitLlmFlags): PendingLlmConfig | null {
  const { llmProvider, llmBaseUrl, llmApiKey, llmModel } = flags;
  const provided = [llmProvider, llmBaseUrl, llmApiKey, llmModel].filter((v): v is string => Boolean(v));

  if (provided.length === 0) {
    return null;
  }
  if (provided.length < 4) {
    const missing: string[] = [];
    if (!llmProvider) missing.push("--llm-provider");
    if (!llmBaseUrl) missing.push("--llm-base-url");
    if (!llmApiKey) missing.push("--llm-api-key");
    if (!llmModel) missing.push("--llm-model");
    throw new Error(
      `Partial LLM config — all four of --llm-provider, --llm-base-url, --llm-api-key, --llm-model must be provided together. Missing: ${missing.join(", ")}.`,
    );
  }

  // URL sanity check — catch typos before they get written to the conf store
  // and cause a confusing PUT /knowledge/config failure in `arkeon up`.
  try {
    // eslint-disable-next-line no-new
    new URL(llmBaseUrl!);
  } catch {
    throw new Error(`--llm-base-url "${llmBaseUrl}" is not a valid URL.`);
  }

  return {
    provider: llmProvider!,
    base_url: llmBaseUrl!,
    api_key: llmApiKey!,
    model: llmModel!,
  };
}

// ---------------------------------------------------------------------------
// docker compose subprocess runner
// ---------------------------------------------------------------------------

/**
 * Spawn `docker compose <args...>` in cwd, inheriting stdio so the user sees
 * output as it happens. Resolves on exit-0; rejects with the exit code on
 * non-zero. Used by `arkeon up/down/logs`.
 */
export function dockerCompose(
  args: string[],
  options: { stdio?: SpawnOptions["stdio"]; env?: NodeJS.ProcessEnv } = {},
): Promise<void> {
  return new Promise((resolveProm, rejectProm) => {
    const child = spawn("docker", ["compose", ...args], {
      stdio: options.stdio ?? "inherit",
      cwd: process.cwd(),
      env: { ...process.env, ...(options.env ?? {}) },
    });

    child.on("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        rejectProm(
          new Error(
            "`docker` command not found. Install Docker Desktop (https://www.docker.com/products/docker-desktop) or your distro's docker package and try again.",
          ),
        );
        return;
      }
      rejectProm(error);
    });

    child.on("exit", (code) => {
      if (code === 0) {
        resolveProm();
        return;
      }
      rejectProm(new Error(`docker compose ${args.join(" ")} exited with code ${code ?? "null"}`));
    });
  });
}

// ---------------------------------------------------------------------------
// Health polling
// ---------------------------------------------------------------------------

export async function waitForHealth(
  url: string,
  options: { timeoutMs?: number; intervalMs?: number; onTick?: (attempt: number) => void } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const intervalMs = options.intervalMs ?? 2_000;
  const start = Date.now();
  let attempt = 0;

  while (Date.now() - start < timeoutMs) {
    attempt += 1;
    options.onTick?.(attempt);
    try {
      const response = await fetch(url, { method: "GET" });
      if (response.ok) {
        return;
      }
    } catch {
      // network error — service still booting
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  throw new Error(`Timed out waiting for ${url} after ${Math.round((Date.now() - start) / 1000)}s`);
}
