// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import Conf from "conf";

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
    return getEnvKey() ?? this.get()?.apiKey ?? null;
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
