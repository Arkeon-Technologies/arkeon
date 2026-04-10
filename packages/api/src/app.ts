import { OpenAPIHono } from "@hono/zod-openapi";
import { serveStatic } from "@hono/node-server/serve-static";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { existsSync } from "fs";

import type { AppBindings } from "./types";
import type { OpenAPISpec } from "arkeon-shared";
import { renderFullApiReferenceFromSpec, renderPreamble } from "./lib/openapi-help";
import { validationHook } from "./lib/openapi";
import { requestContextMiddleware } from "./middleware/request-context";
import { authMiddleware } from "./middleware/auth";
import { ApiError, errorBody } from "./lib/errors";
import { mapPostgresError } from "./lib/pg-errors";
import { createSql } from "./lib/sql";
import { activityRouter, entityActivityRouter } from "./routes/activity";
import { actorsRouter } from "./routes/actors";
import { adminRouter } from "./routes/admin";
import { authRouter } from "./routes/auth";
import { commentsRouter } from "./routes/comments";
import { contentRouter } from "./routes/content";
import { entitiesRouter } from "./routes/entities";
import { groupsRouter } from "./routes/groups";
import { createHelpRouter } from "./routes/help";
import { inboxRouter } from "./routes/inbox";
import { opsRouter } from "./routes/ops";
import { entityRelationshipsRouter, relationshipDirectRouter } from "./routes/relationships";
import { searchRouter } from "./routes/search";
import { spacesRouter } from "./routes/spaces";
import { workersRouter } from "./routes/workers";
import { knowledgeRouter } from "./knowledge/routes";

export const openApiConfig = {
  openapi: "3.1.0" as const,
  info: {
    title: "Arkeon API",
    version: "2.0.0",
  },
};

export function createApp() {
  const app = new OpenAPIHono<AppBindings>({
    defaultHook: validationHook,
  });

  app.use("*", requestContextMiddleware);
  app.use("*", authMiddleware);

  // Serve explorer SPA static assets
  const explorerDist = resolve(dirname(fileURLToPath(import.meta.url)), "../../explorer/dist");
  if (!existsSync(explorerDist)) {
    console.warn(`[explorer] dist not found at ${explorerDist} — /explore will 404. Run: npm run build -w packages/explorer`);
  }
  app.use("/explore/*", serveStatic({
    root: explorerDist,
    rewriteRequestPath: (path) => path.replace(/^\/explore/, ""),
  }));
  // SPA fallback: only serve index.html for extension-less paths (route navigations).
  // Asset requests with extensions (.js, .css, .png, etc.) should 404 properly so
  // missing chunks don't silently get the HTML shell.
  app.get("/explore/*", async (c, next) => {
    const path = c.req.path;
    if (/\.[a-zA-Z0-9]+$/.test(path)) {
      return next();
    }
    return serveStatic({ root: explorerDist, path: "index.html" })(c, next);
  });
  app.get("/explore", (c) => c.redirect("/explore/"));

  app.get("/", (c) =>
    c.json({
      name: "arkeon-api",
      message: "Welcome to the Arkeon API. See /help for documentation.",
      status: "ok",
      docs: {
        help: "/help",
        guide: "/help/guide",
        llms_txt: "/llms.txt",
        openapi: "/openapi.json",
      },
      tools: {
        cli: "npm install -g @arkeon-technologies/cli",
        sdk: "npm install @arkeon-technologies/sdk",
      },
      explorer: "/explore",
    }),
  );

  app.get("/health", (c) => c.json({ status: "ok" }));

  app.get("/ready", async (c) => {
    try {
      const sql = createSql();
      await sql`SELECT 1`;
      return c.json({ status: "ready" });
    } catch {
      return c.json({ status: "unavailable" }, 503);
    }
  });

  const getSpec = () => app.getOpenAPI31Document(openApiConfig);

  app.doc31("/openapi.json", openApiConfig);
  app.route("/help", createHelpRouter(getSpec));
  app.get("/llms.txt", (c) => {
    const actor = c.get("actor");
    const preamble = renderPreamble(actor);
    return c.text(preamble + renderFullApiReferenceFromSpec(getSpec() as unknown as OpenAPISpec), 200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    });
  });

  app.route("/activity", activityRouter);
  app.route("/actors", actorsRouter);
  app.route("/admin", adminRouter);
  app.route("/auth", authRouter);
  app.route("/auth", inboxRouter);
  app.route("/entities", commentsRouter);
  app.route("/entities", contentRouter);
  app.route("/entities", entitiesRouter);
  app.route("/entities", entityActivityRouter);
  app.route("/entities", entityRelationshipsRouter);
  app.route("/groups", groupsRouter);
  app.route("/ops", opsRouter);
  app.route("/relationships", relationshipDirectRouter);
  app.route("/search", searchRouter);
  app.route("/spaces", spacesRouter);
  app.route("/workers", workersRouter);
  app.route("/knowledge", knowledgeRouter);

  app.notFound((c) => {
    const requestId = c.get("requestId");
    return c.json(
      {
        error: {
          code: "not_found",
          message: "Route not found",
          request_id: requestId,
        },
      },
      404,
    );
  });

  app.onError((error, c) => {
    const requestId = c.get("requestId");

    if (error instanceof ApiError) {
      return new Response(JSON.stringify(errorBody(error, requestId)), {
        status: error.status,
        headers: {
          "content-type": "application/json; charset=utf-8",
        },
      });
    }

    const pgError = mapPostgresError(error);
    if (pgError) {
      console.error("[pg]", error);
      return new Response(JSON.stringify(errorBody(pgError, requestId)), {
        status: pgError.status,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    console.error(error);

    return new Response(
      JSON.stringify(
        errorBody(
          new ApiError(500, "internal_error", "Internal server error"),
          requestId,
        ),
      ),
      {
        status: 500,
        headers: {
          "content-type": "application/json; charset=utf-8",
        },
      },
    );
  });

  return app;
}
