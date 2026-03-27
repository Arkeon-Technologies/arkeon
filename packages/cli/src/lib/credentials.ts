import Conf from "conf";

export type StoredCredentials = {
  apiKey: string;
  keyPrefix: string;
  entityId?: string;
  publicKey?: string;
  privateKey?: string;
};

const store = new Conf<{ credentials?: StoredCredentials }>({
  projectName: "arke-cli",
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
      throw new AuthError("Not authenticated. Run `arke auth register` or `arke auth set-api-key <key>`.");
    }
    return key;
  },

  path(): string {
    return store.path;
  },
};
