/**
 * Manual test script for the agent runtime.
 *
 * Usage:
 *   LLM_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai/ \
 *   LLM_API_KEY=... \
 *   LLM_MODEL=gemini-2.0-flash \
 *   tsx src/test.ts "List the files in your workspace and create a hello.txt file"
 */

import { Agent } from "./agent.js";
import { Sandbox } from "./sandbox.js";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const baseUrl = process.env.LLM_BASE_URL;
const apiKey = process.env.LLM_API_KEY;
const model = process.env.LLM_MODEL;

if (!baseUrl || !apiKey || !model) {
  console.error(
    "Required env vars: LLM_BASE_URL, LLM_API_KEY, LLM_MODEL\n\n" +
      "Example:\n" +
      "  LLM_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai/ \\\n" +
      "  LLM_API_KEY=... \\\n" +
      "  LLM_MODEL=gemini-2.0-flash \\\n" +
      '  tsx src/test.ts "Create a hello.txt file"',
  );
  process.exit(1);
}

const prompt = process.argv[2];
if (!prompt) {
  console.error("Usage: tsx src/test.ts <prompt>");
  process.exit(1);
}

// Create a temp workspace
const workspace = mkdtempSync(join(tmpdir(), "arkeon-agent-"));
console.log(`Workspace: ${workspace}\n`);

// Test sandbox first
console.log("--- Sandbox Test ---");
const sandbox = new Sandbox({ workspaceDir: workspace });
const echoResult = await sandbox.exec('echo "sandbox works"');
console.log(`  stdout: ${echoResult.stdout.trim()}`);
console.log(`  exit: ${echoResult.exitCode}\n`);

// Run the agent
console.log("--- Agent Run ---");
const agent = new Agent({
  name: "test-agent",
  systemPrompt: [
    "You are a test agent. Be concise and efficient.",
    "",
    "## Environment",
    "You are running in an isolated sandbox with a writable workspace directory.",
    "Pre-installed tools: curl, jq, python3, arkeon (Arkeon CLI).",
    ...(process.env.ARKE_API_URL
      ? [
          "$ARKE_API_URL and $ARKE_API_KEY are set and pre-configured for the arkeon CLI.",
          'For API reference: curl -H "Authorization: ApiKey $ARKE_API_KEY" $ARKE_API_URL/llms.txt',
        ]
      : []),
    "When done, call the done tool with a summary.",
  ].join("\n"),
  llm: { baseUrl, apiKey, model },
  sandbox: {
    workspaceDir: workspace,
    env: {
      ...(process.env.ARKE_API_URL ? { ARKE_API_URL: process.env.ARKE_API_URL } : {}),
      ...(process.env.ARKE_API_KEY ? { ARKE_API_KEY: process.env.ARKE_API_KEY } : {}),
    },
  },
  onLog: (entry) => {
    const prefix = `[${entry.type}]`.padEnd(16);
    console.log(`  ${prefix} ${entry.content}`);
  },
});

const result = await agent.run(prompt);

console.log("\n--- Result ---");
console.log(`  Success: ${result.success}`);
console.log(`  Summary: ${result.summary}`);
console.log(`  Iterations: ${result.iterations}`);

// Show workspace contents
console.log("\n--- Workspace ---");
const lsResult = await sandbox.exec("ls -la");
console.log(lsResult.stdout);
