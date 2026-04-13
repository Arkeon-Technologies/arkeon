// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * .arkeon/state.json reader/writer.
 *
 * This file lives in the repo root and binds the repo to an Arkeon space.
 * It is safe to commit — no secrets. API keys are stored in the global
 * credential store (~/.config/arkeon-cli/credentials.json).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type ActorRef = {
  actor_id: string;
};

export type RepoState = {
  api_url: string;
  space_id: string;
  space_name: string;
  actors: Record<string, ActorRef>;
  created_at: string;
};

const STATE_DIR = ".arkeon";
const STATE_FILE = "state.json";

function findStateDir(from: string): string | null {
  let dir = resolve(from);
  const root = dirname(dir);
  while (dir !== root) {
    const candidate = join(dir, STATE_DIR, STATE_FILE);
    if (existsSync(candidate)) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Check root itself
  if (existsSync(join(dir, STATE_DIR, STATE_FILE))) {
    return dir;
  }
  return null;
}

export function loadRepoState(cwd?: string): RepoState | null {
  const base = findStateDir(cwd ?? process.cwd());
  if (!base) return null;
  try {
    const raw = readFileSync(join(base, STATE_DIR, STATE_FILE), "utf-8");
    return JSON.parse(raw) as RepoState;
  } catch {
    return null;
  }
}

export function requireRepoState(cwd?: string): RepoState {
  const state = loadRepoState(cwd);
  if (!state) {
    throw new Error("No .arkeon/state.json found. Run `arkeon init` first.");
  }
  return state;
}

export function saveRepoState(state: RepoState, cwd?: string): void {
  const base = cwd ?? process.cwd();
  const dir = join(base, STATE_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, STATE_FILE), JSON.stringify(state, null, 2) + "\n");
}

export function stateFilePath(cwd?: string): string {
  return join(cwd ?? process.cwd(), STATE_DIR, STATE_FILE);
}
