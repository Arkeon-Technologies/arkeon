// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Stack instance registry.
 *
 * When `arkeon up` starts a stack, it registers itself here so that
 * other commands (e.g., `arkeon init` in a different directory) can
 * discover running stacks and resolve their admin keys.
 *
 * Registry lives at ~/.arkeon/instances/<port>.json, one file per
 * running stack. Cleaned up on `arkeon down`/`arkeon stop`.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface StackInstance {
  api_url: string;
  api_port: number;
  arkeon_home: string;
  pid: number;
  started_at: string;
}

function instancesDir(): string {
  return join(homedir(), ".arkeon", "instances");
}

function instancePath(port: number): string {
  return join(instancesDir(), `${port}.json`);
}

export function registerInstance(instance: StackInstance): void {
  const dir = instancesDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(instancePath(instance.api_port), JSON.stringify(instance, null, 2) + "\n");
}

export function unregisterInstance(port: number): void {
  const path = instancePath(port);
  if (existsSync(path)) {
    rmSync(path);
  }
}

export function findInstance(apiPort: number): StackInstance | null {
  const path = instancePath(apiPort);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as StackInstance;
  } catch {
    return null;
  }
}

/**
 * Find the instance serving a given URL. Extracts the port from the URL
 * and looks up the registry.
 */
export function findInstanceByUrl(apiUrl: string): StackInstance | null {
  try {
    const url = new URL(apiUrl);
    const port = Number(url.port) || (url.protocol === "https:" ? 443 : 80);
    return findInstance(port);
  } catch {
    return null;
  }
}

/**
 * List all registered instances. Does NOT check if they're still alive —
 * callers should verify with isProcessAlive() if needed.
 */
export function listInstances(): StackInstance[] {
  const dir = instancesDir();
  if (!existsSync(dir)) return [];
  const instances: StackInstance[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    try {
      instances.push(JSON.parse(readFileSync(join(dir, file), "utf-8")) as StackInstance);
    } catch {
      // skip corrupt files
    }
  }
  return instances;
}

/**
 * Resolve the admin key for a given API URL by finding the instance's
 * ARKEON_HOME and reading its secrets.json.
 */
export function resolveAdminKeyForUrl(apiUrl: string): string | null {
  const instance = findInstanceByUrl(apiUrl);
  if (!instance) return null;
  const secretsPath = join(instance.arkeon_home, "secrets.json");
  if (!existsSync(secretsPath)) return null;
  try {
    const secrets = JSON.parse(readFileSync(secretsPath, "utf-8")) as { adminBootstrapKey?: string };
    return secrets.adminBootstrapKey ?? null;
  } catch {
    return null;
  }
}
