import { Command } from "commander";

import { config } from "../../lib/config.js";
import { output } from "../../lib/output.js";

export function registerConfigCommands(program: Command): void {
  const configCmd = program.command("config").description("CLI configuration");

  configCmd
    .command("set-arke")
    .description("Set the default arke ID used when --arke-id is not provided")
    .argument("<id>", "Arke ULID")
    .action((id: string) => {
      config.set("arkeId", id);
      output.result({
        operation: "config.set-arke",
        arke_id: id,
        config_path: config.path(),
      });
    });

  configCmd
    .command("get-arke")
    .description("Show the current default arke ID")
    .action(() => {
      const arkeId = config.get("arkeId");
      output.result({
        operation: "config.get-arke",
        arke_id: arkeId ?? null,
        source: process.env.ARKE_ID ? "ARKE_ID" : arkeId ? "config" : null,
        config_path: config.path(),
      });
    });

  configCmd
    .command("clear-arke")
    .description("Remove the stored default arke ID")
    .action(() => {
      config.delete("arkeId");
      output.result({
        operation: "config.clear-arke",
        cleared: true,
        config_path: config.path(),
      });
    });

  configCmd
    .command("show")
    .description("Show all CLI configuration")
    .action(() => {
      output.result({
        operation: "config.show",
        api_url: config.get("apiUrl"),
        arke_id: config.get("arkeId") ?? null,
        config_path: config.path(),
      });
    });
}
