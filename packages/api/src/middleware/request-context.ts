// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { MiddlewareHandler } from "hono";

import type { AppBindings } from "../types";
import { createRequestId } from "../lib/request-id";

export const requestContextMiddleware: MiddlewareHandler<AppBindings> = async (c, next) => {
  const requestId = c.req.header("x-request-id") ?? createRequestId();

  c.set("requestId", requestId);
  await next();
  c.header("x-request-id", requestId);
};
