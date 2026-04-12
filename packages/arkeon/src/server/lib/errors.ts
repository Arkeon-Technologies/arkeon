// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

export interface ApiErrorShape {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  request_id?: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function errorBody(error: ApiError, requestId: string): { error: ApiErrorShape } {
  return {
    error: {
      code: error.code,
      message: error.message,
      details: error.details,
      request_id: requestId,
    },
  };
}
