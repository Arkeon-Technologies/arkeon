// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `arkeon stop` (and its alias `arkeon down`) — send SIGTERM to the
 * running arkeon process identified by the pidfile, and wait for it to
 * exit. The running process's own signal handler drains the API,
 * stops Meilisearch, and stops embedded Postgres in the right order.
 */

import type { Command } from "commander";

import {
  isProcessAlive,
  readPidfile,
  removePidfile,
} from "../../lib/local-runtime.js";
import { output } from "../../lib/output.js";

interface StopOptions {
  timeout: string;
}

/**
 * Shared handler for `arkeon stop` and `arkeon down`. Exported so both
 * commands resolve to the same code path — users familiar with Docker
 * reach for `down`; users familiar with systemd reach for `stop`.
 */
export async function runStop(operation: "stop" | "down", options: StopOptions): Promise<void> {
  const pid = readPidfile();
  if (!pid) {
    output.result({ operation, state: "not_running", reason: "no_pidfile" });
    return;
  }
  if (!isProcessAlive(pid)) {
    removePidfile();
    output.result({ operation, state: "not_running", reason: "stale_pidfile", pid });
    return;
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
      removePidfile();
      output.result({ operation, state: "stopped", pid });
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
    .description("Stop the running Arkeon stack (SIGTERM + drain)")
    .option("--timeout <ms>", "How long to wait for graceful shutdown before giving up", "30000")
    .action(async (options: StopOptions) => {
      await runStop("stop", options);
    });
}
