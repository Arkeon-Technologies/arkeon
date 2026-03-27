import { Command } from "commander";

import { registerAuthCommands } from "./commands/auth/index.js";
import { registerEntityContentCommands } from "./commands/entities/index.js";
import { registerApiCommands } from "./generated/index.js";

const program = new Command();

program
  .name("arke")
  .description("CLI for the Arke API")
  .version("0.1.0")
  .option("--api-url <url>", "Override API base URL for this process");

program.hook("preAction", (command) => {
  const options = command.optsWithGlobals() as { apiUrl?: string };
  if (options.apiUrl) {
    process.env.ARKE_API_URL = options.apiUrl;
  }
});

registerAuthCommands(program);
registerEntityContentCommands(program);
registerApiCommands(program, { skipExisting: true });

program.parse();
