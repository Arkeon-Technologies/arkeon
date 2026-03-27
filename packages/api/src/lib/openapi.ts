import type { Context } from "hono";
import { OpenAPIHono } from "@hono/zod-openapi";

import { ApiError, errorBody } from "./errors";
import type { AppBindings } from "../types";

type ValidationIssue = {
  path: Array<string | number>;
  code: string;
  message: string;
  expected?: unknown;
  received?: unknown;
};

function normalizeValidationIssue(issue: Record<string, unknown>): ValidationIssue {
  const rawPath = Array.isArray(issue.path) ? issue.path : [];
  const path = rawPath.filter((segment): segment is string | number => typeof segment === "string" || typeof segment === "number");
  const code = typeof issue.code === "string" ? issue.code : "invalid";
  const expected = issue.expected;
  const received = issue.received ?? issue.input;

  if (
    path[path.length - 1] === "ver" &&
    code === "invalid_type" &&
    expected === "number" &&
    (received === undefined || received === "undefined")
  ) {
    return {
      path,
      code: "missing_required_field",
      message: "Missing ver. Provide the expected current version (CAS token). Fetch the resource first and use its current ver.",
    };
  }

  return {
    path,
    code,
    message: typeof issue.message === "string" ? issue.message : "Invalid request field",
    ...(expected !== undefined ? { expected } : {}),
    ...(received !== undefined ? { received } : {}),
  };
}

function validationApiError(issues: Array<Record<string, unknown>>) {
  const normalizedIssues = issues.map(normalizeValidationIssue);
  if (normalizedIssues.length === 1 && normalizedIssues[0]?.code === "missing_required_field") {
    const [issue] = normalizedIssues;
    return new ApiError(400, "missing_required_field", issue.message, {
      field: String(issue.path[issue.path.length - 1] ?? "unknown"),
      issues: normalizedIssues,
    });
  }

  return new ApiError(400, "invalid_request", "Request validation failed", {
    issues: normalizedIssues,
  });
}

export function validationHook(
  result: { success: false; error: { issues: unknown } } | { success: true },
  c: Context<AppBindings>,
) {
  if (result.success) {
    return;
  }

  const requestId = c.get("requestId");
  return c.json(
    errorBody(validationApiError(result.error.issues as Array<Record<string, unknown>>), requestId),
    400,
  );
}

export function createRouter() {
  return new OpenAPIHono<AppBindings>({
    defaultHook: validationHook,
  });
}
