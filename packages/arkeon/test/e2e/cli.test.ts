// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * CLI integration tests for generated API commands (entities, actors, etc.)
 * and built-in commands (seed, docs).
 *
 * These test the actual CLI commands as child processes (not raw API calls),
 * catching wiring bugs between the CLI codegen layer and the API. Follows the
 * same pattern as repo-cli.test.ts.
 */

import { describe, expect, test } from "vitest";
import { execSync } from "node:child_process";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../../.env") });

const baseUrl = process.env.E2E_BASE_URL ?? "http://localhost:8000";
const adminKey = process.env.ADMIN_BOOTSTRAP_KEY ?? "ak_test_admin_key_e2e";

const CLI_ROOT = resolve(import.meta.dirname, "../..");

function arkeon(cmd: string): { ok: boolean; stdout: string; stderr: string } {
  try {
    const stdout = execSync(
      `npx tsx ${join(CLI_ROOT, "src/index.ts")} ${cmd} 2>&1`,
      {
        cwd: tmpdir(),
        env: {
          ...process.env,
          ARKE_API_URL: baseUrl,
          ARKE_API_KEY: adminKey,
          PATH: process.env.PATH,
          HOME: process.env.HOME,
        },
        timeout: 30_000,
      },
    ).toString();
    return { ok: true, stdout, stderr: "" };
  } catch (err) {
    const e = err as { stdout?: Buffer; stderr?: Buffer; message?: string };
    const output = e.stdout?.toString() ?? e.stderr?.toString() ?? e.message ?? "";
    return { ok: false, stdout: output, stderr: output };
  }
}

function parseJson(output: string): Record<string, unknown> | null {
  const match = output.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
}

describe("CLI integration — generated API commands", () => {
  // --- seed ---

  test("seed loads Genesis knowledge graph", () => {
    const result = arkeon("seed");
    expect(result.ok).toBe(true);

    const json = parseJson(result.stdout);
    expect(json).not.toBeNull();
    expect(json?.operation).toBe("seed");
    // First run creates entities, subsequent runs skip (idempotent)
    if (json?.skipped) {
      expect(json?.reason).toContain("already exists");
    } else {
      expect(json?.entities_created).toBeGreaterThan(0);
    }
  });

  test("seed is idempotent (second run skips)", () => {
    const result = arkeon("seed");
    expect(result.ok).toBe(true);

    const json = parseJson(result.stdout);
    expect(json).not.toBeNull();
    expect(json?.operation).toBe("seed");
    expect(json?.skipped).toBe(true);
  });

  // --- entities ---

  test("entities list returns entities", () => {
    const result = arkeon("entities list --raw");
    expect(result.ok).toBe(true);

    const json = parseJson(result.stdout);
    expect(json).not.toBeNull();
    expect(json).toHaveProperty("entities");
    const entities = json?.entities as unknown[];
    expect(entities.length).toBeGreaterThan(0);
  });

  test("entities list --type filters by type", () => {
    const result = arkeon("entities list --type book --raw");
    expect(result.ok).toBe(true);

    const json = parseJson(result.stdout);
    expect(json).not.toBeNull();
    const entities = json?.entities as Array<{ type: string }>;
    expect(entities.length).toBeGreaterThan(0);
    for (const entity of entities) {
      expect(entity.type).toBe("book");
    }
  });

  let createdEntityId: string | undefined;

  test("entities create creates a new entity", () => {
    const result = arkeon(
      `entities create --type person --properties '{"label":"CLI Smoke Test Person"}'`,
    );
    expect(result.ok).toBe(true);

    const json = parseJson(result.stdout);
    expect(json).not.toBeNull();

    // With --raw omitted, output.result wraps as { ok, operation, data }
    // With --raw, the raw API response is { entity: { id, ... } }
    // Without --raw, the CLI wraps in { ok, data: { entity: { id } } }
    const data = (json?.data ?? json) as Record<string, unknown>;
    const entity = (data?.entity ?? data) as Record<string, unknown>;
    const id = entity?.id as string | undefined;
    expect(id).toBeTruthy();
    createdEntityId = id;
  });

  test("entities get retrieves the created entity", () => {
    expect(createdEntityId).toBeTruthy();

    const result = arkeon(`entities get ${createdEntityId} --raw`);
    expect(result.ok).toBe(true);

    const json = parseJson(result.stdout);
    expect(json).not.toBeNull();
    // --raw returns { entity: { id, type, properties, ... } }
    const entity = (json?.entity ?? json) as Record<string, unknown>;
    expect(entity?.type).toBe("person");
    const props = entity?.properties as Record<string, unknown>;
    expect(props?.label).toBe("CLI Smoke Test Person");
  });

  // --- actors ---

  test("actors list returns actors", () => {
    const result = arkeon("actors list --raw");
    expect(result.ok).toBe(true);

    const json = parseJson(result.stdout);
    expect(json).not.toBeNull();
    expect(json).toHaveProperty("actors");
    const actors = json?.actors as unknown[];
    expect(Array.isArray(actors)).toBe(true);
    expect(actors.length).toBeGreaterThan(0);
  });

  // --- docs ---

  test("docs outputs API documentation", () => {
    const result = arkeon("docs");
    expect(result.ok).toBe(true);
    // docs prints formatted text to stdout
    expect(result.stdout.length).toBeGreaterThan(100);
  });
});
