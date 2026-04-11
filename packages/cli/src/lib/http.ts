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

  const response = await fetch(`${apiUrl}${path}`, {
    ...options,
    headers,
  });

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

  const response = await fetch(`${apiUrl}${path}`, {
    ...options,
    headers,
  });

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
