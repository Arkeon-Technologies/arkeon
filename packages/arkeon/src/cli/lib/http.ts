// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { config } from "./config.js";
import { credentials } from "./credentials.js";

export type RequestOptions = RequestInit & {
  auth?: boolean | "optional";
};

export class ApiError extends Error {
  statusCode: number;
  requestId?: string;
  code?: string;
  details?: Record<string, unknown>;

  constructor(
    message: string,
    statusCode: number,
    requestId?: string,
    code?: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.requestId = requestId;
    this.code = code;
    this.details = details;
  }
}

/**
 * Translate node:undici's cryptic "fetch failed" into a human-friendly
 * message that tells the user which URL failed and why. Preserves the
 * original cause chain on the rethrown Error via `cause`.
 *
 * Exported for unit testing; not part of the CLI's public surface.
 * @internal
 */
export function translateFetchError(error: unknown, apiUrl: string): Error {
  const cause = (error as { cause?: { code?: string; syscall?: string } }).cause;
  const message = (error as Error).message ?? String(error);

  if (cause?.code === "ECONNREFUSED") {
    return new Error(
      `Could not reach ${apiUrl}: connection refused. Is the stack running? Try \`arkeon up\` or \`arkeon status\` to check.`,
      { cause: error },
    );
  }
  if (cause?.code === "ENOTFOUND") {
    return new Error(
      `Could not reach ${apiUrl}: host not found. Check the URL with \`arkeon config get-url\`.`,
      { cause: error },
    );
  }
  if (cause?.code === "ETIMEDOUT") {
    return new Error(
      `Could not reach ${apiUrl}: connection timed out.`,
      { cause: error },
    );
  }
  return new Error(`Could not reach ${apiUrl}: ${message}`, { cause: error });
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const apiUrl = config.get("apiUrl").replace(/\/$/, "");
  const headers = new Headers(options.headers);

  if (!headers.has("accept")) {
    headers.set("accept", "application/json");
  }

  if (options.body && !headers.has("content-type") && typeof options.body === "string") {
    headers.set("content-type", "application/json");
  }

  if (options.auth === "optional") {
    const key = credentials.getApiKey();
    if (key) {
      headers.set("authorization", `ApiKey ${key}`);
    }
  } else if (options.auth) {
    const key = credentials.getApiKey();
    if (key) {
      headers.set("authorization", `ApiKey ${key}`);
    } else {
      credentials.requireApiKey();
    }
  }

  let response: Response;
  try {
    response = await fetch(`${apiUrl}${path}`, {
      ...options,
      headers,
    });
  } catch (error) {
    throw translateFetchError(error, apiUrl);
  }

  if (!response.ok) {
    const requestId = response.headers.get("x-request-id") ?? undefined;
    const errorPayload = (await response.json().catch(() => null)) as
      | { error?: { code?: string; message?: string; request_id?: string; details?: Record<string, unknown> } }
      | null;
    const message = errorPayload?.error?.message ?? `${response.status} ${response.statusText}`;
    throw new ApiError(
      message,
      response.status,
      errorPayload?.error?.request_id ?? requestId,
      errorPayload?.error?.code,
      errorPayload?.error?.details,
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

export async function apiResponse(path: string, options: RequestOptions = {}): Promise<Response> {
  const apiUrl = config.get("apiUrl").replace(/\/$/, "");
  const headers = new Headers(options.headers);

  if (options.auth === "optional") {
    const key = credentials.getApiKey();
    if (key) {
      headers.set("authorization", `ApiKey ${key}`);
    }
  } else if (options.auth) {
    const key = credentials.getApiKey();
    if (key) {
      headers.set("authorization", `ApiKey ${key}`);
    } else {
      credentials.requireApiKey();
    }
  }

  let response: Response;
  try {
    response = await fetch(`${apiUrl}${path}`, {
      ...options,
      headers,
    });
  } catch (error) {
    throw translateFetchError(error, apiUrl);
  }

  if (!response.ok) {
    const requestId = response.headers.get("x-request-id") ?? undefined;
    const errorPayload = (await response.json().catch(() => null)) as
      | { error?: { code?: string; message?: string; request_id?: string; details?: Record<string, unknown> } }
      | null;
    const message = errorPayload?.error?.message ?? `${response.status} ${response.statusText}`;
    throw new ApiError(
      message,
      response.status,
      errorPayload?.error?.request_id ?? requestId,
      errorPayload?.error?.code,
      errorPayload?.error?.details,
    );
  }

  return response;
}
