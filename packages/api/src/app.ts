import { OpenAPIHono } from "@hono/zod-openapi";

import type { AppBindings } from "./types";
import { renderIndexFromSpec, renderPreamble } from "./lib/openapi-help";
import { validationHook } from "./lib/openapi";
import { requestContextMiddleware } from "./middleware/request-context";
import { authMiddleware } from "./middleware/auth";
import { ApiError, errorBody } from "./lib/errors";
import { mapPostgresError } from "./lib/pg-errors";
import { createSql } from "./lib/sql";
import { activityRouter, entityActivityRouter } from "./routes/activity";
import { actorsRouter } from "./routes/actors";
import { adminRouter } from "./routes/admin";
import { arkesRouter } from "./routes/arkes";
import { authRouter } from "./routes/auth";
import { commentsRouter } from "./routes/comments";
import { contentRouter } from "./routes/content";
import { entitiesRouter } from "./routes/entities";
import { groupsRouter } from "./routes/groups";
import { createHelpRouter } from "./routes/help";
import { inboxRouter } from "./routes/inbox";
import { entityRelationshipsRouter, relationshipDirectRouter } from "./routes/relationships";
import { searchRouter } from "./routes/search";
import { spacesRouter } from "./routes/spaces";
import { workersRouter } from "./routes/workers";

export function createApp() {
  const app = new OpenAPIHono<AppBindings>({
    defaultHook: validationHook,
  });

  app.use("*", requestContextMiddleware);
  app.use("*", authMiddleware);

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

  const openApiConfig = {
    openapi: "3.1.0" as const,
    info: {
      title: "Arkeon API",
      version: "2.0.0",
    },
  };
  const getSpec = () => app.getOpenAPI31Document(openApiConfig);

  app.doc31("/openapi.json", openApiConfig);
  app.route("/help", createHelpRouter(getSpec));
  app.get("/llms.txt", (c) => {
    const actor = c.get("actor");
    const preamble = renderPreamble(actor);
    return c.text(preamble + renderIndexFromSpec(getSpec()), 200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    });
  });

  app.route("/activity", activityRouter);
  app.route("/actors", actorsRouter);
  app.route("/admin", adminRouter);
  app.route("/arkes", arkesRouter);
  app.route("/auth", authRouter);
  app.route("/auth", inboxRouter);
  app.route("/entities", commentsRouter);
  app.route("/entities", contentRouter);
  app.route("/entities", entitiesRouter);
  app.route("/entities", entityActivityRouter);
  app.route("/entities", entityRelationshipsRouter);
  app.route("/groups", groupsRouter);
  app.route("/relationships", relationshipDirectRouter);
  app.route("/search", searchRouter);
  app.route("/spaces", spacesRouter);
  app.route("/workers", workersRouter);

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
