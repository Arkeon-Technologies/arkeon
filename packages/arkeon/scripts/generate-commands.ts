// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type OpenAPISpec,
  type GeneratedField,
  type GeneratedOperation,
  parseOperations,
} from "@arkeon-technologies/shared";

const __dirname = dirname(fileURLToPath(import.meta.url));
const specPath = join(__dirname, "..", "spec", "openapi.snapshot.json");
const outputPath = join(__dirname, "..", "src", "generated", "index.ts");

function renderField(field: GeneratedField): string {
  const enumPart = field.enumValues?.length ? `, enumValues: ${JSON.stringify(field.enumValues)}` : "";
  return `{ name: ${JSON.stringify(field.name)}, description: ${JSON.stringify(field.description)}, required: ${field.required}, type: ${JSON.stringify(field.type)}${enumPart} }`;
}

function generateIndex(spec: OpenAPISpec): string {
  const operations = parseOperations(spec);
  const groups = [...new Set(operations.map((operation) => operation.group))];

  return `// AUTO-GENERATED - DO NOT EDIT
// Generated from spec/openapi.snapshot.json

import { Command } from "commander";

import { registerGeneratedGroup, type GeneratedOperation } from "../lib/generated.js";

const OPERATIONS: GeneratedOperation[] = [
${operations
  .map(
    (operation) => `  {
    operationId: ${JSON.stringify(operation.operationId)},
    group: ${JSON.stringify(operation.group)},
    action: ${JSON.stringify(operation.action)},
    method: ${JSON.stringify(operation.method)},
    path: ${JSON.stringify(operation.path)},
    summary: ${JSON.stringify(operation.summary)},
    description: ${JSON.stringify(operation.description)},
    auth: ${JSON.stringify(operation.auth)},
    pathParams: [${operation.pathParams.map(renderField).join(", ")}],
    queryParams: [${operation.queryParams.map(renderField).join(", ")}],
    bodyFields: [${operation.bodyFields.map(renderField).join(", ")}],
  }`,
  )
  .join(",\n")}
];

export function registerApiCommands(program: Command, options: { skipExisting?: boolean } = {}): void {
  for (const group of ${JSON.stringify(groups)}) {
    const existing = program.commands.find((command) => command.name() === group);
    if (existing && options.skipExisting) {
      registerGeneratedGroup(existing, OPERATIONS.filter((operation) => operation.group === group));
      continue;
    }

    if (existing) {
      registerGeneratedGroup(existing, OPERATIONS.filter((operation) => operation.group === group));
      continue;
    }

    const groupCommand = program.command(group).description(\`\${group} operations\`);
    registerGeneratedGroup(groupCommand, OPERATIONS.filter((operation) => operation.group === group));
  }
}
`;
}

function main() {
  const spec = JSON.parse(readFileSync(specPath, "utf8")) as OpenAPISpec;
  const operations = parseOperations(spec);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, generateIndex(spec));
  console.log(`Generated ${outputPath}`);
  console.log(`Generated operations: ${operations.length}`);
}

main();
