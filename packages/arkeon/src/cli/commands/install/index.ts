// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `arkeon install <provider>` / `arkeon uninstall <provider>`
 *
 * Installs Arkeon skills into an AI coding environment.
 * Providers: claude (now), codex, cursor (future).
 */

import type { Command } from "commander";

import { output } from "../../lib/output.js";
import { getProvider, listProviders } from "./providers.js";

export function registerInstallCommands(program: Command): void {
  program
    .command("install")
    .description("Install Arkeon skills into an AI coding environment")
    .argument("<provider>", "Target environment: claude, codex, cursor")
    .action(async (providerName: string) => {
      try {
        const provider = getProvider(providerName);
        if (!provider) {
          const names = listProviders().map((p) => p.name).join(", ");
          output.error(new Error(`Unknown provider "${providerName}". Available: ${names}`), {
            operation: "install",
          });
          process.exitCode = 1;
          return;
        }

        output.progress(`Installing Arkeon skills for ${provider.description}...`);
        const { installed, dir } = provider.install();

        if (installed.length === 0) {
          output.progress("No skills installed.");
          return;
        }

        output.result({
          operation: "install",
          provider: provider.name,
          installed,
          directory: dir,
          skills: installed.map((name) => `/${name}`),
        });
      } catch (error) {
        output.error(error, { operation: "install" });
        process.exitCode = 1;
      }
    });

  program
    .command("uninstall")
    .description("Remove Arkeon skills from an AI coding environment")
    .argument("<provider>", "Target environment: claude, codex, cursor")
    .action(async (providerName: string) => {
      try {
        const provider = getProvider(providerName);
        if (!provider) {
          const names = listProviders().map((p) => p.name).join(", ");
          output.error(new Error(`Unknown provider "${providerName}". Available: ${names}`), {
            operation: "uninstall",
          });
          process.exitCode = 1;
          return;
        }

        output.progress(`Removing Arkeon skills for ${provider.description}...`);
        const { removed } = provider.uninstall();

        if (removed.length === 0) {
          output.progress("No skills found to remove.");
          return;
        }

        output.result({
          operation: "uninstall",
          provider: provider.name,
          removed,
        });
      } catch (error) {
        output.error(error, { operation: "uninstall" });
        process.exitCode = 1;
      }
    });
}
