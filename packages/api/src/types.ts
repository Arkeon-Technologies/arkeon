export interface Env {
  DATABASE_URL: string;
  ROOT_COMMONS_ID: string;
  FILES_BUCKET: R2Bucket;
  R2_ACCOUNT_ID?: string;
  R2_BUCKET_NAME?: string;
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
}

export interface Actor {
  id: string;
  apiKeyId: string;
  keyPrefix: string;
}

export interface AppBindings {
  Bindings: Env;
  Variables: {
    actor: Actor | null;
    requestId: string;
  };
}
