import "dotenv/config";
import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { ensureBootstrap } from "./lib/bootstrap";
import { startScheduler, stopScheduler } from "./lib/scheduler";

const app = createApp();

await ensureBootstrap();

serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 8000) }, (info) => {
  console.log(`arke-api listening on http://localhost:${info.port}`);
});

await startScheduler();

process.on("SIGTERM", async () => {
  await stopScheduler();
  process.exit(0);
});

process.on("SIGINT", async () => {
  await stopScheduler();
  process.exit(0);
});
