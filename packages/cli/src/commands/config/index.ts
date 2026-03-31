import { Command } from "commander";

import { config } from "../../lib/config.js";
import { output } from "../../lib/output.js";

export function registerConfigCommands(program: Command): void {
  const configCmd = program.command("config").description("CLI configuration");

  configCmd
    .command("set-network")
    .description("Set the default network ID used when --network-id is not provided")
    .argument("<id>", "Network (arke) ULID")
    .action((id: string) => {
      config.set("networkId", id);
      output.result({
        operation: "config.set-network",
        network_id: id,
        config_path: config.path(),
      });
    });

  configCmd
    .command("get-network")
    .description("Show the current default network ID")
    .action(() => {
      const networkId = config.get("networkId");
      output.result({
        operation: "config.get-network",
        network_id: networkId ?? null,
        source: process.env.ARKE_NETWORK_ID ? "ARKE_NETWORK_ID" : networkId ? "config" : null,
        config_path: config.path(),
      });
    });

  configCmd
    .command("clear-network")
    .description("Remove the stored default network ID")
    .action(() => {
      config.delete("networkId");
      output.result({
        operation: "config.clear-network",
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
        network_id: config.get("networkId") ?? null,
        config_path: config.path(),
      });
    });
}
