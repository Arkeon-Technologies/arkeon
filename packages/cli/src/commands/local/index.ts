// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Local-mode commands: start, stop, status, migrate, reset.
 *
 * These commands manage an Arkeon stack running on the user's machine
 * without Docker. They're the primary entry point for self-hosting and
 * for the OSS "try it in 30 seconds" path.
 *
 * The start/stop commands boot embedded Postgres and Meilisearch as
 * child processes and import the API server in-process — everything
 * lives inside one Node process, so there's no service orchestration
 * layer to learn.
 */

import { Command } from "commander";

import { registerStartCommand } from "./start.js";
import { registerStopCommand } from "./stop.js";
import { registerStatusCommand } from "./status.js";
import { registerMigrateCommand } from "./migrate.js";
import { registerResetCommand } from "./reset.js";

export function registerLocalCommands(program: Command): void {
  registerStartCommand(program);
  registerStopCommand(program);
  registerStatusCommand(program);
  registerMigrateCommand(program);
  registerResetCommand(program);
}
