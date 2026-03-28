export interface Actor {
  id: string;
  apiKeyId: string;
  keyPrefix: string;
  groups: string[];
}

export interface AppBindings {
  Variables: {
    actor: Actor | null;
    requestId: string;
  };
}
