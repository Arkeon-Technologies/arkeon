export interface Actor {
  id: string;
  apiKeyId: string;
  keyPrefix: string;
  label: string | null;
  arkeId: string | null;
  maxReadLevel: number;
  maxWriteLevel: number;
  isAdmin: boolean;
  canPublishPublic: boolean;
}

export interface AppBindings {
  Variables: {
    actor: Actor | null;
    requestId: string;
  };
}
