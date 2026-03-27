export interface Actor {
  id: string;
  apiKeyId: string;
  keyPrefix: string;
}

export interface AppBindings {
  Variables: {
    actor: Actor | null;
    requestId: string;
  };
}
