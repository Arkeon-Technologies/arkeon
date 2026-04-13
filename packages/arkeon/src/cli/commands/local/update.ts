// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `arkeon update` — check for a newer version on npm, install it, and
 * restart any running instances so the new code takes effect.
 *
 * Flow:
 *   1. `npm view arkeon version` to get the latest published version
 *   2. Compare with the running version — bail if already current
 *   3. Discover running instances via the registry
 *   4. Stop each one gracefully
 *   5. `npm install -g arkeon@latest`
 *   6. Spawn the *new* binary to `arkeon up` each instance back
 *   7. Report what happened
 */

import type { Command } from "commander";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { listInstances } from "../../lib/instances.js";
import { findCliEntry, isProcessAlive } from "../../lib/local-runtime.js";
import { output } from "../../lib/output.js";
import { isNewer } from "../../lib/version-check.js";
import { runStop } from "./stop.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function currentVersion(): string {
  // Walk up from dist/cli/commands/local/ or src/cli/commands/local/ to package.json
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8")) as { version: string };
      if (pkg.version) return pkg.version;
    } catch { /* keep walking */ }
    dir = dirname(dir);
  }
  return "0.0.0";
}

function fetchLatestVersion(): string | null {
  try {
    const raw = execFileSync("npm", ["view", "arkeon", "version", "--json"], {
      encoding: "utf-8",
      timeout: 15_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    // npm view --json wraps in quotes: "0.3.5"
    return raw.trim().replace(/^"|"$/g, "");
  } catch {
    return null;
  }
}

interface UpdateOptions {
  restart: boolean;
  force: boolean;
}

async function runUpdate(options: UpdateOptions): Promise<void> {
  const current = currentVersion();

  output.progress(`[arkeon] Current version: ${current}`);
  output.progress("[arkeon] Checking npm for latest version...");

  const latest = fetchLatestVersion();
  if (!latest) {
    output.error(new Error("Failed to check npm for latest version. Are you online?"), { operation: "update" });
    process.exitCode = 1;
    return;
  }

  if (!options.force && !isNewer(latest, current)) {
    output.result({
      operation: "update",
      state: "up_to_date",
      version: current,
      latest,
    });
    return;
  }

  output.progress(`[arkeon] Update available: ${current} -> ${latest}`);

  // Discover running instances before stopping anything
  const running = listInstances().filter((i) => isProcessAlive(i.pid));
  const willRestart = options.restart && running.length > 0;

  if (running.length > 0) {
    output.progress(`[arkeon] Found ${running.length} running instance(s): ${running.map((i) => i.name).join(", ")}`);

    // Stop all instances
    for (const inst of running) {
      output.progress(`[arkeon] Stopping instance "${inst.name}" (pid ${inst.pid})...`);
      if (inst.name === "default") {
        await runStop("stop", { timeout: "30000" });
      } else {
        await runStop("stop", { timeout: "30000", name: inst.name });
      }
    }
  }

  // Install the new version
  output.progress("[arkeon] Installing arkeon@latest...");
  try {
    execFileSync("npm", ["install", "-g", "arkeon@latest"], {
      encoding: "utf-8",
      timeout: 120_000,
      stdio: ["ignore", "pipe", "inherit"],
    });
  } catch (err) {
    output.error(
      new Error(`npm install failed: ${(err as Error).message}`),
      { operation: "update" },
    );
    process.exitCode = 1;
    return;
  }

  output.progress(`[arkeon] Updated to arkeon@${latest}`);

  // Restart instances using the NEW binary
  if (willRestart) {
    const entry = findCliEntry();

    for (const inst of running) {
      output.progress(`[arkeon] Restarting instance "${inst.name}"...`);
      try {
        const args = [...entry.args];
        if (inst.arkeon_home) {
          args.push("--data-dir", inst.arkeon_home);
        }
        args.push("up");
        if (inst.name !== "default") {
          args.push("--name", inst.name);
        }

        execFileSync(entry.cmd, args, {
          encoding: "utf-8",
          timeout: 180_000,
          stdio: "inherit",
        });
      } catch (err) {
        output.warn(
          `Failed to restart instance "${inst.name}": ${(err as Error).message}. ` +
          `Restart manually with: arkeon up${inst.name !== "default" ? ` --name ${inst.name}` : ""}`,
        );
      }
    }
  } else if (running.length > 0 && !options.restart) {
    output.progress(
      `[arkeon] ${running.length} instance(s) were stopped. Restart with: arkeon up`,
    );
  }

  output.result({
    operation: "update",
    state: "updated",
    previous_version: current,
    new_version: latest,
    instances_restarted: willRestart ? running.map((i) => i.name) : [],
    instances_stopped: !options.restart && running.length > 0 ? running.map((i) => i.name) : [],
  });
}

export function registerUpdateCommand(program: Command): void {
  program
    .command("update")
    .description("Update arkeon to the latest version on npm, restarting any running instances")
    .option("--no-restart", "Only update the package — do not restart running instances")
    .option("--force", "Update even if already on the latest version", false)
    .action(async (opts: { restart: boolean; force: boolean }) => {
      try {
        await runUpdate(opts);
      } catch (error) {
        output.error(error, { operation: "update" });
        process.exitCode = 1;
      }
    });
}
