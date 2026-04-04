// Arkeon API entry point
import "dotenv/config";
import { serve } from "@hono/node-server";
import { createApp, openApiConfig } from "./app";
import { ensureBootstrap } from "./lib/bootstrap";
import { ensureMeiliIndex, isMeilisearchConfigured } from "./lib/meilisearch";
import { type OpenAPISpec } from "arkeon-shared";
import { renderFullReferenceFromSpec } from "./lib/openapi-help";
import { startScheduler, stopScheduler } from "./lib/scheduler";
import { initQueue, drainQueue } from "./lib/invocation-queue";
import { setWorkerCliReference } from "./lib/worker-prompt";

const app = createApp();

// Generate the full CLI reference once at startup for worker system prompts
const spec = app.getOpenAPI31Document(openApiConfig) as unknown as OpenAPISpec;
setWorkerCliReference(renderFullReferenceFromSpec(spec));

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

async function gracefulShutdown(signal: string): Promise<void> {
  console.log(`[shutdown] ${signal} received, starting graceful drain...`);

  const DRAIN_TIMEOUT_MS = Number(process.env.DRAIN_TIMEOUT_MS) || 320_000;

  const drainPromise = (async () => {
    await drainQueue();
    await stopScheduler();
  })();

  const timeoutPromise = new Promise<void>((resolve) =>
    setTimeout(() => {
      console.warn(`[shutdown] drain timeout (${DRAIN_TIMEOUT_MS}ms) — forcing exit`);
      resolve();
    }, DRAIN_TIMEOUT_MS),
  );

  await Promise.race([drainPromise, timeoutPromise]);
  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
