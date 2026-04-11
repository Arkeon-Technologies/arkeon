// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Test the sandbox in isolation (no LLM needed).
 * Usage: tsx src/test-sandbox.ts
 */

import { Sandbox } from "./sandbox.js";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const workspace = mkdtempSync(join(tmpdir(), "arke-sandbox-test-"));
console.log(`Workspace: ${workspace}\n`);

const sandbox = new Sandbox({
  workspaceDir: workspace,
  env: { ARKE_API_URL: "http://localhost:8000", ARKE_API_KEY: "test_key" },
});

async function test(label: string, command: string) {
  console.log(`[test] ${label}`);
  const result = await sandbox.exec(command);
  if (result.stdout) console.log(`  stdout: ${result.stdout.trim()}`);
  if (result.stderr) console.log(`  stderr: ${result.stderr.trim()}`);
  console.log(`  exit: ${result.exitCode}\n`);
  return result;
}

// Basic exec
await test("echo", 'echo "hello from sandbox"');

// Environment variables
await test("env vars", 'echo "API: $ARKE_API_URL, Key: $ARKE_API_KEY"');

// Working directory
await test("pwd", "pwd");

// File creation
await test("write file", 'echo "hello world" > test.txt && cat test.txt');

// Package manager check
await test("node available", "node --version");
await test("python available", "python3 --version 2>&1 || echo 'no python3'");

// Persistence
await test("file persists", "cat test.txt");

// Cleanup
await test("list workspace", "ls -la");

console.log("All sandbox tests passed.");
