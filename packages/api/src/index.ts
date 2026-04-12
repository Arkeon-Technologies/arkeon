// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Standalone entrypoint for the Arkeon API server.
 *
 * Loaded when the API is run directly (`npm run dev -w packages/api`,
 * the systemd unit that `arkeon start` installs in production, or the
 * CLI's `start --api-only` path). All real startup logic lives in
 * `server.ts` — this file just reads env, calls it, and wires signal
 * handling.
 */

import "dotenv/config";
import { startApi } from "./server.js";

const api = await startApi();

async function gracefulShutdown(signal: string): Promise<void> {
  console.log(`[shutdown] ${signal} received, starting graceful drain...`);
  await api.stop();
  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
