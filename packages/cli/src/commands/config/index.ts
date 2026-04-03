import { Command } from "commander";

import { config } from "../../lib/config.js";
import { output } from "../../lib/output.js";

export function registerConfigCommands(program: Command): void {
  const configCmd = program.command("config").description("CLI configuration");

  configCmd
    .command("set-url")
    .description("Set the API URL (e.g. https://my-instance.arkeon.tech)")
    .argument("<url>", "API base URL")
    .action((url: string) => {
      config.set("apiUrl", url.replace(/\/$/, ""));
      output.result({
        operation: "config.set-url",
        api_url: config.get("apiUrl"),
        config_path: config.path(),
      });
    });

  configCmd
    .command("get-url")
    .description("Show the current API URL")
    .action(() => {
      output.result({
        operation: "config.get-url",
        api_url: config.get("apiUrl"),
        source: process.env.ARKE_API_URL ? "ARKE_API_URL" : "config",
        config_path: config.path(),
      });
    });

  configCmd
    .command("clear-url")
    .description("Reset API URL to the default")
    .action(() => {
      config.delete("apiUrl");
      output.result({
        operation: "config.clear-url",
        api_url: config.get("apiUrl"),
        config_path: config.path(),
      });
    });

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
      const arkeId = config.get("arkeId");
      output.result({
        operation: "config.show",
        api_url: config.get("apiUrl"),
        api_url_source: process.env.ARKE_API_URL ? "ARKE_API_URL" : "config",
        arke_id: arkeId ?? null,
        arke_id_source: process.env.ARKE_ID ? "ARKE_ID" : arkeId ? "config" : null,
        config_path: config.path(),
      });
    });
}
