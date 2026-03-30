import { OpenAPIHono } from "@hono/zod-openapi";

import type { AppBindings } from "./types";
import { renderIndexFromSpec } from "./lib/openapi-help";
import { validationHook } from "./lib/openapi";
import { requestContextMiddleware } from "./middleware/request-context";
import { authMiddleware } from "./middleware/auth";
import { ApiError, errorBody } from "./lib/errors";
import { activityRouter, entityActivityRouter } from "./routes/activity";
import { actorsRouter } from "./routes/actors";
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
      name: "arke-api",
      status: "ok",
    }),
  );

  const openApiConfig = {
    openapi: "3.1.0" as const,
    info: {
      title: "Arke API",
      version: "2.0.0",
    },
    servers: [{ url: "https://api.arke.institute" }],
  };
  const getSpec = () => app.getOpenAPI31Document(openApiConfig);

  app.doc31("/openapi.json", openApiConfig);
  app.route("/help", createHelpRouter(getSpec));
  app.get("/llms.txt", (c) => {
    return c.text(renderIndexFromSpec(getSpec()), 200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    });
  });

  app.route("/activity", activityRouter);
  app.route("/actors", actorsRouter);
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
