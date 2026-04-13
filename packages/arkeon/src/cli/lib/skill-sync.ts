// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Auto-sync bundled skills on CLI version change.
 *
 * Called from the preAction hook in index.ts. On every invocation,
 * reads ~/.arkeon/skill-version. If it matches the current CLI version,
 * does nothing (~1ms). If it differs (or doesn't exist), installs skills
 * for all providers and writes the new version stamp.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { providers } from "../commands/install/providers.js";

const STAMP_FILE = "skill-version";

function stampPath(): string {
  return join(process.env.ARKEON_HOME ?? join(homedir(), ".arkeon"), STAMP_FILE);
}

export function syncSkillsIfNeeded(cliVersion: string): void {
  try {
    const path = stampPath();
    if (existsSync(path)) {
      const stamp = readFileSync(path, "utf-8").trim();
      if (stamp === cliVersion) return;
    }

    // Version changed (or first run) — install all implemented providers
    for (const provider of Object.values(providers)) {
      if (!provider.skillDir()) continue; // stub provider, not yet implemented
      try {
        provider.install();
      } catch {
        // Non-fatal — don't block CLI usage if skill install fails
      }
    }

    // Write version stamp
    const dir = process.env.ARKEON_HOME ?? join(homedir(), ".arkeon");
    mkdirSync(dir, { recursive: true });
    writeFileSync(stampPath(), cliVersion + "\n");
  } catch {
    // Never let skill sync break the CLI
  }
}
