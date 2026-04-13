// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import Conf from "conf";

import { getInstanceActor, portFromUrl } from "./instances.js";
import { loadRepoState } from "./repo-state.js";

export type StoredCredentials = {
  apiKey: string;
  keyPrefix: string;
  entityId?: string;
  publicKey?: string;
  privateKey?: string;
};

export type ActorKey = {
  api_key: string;
  label: string;
};

const store = new Conf<{ credentials?: StoredCredentials; actorKeys?: Record<string, ActorKey> }>({
  projectName: "arkeon-cli",
  configName: "credentials",
});

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

function getEnvKey(): string | null {
  const key = process.env.ARKE_API_KEY?.trim();
  return key ? key : null;
}

export const credentials = {
  get(): StoredCredentials | null {
    return store.get("credentials") ?? null;
  },

  save(next: StoredCredentials): void {
    store.set("credentials", next);
  },

  clear(): void {
    store.delete("credentials");
  },

  getApiKey(): string | null {
    // 1. Explicit env override
    const envKey = getEnvKey();
    if (envKey) return envKey;

    // 2. Repo-scoped actor key (instance registry or legacy state.actors)
    const repoKey = getRepoActorKey();
    if (repoKey) return repoKey;

    // 3. Global credential store
    return this.get()?.apiKey ?? null;
  },

  getIdentity(): Pick<StoredCredentials, "publicKey" | "privateKey" | "entityId"> | null {
    const stored = this.get();
    if (!stored) {
      return null;
    }
    return {
      publicKey: stored.publicKey,
      privateKey: stored.privateKey,
      entityId: stored.entityId,
    };
  },

  requireApiKey(): string {
    const key = this.getApiKey();
    if (!key) {
      throw new AuthError("Not authenticated. Run `arkeon auth register` or `arkeon auth set-api-key <key>`.");
    }
    return key;
  },

  path(): string {
    return store.path;
  },

  saveActorKey(actorId: string, apiKey: string, label: string): void {
    const keys = store.get("actorKeys") ?? {};
    keys[actorId] = { api_key: apiKey, label };
    store.set("actorKeys", keys);
  },

  getActorKey(actorId: string): string | null {
    return store.get("actorKeys")?.[actorId]?.api_key ?? null;
  },

  requireActorKey(actorId: string): string {
    const key = this.getActorKey(actorId);
    if (!key) {
      throw new AuthError(
        `No API key found for actor ${actorId}. Run \`arkeon init\` to set up this repo.`,
      );
    }
    return key;
  },

  listActorKeys(): Record<string, ActorKey> {
    return store.get("actorKeys") ?? {};
  },

  deleteActorKey(actorId: string): void {
    const keys = store.get("actorKeys") ?? {};
    delete keys[actorId];
    store.set("actorKeys", keys);
  },
};

function getRepoActorKey(): string | null {
  const state = loadRepoState();
  if (!state) return null;

  const actorName = state.current_actor ?? "ingestor";

  // Per-repo state.actors takes priority (repo-scoped, not shared across repos)
  const repoActor = state.actors?.[actorName];
  if (repoActor) {
    const key = store.get("actorKeys")?.[repoActor.actor_id]?.api_key;
    if (key) return key;
  }

  // Fallback: instance actor registry (shared across repos on same instance)
  const port = portFromUrl(state.api_url);
  const instanceActor = getInstanceActor(port, actorName);
  if (instanceActor) {
    return store.get("actorKeys")?.[instanceActor.actor_id]?.api_key ?? null;
  }

  return null;
}
