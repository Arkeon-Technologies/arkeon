// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `arkeon status` — report whether the local stack is running, what
 * port the API is on, and whether /health is responding.
 *
 * Exit codes:
 *   0  — running and healthy
 *   1  — running but unhealthy (e.g. stopped responding)
 *   2  — not running
 */

import type { Command } from "commander";

import {
  arkeonDir,
  DEFAULT_API_PORT,
  isProcessAlive,
  readPidfile,
  removePidfile,
} from "../../lib/local-runtime.js";

export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description("Show the status of the local Arkeon stack")
    .option("--port <port>", "API port to probe (defaults to the configured port)", String(DEFAULT_API_PORT))
    .action(async (options: { port: string }) => {
      const pid = readPidfile();
      if (!pid) {
        console.log("arkeon: not running");
        console.log(`  state dir: ${arkeonDir()}`);
        process.exit(2);
      }

      if (!isProcessAlive(pid)) {
        console.log(`arkeon: not running (stale pidfile for pid ${pid})`);
        removePidfile();
        process.exit(2);
      }

      const port = Number(options.port);
      const url = `http://localhost:${port}/health`;

      let healthy = false;
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3000);
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timeout);
        healthy = res.ok;
      } catch {
        healthy = false;
      }

      console.log(`arkeon: running (pid ${pid})`);
      console.log(`  API:       http://localhost:${port}`);
      console.log(`  health:    ${healthy ? "OK" : "NOT RESPONDING"}`);
      console.log(`  state dir: ${arkeonDir()}`);

      process.exit(healthy ? 0 : 1);
    });
}
