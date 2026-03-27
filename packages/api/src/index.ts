import "dotenv/config";
import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { ensureBootstrap } from "./lib/bootstrap";

const app = createApp();

await ensureBootstrap();

serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 8000) }, (info) => {
  console.log(`arke-api listening on http://localhost:${info.port}`);
});
