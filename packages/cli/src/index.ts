import { Command } from "commander";

import { registerAuthCommands } from "./commands/auth/index.js";
import { registerConfigCommands } from "./commands/config/index.js";
import { registerEntityContentCommands } from "./commands/entities/index.js";
import { registerApiCommands } from "./generated/index.js";

const program = new Command();

program
  .name("arkeon")
  .description("CLI for the Arkeon API")
  .version("0.1.0")
  .option("--api-url <url>", "Override API base URL for this process")
  .option("--network-id <id>", "Override default network ID for this process");

program.hook("preAction", (command) => {
  const options = command.optsWithGlobals() as { apiUrl?: string; networkId?: string };
  if (options.apiUrl) {
    process.env.ARKE_API_URL = options.apiUrl;
  }
  if (options.networkId) {
    process.env.ARKE_NETWORK_ID = options.networkId;
  }
});

registerAuthCommands(program);
registerConfigCommands(program);
registerEntityContentCommands(program);
registerApiCommands(program, { skipExisting: true });

program.parse();
