// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `arkeon down` — alias for `arkeon stop`. Both exist so users familiar
 * with Docker's `docker compose down` and users familiar with systemd
 * `systemctl stop` each find the command they expect in --help.
 *
 * Shares all logic with stop.ts via the exported runStop handler.
 */

import type { Command } from "commander";

import { runStop } from "./stop.js";

export function registerDownCommand(program: Command): void {
  program
    .command("down")
    .description("Stop the running Arkeon stack (alias for `arkeon stop`)")
    .option("--timeout <ms>", "How long to wait for graceful shutdown before giving up", "30000")
    .action(async (options: { timeout: string }) => {
      await runStop("down", options);
    });
}
