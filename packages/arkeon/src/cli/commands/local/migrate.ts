// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `arkeon migrate` — run schema migrations against the local Postgres
 * without starting the rest of the stack.
 *
 * Useful when iterating on migrations: edit a .sql file, run this,
 * inspect results. Starts embedded Postgres, runs migrations, stops.
 *
 * If an arkeon instance is already running, we refuse — the running
 * instance is using the Postgres data dir and we'd race on it.
 */

import type { Command } from "commander";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_PG_PORT,
  ensureArkeonDir,
  isProcessAlive,
  loadOrCreateSecrets,
  readPidfile,
  startEmbeddedPostgres,
} from "../../lib/local-runtime.js";

export function registerMigrateCommand(program: Command): void {
  program
    .command("migrate")
    .description("Run schema migrations against the local Postgres data directory")
    .option("--pg-port <port>", "Port to bind Postgres on for this run", String(DEFAULT_PG_PORT))
    .action(async (options: { pgPort: string }) => {
      const runningPid = readPidfile();
      if (runningPid && isProcessAlive(runningPid)) {
        console.error(
          `arkeon is running (pid ${runningPid}). Stop it first with \`arkeon stop\` — ` +
          `migrations can't run while the API is using the database.`,
        );
        process.exit(1);
      }

      ensureArkeonDir();
      const secrets = loadOrCreateSecrets();
      const pgPort = Number(options.pgPort);

      console.log(`[arkeon] Starting embedded Postgres on port ${pgPort}`);
      const pg = await startEmbeddedPostgres({
        port: pgPort,
        password: secrets.pgPassword,
      });

      try {
        const migratePath = findMigrateScript();
        if (!migratePath) {
          throw new Error("Could not locate packages/schema/migrate.js.");
        }

        await new Promise<void>((resolve, reject) => {
          const child = spawn(process.execPath, [migratePath], {
            stdio: "inherit",
            env: {
              ...process.env,
              MIGRATION_DATABASE_URL: pg.superUrl,
              ARKE_APP_PASSWORD: secrets.pgPassword,
            },
          });
          child.on("exit", (code) => {
            if (code === 0) resolve();
            else reject(new Error(`migrate.js exited with code ${code}`));
          });
          child.on("error", reject);
        });
      } catch (err) {
        console.error("[arkeon] migrations failed:", (err as Error).message);
        await pg.stop();
        process.exit(1);
      }

      await pg.stop();
      console.log("[arkeon] Migrations complete.");
    });
}

function findMigrateScript(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // Monorepo dev (packages/cli/src/commands/local → packages/schema/migrate.js)
    join(here, "..", "..", "..", "..", "schema", "migrate.js"),
    // Bundled CLI / published npm — schema copied into dist/schema by
    // copy-migrations.ts during the CLI build.
    join(here, "schema", "migrate.js"),
    join(here, "..", "schema", "migrate.js"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
