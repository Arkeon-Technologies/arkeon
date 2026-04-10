import { Command } from "commander";

import { registerAuthCommands } from "./commands/auth/index.js";
import { registerConfigCommands } from "./commands/config/index.js";
import { registerEntityContentCommands } from "./commands/entities/index.js";
import { registerGuideCommand } from "./commands/guide/index.js";
import { registerApiCommands } from "./generated/index.js";

const program = new Command();

program
  .name("arkeon")
  .description("CLI for the Arkeon API")
  .version("0.1.4")
  .option("--api-url <url>", "Override API base URL for this process")
  .option("--space-id <id>", "Override default space ID for this process");

program.hook("preAction", (command) => {
  const options = command.optsWithGlobals() as { apiUrl?: string; spaceId?: string };
  if (options.apiUrl) {
    process.env.ARKE_API_URL = options.apiUrl;
  }
  if (options.spaceId) {
    process.env.ARKE_SPACE_ID = options.spaceId;
  }
});

registerAuthCommands(program);
registerConfigCommands(program);
registerEntityContentCommands(program);
registerGuideCommand(program);
registerApiCommands(program, { skipExisting: true });

program.parse();
