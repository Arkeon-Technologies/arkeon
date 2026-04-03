import Conf from "conf";

type ConfigSchema = {
  apiUrl: string;
  arkeId?: string;
  spaceId?: string;
};

const DEFAULT_API_URL = "https://arke-api.nick-chimicles-professional.workers.dev";
const LEGACY_API_URL = "https://api.arke.institute";

const store = new Conf<ConfigSchema>({
  projectName: "arkeon-cli",
  configName: "config",
  defaults: {
    apiUrl: DEFAULT_API_URL,
  },
});

export const config = {
  get<K extends keyof ConfigSchema>(key: K): ConfigSchema[K] {
    if (key === "apiUrl" && process.env.ARKE_API_URL) {
      return process.env.ARKE_API_URL as ConfigSchema[K];
    }
    if (key === "arkeId" && process.env.ARKE_ID) {
      return process.env.ARKE_ID as ConfigSchema[K];
    }
    if (key === "spaceId" && process.env.ARKE_SPACE_ID) {
      return process.env.ARKE_SPACE_ID as ConfigSchema[K];
    }
    const value = store.get(key);
    if (key === "apiUrl" && value === LEGACY_API_URL) {
      return DEFAULT_API_URL as ConfigSchema[K];
    }
    return value;
  },

  set<K extends keyof ConfigSchema>(key: K, value: ConfigSchema[K]): void {
    store.set(key, value);
  },

  delete<K extends keyof ConfigSchema>(key: K): void {
    store.delete(key);
  },

  path(): string {
    return store.path;
  },
};
