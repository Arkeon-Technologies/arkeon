// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `arkeon up` — start the stack as a detached background daemon, wait
 * for /health, apply any pending LLM config, save credentials, exit.
 *
 * Shape of the flow:
 *   1. Refuse if a live daemon already owns the pidfile
 *   2. Ensure ~/.arkeon, load or generate secrets
 *   3. Spawn `arkeon start` as a detached child with stdio piped to
 *      ~/.arkeon/arkeon.log (append). The child writes the pidfile
 *      once the API is listening.
 *   4. Poll http://localhost:<port>/health with a 120s deadline.
 *      On timeout, tail the log and surface it.
 *   5. If ~/.arkeon/pending-llm.json exists, PUT it to /knowledge/config
 *      using the admin key, then clear the file.
 *   6. Save credentials so subsequent `arkeon entities list` etc. are
 *      auto-authenticated against this stack.
 *   7. Print a JSON result + exit 0; the detached child keeps running.
 */

import type { Command } from "commander";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, openSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { config } from "../../lib/config.js";
import { credentials } from "../../lib/credentials.js";
import { registerInstance } from "../../lib/instances.js";
import {
  DEFAULT_API_PORT,
  DEFAULT_MEILI_PORT,
  DEFAULT_PG_PORT,
  arkeonDir,
  clearPendingLlm,
  ensureArkeonDir,
  findCliEntry,
  isProcessAlive,
  loadOrCreateSecrets,
  logfile,
  readPendingLlm,
  readPidfile,
  removePidfile,
  type PendingLlmConfig,
} from "../../lib/local-runtime.js";
import { output } from "../../lib/output.js";

interface UpOptions {
  port?: string;
  pgPort?: string;
  meiliPort?: string;
  knowledge?: boolean;
  timeout?: string;
}

export function registerUpCommand(program: Command): void {
  program
    .command("up")
    .description("Start the Arkeon stack as a detached background daemon, wait for health, apply LLM config")
    .option("--port <port>", "API port", String(DEFAULT_API_PORT))
    .option("--pg-port <port>", "Embedded Postgres port", String(DEFAULT_PG_PORT))
    .option("--meili-port <port>", "Meilisearch port", String(DEFAULT_MEILI_PORT))
    .option(
      "--knowledge",
      "Enable the LLM knowledge extraction pipeline (requires a staged or existing LLM config)",
    )
    .option("--timeout <seconds>", "Health-check timeout in seconds", "120")
    .action(async (opts: UpOptions) => {
      try {
        await runUp(opts);
      } catch (error) {
        output.error(error, { operation: "up" });
        process.exitCode = 1;
      }
    });
}

async function runUp(opts: UpOptions): Promise<void> {
  const apiPort = Number(opts.port ?? DEFAULT_API_PORT);
  const pgPort = Number(opts.pgPort ?? DEFAULT_PG_PORT);
  const meiliPort = Number(opts.meiliPort ?? DEFAULT_MEILI_PORT);
  const timeoutMs = (Number.parseInt(opts.timeout ?? "120", 10) || 120) * 1000;

  const existingPid = readPidfile();
  if (existingPid && isProcessAlive(existingPid)) {
    throw new Error(
      `arkeon is already running (pid ${existingPid}). Use \`arkeon status\` to check, or \`arkeon down\` to stop it first.`,
    );
  }
  if (existingPid && !isProcessAlive(existingPid)) {
    // Stale pidfile from a crash or kill -9 — clean it up and continue.
    removePidfile();
  }

  ensureArkeonDir();
  const secrets = loadOrCreateSecrets();

  output.progress(`[arkeon] Starting stack in ${arkeonDir()}...`);

  // Append a boot marker so operators tailing the log can tell runs apart.
  const logPath = logfile();
  try {
    appendFileSync(logPath, `\n\n=== arkeon up ${new Date().toISOString()} ===\n`);
  } catch {
    // ignore — writePidfile later in the child will surface real issues
  }

  // Spawn `arkeon start` as a detached child. The child runs the same
  // CLI entry (either tsx on the monorepo source or node on the bundled
  // dist) so there's no version skew between the parent (this process)
  // and the daemon.
  //
  // Argument order matters: everything AFTER entry.args is consumed by
  // the arkeon command parser, so the arkeon-level --data-dir has to go
  // between the entry args and the `start` subcommand — if we put it
  // before entry.args, `npx` would interpret it as one of its own
  // flags and fail.
  const entry = findCliEntry();
  const dataDirArgs = process.env.ARKEON_HOME
    ? ["--data-dir", process.env.ARKEON_HOME]
    : [];
  const childArgs = [
    ...entry.args,
    ...dataDirArgs,
    "start",
    "--port", String(apiPort),
    "--pg-port", String(pgPort),
    "--meili-port", String(meiliPort),
  ];
  if (opts.knowledge) childArgs.push("--knowledge");

  // fd-based redirect so the child's stdout/stderr append to arkeon.log
  // without leaving a pipe open on our side. Parent can exit freely.
  const logFd = openSync(logPath, "a");

  // In monorepo-dev mode the entry is `npx tsx <path>`; npx needs a
  // package.json to resolve `tsx` from, so we have to run from the
  // project root, not from whatever cwd the user invoked us in (which
  // might be anywhere, including a directory that doesn't exist
  // from the child's perspective). Anchor to the repo root by
  // deriving it from the entry path.
  const childCwd = deriveChildCwd(entry);

  const child = spawn(entry.cmd, childArgs, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    cwd: childCwd,
    env: {
      ...process.env,
      // Explicit: let the child create its own pidfile with its own pid
      // (runStart() calls writePidfile(process.pid) after the API is
      // listening). No need to pass anything special here.
    },
  });

  child.unref();

  output.progress(`[arkeon] Daemon started (child pid ${child.pid}). Waiting for /health...`);

  // Poll /health. We can't rely on the child's pidfile existing yet —
  // start.ts writes it *after* the API is listening.
  const healthOk = await pollHealth(`http://localhost:${apiPort}/health`, timeoutMs);
  if (!healthOk) {
    const tail = safeTail(logPath, 50);
    throw new Error(
      `Timed out waiting for http://localhost:${apiPort}/health after ${timeoutMs / 1000}s.\n\n` +
      `Last log lines:\n${tail}`,
    );
  }

  // Register this instance so other commands can discover it.
  const apiUrl = `http://localhost:${apiPort}`;
  registerInstance({
    api_url: apiUrl,
    api_port: apiPort,
    arkeon_home: arkeonDir(),
    pid: child.pid!,
    started_at: new Date().toISOString(),
  });

  // Apply any pending LLM config staged by `arkeon init --llm-*`.
  let pushedLlm: PendingLlmConfig | null = null;
  try {
    pushedLlm = await pushPendingLlmConfig(secrets.adminBootstrapKey, apiUrl);
  } catch (error) {
    output.warn(
      `Stack is up, but pushing the pending LLM config failed: ${(error as Error).message}. ` +
        `Re-run \`arkeon up\` later or configure manually via \`arkeon knowledge config update\`.`,
    );
  }

  // Wire up the CLI for the user: point at the local instance and
  // store the admin bootstrap key as the active API key.
  config.set("apiUrl", apiUrl);
  credentials.save({
    apiKey: secrets.adminBootstrapKey,
    keyPrefix: secrets.adminBootstrapKey.slice(0, 8),
  });

  output.result({
    operation: "up",
    api_url: apiUrl,
    explorer_url: `${apiUrl}/explore`,
    health_url: `${apiUrl}/health`,
    ready_url: `${apiUrl}/ready`,
    admin_key_stored: true,
    admin_key_prefix: `${secrets.adminBootstrapKey.slice(0, 8)}...`,
    llm_configured: pushedLlm
      ? { provider: pushedLlm.provider, base_url: pushedLlm.base_url, model: pushedLlm.model }
      : null,
    logs_hint: "arkeon logs",
    next: "arkeon seed",
  });
}

async function pollHealth(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // still booting
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function pushPendingLlmConfig(
  adminKey: string,
  apiUrl: string,
): Promise<PendingLlmConfig | null> {
  const llm = readPendingLlm();
  if (!llm) return null;

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

  clearPendingLlm();
  return llm;
}

/**
 * Pick a cwd for the detached child that is guaranteed to work:
 *   - Monorepo dev (npx tsx <path>): use the directory containing
 *     the package.json that `tsx` belongs to — that's the workspace
 *     root a few levels up from packages/cli/src/index.ts.
 *   - Bundled dist (node <path>): use the directory holding the
 *     bundled index.js — a `package.json` sibling exists after install.
 *
 * Using the current process cwd would fail when the user invokes
 * `arkeon up` from an unrelated directory (e.g. a scratch folder
 * passed via --data-dir that has no package.json for npx to resolve
 * tsx from).
 */
function deriveChildCwd(entry: { cmd: string; args: string[] }): string {
  // The arg that points at our code is either "tsx" followed by a
  // script path (monorepo dev) or a single path (bundled).
  const scriptArg =
    entry.args[0] === "tsx" && entry.args[1] ? entry.args[1] : entry.args[0];
  if (!scriptArg) return process.cwd();

  const abs = resolve(scriptArg);
  // Walk up looking for a node_modules directory. In a workspace
  // layout, this resolves to the monorepo root (where npm hoists
  // everything), so `npx tsx` from that cwd finds the binary. In a
  // global npm install, it resolves to the install prefix.
  let dir = dirname(abs);
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, "node_modules"))) return dir;
    dir = dirname(dir);
  }
  // Fallback: first ancestor with package.json (handles edge cases
  // where node_modules is symlinked from elsewhere).
  dir = dirname(abs);
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, "package.json"))) return dir;
    dir = dirname(dir);
  }
  return process.cwd();
}

function safeTail(path: string, lines: number): string {
  try {
    if (!existsSync(path)) return "(log file not found)";
    const text = readFileSync(path, "utf-8");
    const split = text.split("\n");
    return split.slice(Math.max(0, split.length - lines)).join("\n");
  } catch (error) {
    return `(failed to read log: ${(error as Error).message})`;
  }
}
