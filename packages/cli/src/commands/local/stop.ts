// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `arkeon stop` — send SIGTERM to the running arkeon process (identified
 * by the pidfile) and wait for it to exit. The running process's signal
 * handler does the actual draining of Postgres/Meili/API.
 */

import type { Command } from "commander";

import {
  isProcessAlive,
  readPidfile,
  removePidfile,
} from "../../lib/local-runtime.js";

export function registerStopCommand(program: Command): void {
  program
    .command("stop")
    .description("Stop the running Arkeon stack on this machine")
    .option("--timeout <ms>", "How long to wait for graceful shutdown before giving up", "30000")
    .action(async (options: { timeout: string }) => {
      const pid = readPidfile();
      if (!pid) {
        console.log("arkeon is not running (no pidfile).");
        return;
      }
      if (!isProcessAlive(pid)) {
        console.log(`arkeon is not running (stale pidfile for pid ${pid}).`);
        removePidfile();
        return;
      }

      console.log(`[arkeon] Stopping pid ${pid}…`);
      try {
        process.kill(pid, "SIGTERM");
      } catch (err) {
        console.error(`failed to signal pid ${pid}:`, (err as Error).message);
        process.exit(1);
      }

      const timeoutMs = Number(options.timeout);
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (!isProcessAlive(pid)) {
          removePidfile();
          console.log("[arkeon] Stopped.");
          return;
        }
        await new Promise((r) => setTimeout(r, 200));
      }

      console.error(
        `[arkeon] pid ${pid} did not exit within ${timeoutMs}ms. You may need \`kill -9 ${pid}\`.`,
      );
      process.exit(1);
    });
}
