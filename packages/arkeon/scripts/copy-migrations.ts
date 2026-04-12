// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Copies packages/schema → packages/cli/dist/schema at CLI build time.
 *
 * Runs as part of `npm run build -w packages/cli` (see the
 * `bundle-migrations` script). The copied files ship inside the
 * published `arkeon` npm tarball so `findMigrateScript()` in
 * `commands/local/start.ts` can locate migrate.js + the .sql files
 * from within a global install, without requiring
 * `@arkeon-technologies/schema` to be a published package.
 *
 * Mirrors the shape of copy-explorer.ts — intentionally dumb so the
 * file movement is obvious when reviewing builds.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = join(here, "..");
const schemaSource = join(cliRoot, "..", "schema");
const target = join(cliRoot, "dist", "schema");

if (!existsSync(schemaSource)) {
  console.error(
    `[copy-migrations] schema source not found at ${schemaSource}. ` +
    `Is the CLI build running from inside the monorepo?`,
  );
  process.exit(1);
}

// Ensure the target's parent (dist/) exists; create the target fresh
// so removed migrations don't linger from a previous build.
mkdirSync(dirname(target), { recursive: true });
if (existsSync(target)) rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });

// Copy only the runtime-relevant files: migrate.js (the runner) and
// the numbered *.sql files (the migrations themselves). Skip test
// fixtures, README notes, package.json — none of those matter to the
// CLI at runtime, and leaving them out keeps the dist payload small.
const entries = readdirSync(schemaSource);
let copied = 0;
for (const entry of entries) {
  if (entry === "migrate.js" || entry.endsWith(".sql")) {
    cpSync(join(schemaSource, entry), join(target, entry));
    copied += 1;
  }
}

console.log(
  `[copy-migrations] copied ${copied} file(s) from ${schemaSource} → ${target}`,
);
