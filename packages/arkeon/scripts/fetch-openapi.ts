// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type OpenAPISpec = {
  openapi?: string;
  info?: {
    title?: string;
    version?: string;
  };
  paths?: Record<string, unknown>;
  components?: Record<string, unknown>;
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const outputPath = join(__dirname, "..", "spec", "openapi.snapshot.json");
const remoteUrl =
  process.env.ARKE_OPENAPI_URL ??
  "https://arke-api.nick-chimicles-professional.workers.dev/openapi.json";
const sourceMode = process.env.ARKE_OPENAPI_SOURCE ?? "local";

function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortObject);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, nested]) => [key, sortObject(nested)]),
    );
  }
  return value;
}

async function fetchFromRemote(): Promise<OpenAPISpec> {
  const response = await fetch(remoteUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch OpenAPI spec from ${remoteUrl}: ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as OpenAPISpec;
}

async function fetchFromLocalSource(): Promise<OpenAPISpec> {
  const appModuleUrl = pathToFileURL(
    join(__dirname, "..", "src", "server", "app.ts"),
  ).href;
  const { createApp } = await import(appModuleUrl);
  const app = createApp();
  return app.getOpenAPI31Document({
    openapi: "3.1.0",
    info: {
      title: "Arkeon API",
      version: "0.1.0",
    },
    servers: [{ url: "https://api.arke.institute" }],
  }) as OpenAPISpec;
}

async function main() {
  const spec = sourceMode === "local" ? await fetchFromLocalSource() : await fetchFromRemote();
  const normalized = sortObject(spec);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(normalized, null, 2)}\n`);
  console.log(`Wrote ${outputPath}`);
  console.log(`Spec title: ${spec.info?.title ?? "Unknown"}`);
  console.log(`Spec version: ${spec.info?.version ?? "Unknown"}`);
  console.log(`Path count: ${Object.keys(spec.paths ?? {}).length}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
