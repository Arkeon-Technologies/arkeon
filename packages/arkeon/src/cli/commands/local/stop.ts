// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `arkeon stop` (and its alias `arkeon down`) — send SIGTERM to the
 * running arkeon process identified by the pidfile, and wait for it to
 * exit. The running process's own signal handler drains the API,
 * stops Meilisearch, and stops embedded Postgres in the right order.
 */

import type { Command } from "commander";

import { findInstanceByName, listInstances, unregisterInstance } from "../../lib/instances.js";
import {
  isProcessAlive,
  readPidfile,
  removePidfile,
} from "../../lib/local-runtime.js";
import { output } from "../../lib/output.js";

interface StopOptions {
  timeout: string;
  name?: string;
}

/**
 * Shared handler for `arkeon stop` and `arkeon down`. Exported so both
 * commands resolve to the same code path — users familiar with Docker
 * reach for `down`; users familiar with systemd reach for `stop`.
 */
export async function runStop(operation: "stop" | "down", options: StopOptions): Promise<void> {
  let pid: number | null;
  let instancePort: number | null = null;

  if (options.name) {
    // Stop a named instance via the registry
    const instance = findInstanceByName(options.name);
    if (!instance) {
      output.error(new Error(`No instance named "${options.name}" found.`), { operation });
      process.exitCode = 1;
      return;
    }
    pid = instance.pid;
    instancePort = instance.api_port;

    if (!isProcessAlive(pid)) {
      unregisterInstance(instancePort);
      output.result({ operation, state: "not_running", name: options.name, reason: "stale_entry", pid });
      return;
    }
  } else {
    // Stop the default instance via pidfile
    pid = readPidfile();
    if (!pid) {
      output.result({ operation, state: "not_running", reason: "no_pidfile" });
      return;
    }
    if (!isProcessAlive(pid)) {
      removePidfile();
      output.result({ operation, state: "not_running", reason: "stale_pidfile", pid });
      return;
    }
  }

  output.progress(`[arkeon] Stopping pid ${pid}…`);
  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    output.error(err, { operation });
    process.exit(1);
  }

  const timeoutMs = Number(options.timeout);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      if (options.name) {
        // Named instance — clean up registry
        if (instancePort) unregisterInstance(instancePort);
      } else {
        // Default instance — clean up pidfile + registry
        removePidfile();
        for (const inst of listInstances()) {
          if (inst.pid === pid) unregisterInstance(inst.api_port);
        }
      }
      output.result({ operation, state: "stopped", pid, ...(options.name ? { name: options.name } : {}) });
      return;
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  output.error(
    new Error(
      `pid ${pid} did not exit within ${timeoutMs}ms. You may need \`kill -9 ${pid}\`.`,
    ),
    { operation },
  );
  process.exit(1);
}

export function registerStopCommand(program: Command): void {
  program
    .command("stop")
    .description("Stop an Arkeon instance")
    .argument("[name]", "Instance name to stop (default: stop the default instance)")
    .option("--timeout <ms>", "How long to wait for graceful shutdown before giving up", "30000")
    .action(async (name: string | undefined, options: { timeout: string }) => {
      await runStop("stop", { ...options, name });
    });
}
