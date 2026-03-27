import { createApp } from "./app";
import { ensureBootstrap } from "./lib/bootstrap";
import type { Env as AppEnv } from "./types";

const app = createApp();

export default {
  async fetch(request: Request, env: AppEnv, executionCtx: ExecutionContext) {
    await ensureBootstrap(env);
    return app.fetch(request, env, executionCtx);
  },
};
