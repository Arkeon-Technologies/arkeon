// Arkeon API entry point
import "dotenv/config";
import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { ensureBootstrap } from "./lib/bootstrap";
import { ensureMeiliIndex, isMeilisearchConfigured } from "./lib/meilisearch";
import { startScheduler, stopScheduler } from "./lib/scheduler";
import { initQueue, drainQueue } from "./lib/invocation-queue";

const app = createApp();

await ensureBootstrap();
await initQueue();

if (isMeilisearchConfigured()) {
  await ensureMeiliIndex();
  console.log("Meilisearch index configured");
} else {
  console.warn("[search] MEILI_URL not set — search endpoint will return 503");
}

serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 8000) }, (info) => {
  console.log(`arkeon-api listening on http://localhost:${info.port}`);
});

await startScheduler();

process.on("SIGTERM", async () => {
  await drainQueue();
  await stopScheduler();
  process.exit(0);
});

process.on("SIGINT", async () => {
  await drainQueue();
  await stopScheduler();
  process.exit(0);
});
