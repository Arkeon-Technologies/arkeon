// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Copies spec/openapi.snapshot.json → dist/spec/openapi.snapshot.json
 * at arkeon build time.
 *
 * Runs after `tsup` (see the `build` script in package.json) so tsup's
 * `clean: true` doesn't wipe the output. At runtime, `arkeon docs`
 * probes for a `spec/` sibling of __dirname, which lands here in the
 * published tarball.
 *
 * Same pattern as copy-schema.ts and copy-explorer.ts.
 */

import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const source = join(pkgRoot, "spec", "openapi.snapshot.json");
const targetDir = join(pkgRoot, "dist", "spec");
const target = join(targetDir, "openapi.snapshot.json");

if (!existsSync(source)) {
  console.error(
    `[copy-spec] source not found at ${source}. ` +
      `Run \`npm run fetch-spec\` first to generate the OpenAPI snapshot.`,
  );
  process.exit(1);
}

mkdirSync(targetDir, { recursive: true });
cpSync(source, target);

console.log(`[copy-spec] copied ${source} → ${target}`);
