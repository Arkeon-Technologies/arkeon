// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

type ErrorDetails = {
  operation?: string;
  code?: string;
  status_code?: number;
  request_id?: string;
  details?: Record<string, unknown>;
};

export const output = {
  progress(message: string): void {
    console.error(message);
  },

  warn(message: string): void {
    console.warn(message);
  },

  result(value: Record<string, unknown>): void {
    process.stdout.write(`${JSON.stringify({ ok: true, ...value }, null, 2)}\n`);
  },

  error(error: unknown, details: ErrorDetails = {}): void {
    const err = error as Error & {
      code?: string;
      statusCode?: number;
      requestId?: string;
      details?: Record<string, unknown>;
    };
    const payload = {
      ok: false,
      error: {
        message: err instanceof Error ? err.message : String(error),
        ...(details.operation ? { operation: details.operation } : {}),
        ...(details.code ?? err?.code ? { code: details.code ?? err.code } : {}),
        ...(details.status_code ?? err?.statusCode
          ? { status_code: details.status_code ?? err.statusCode }
          : {}),
        ...(details.request_id ?? err?.requestId
          ? { request_id: details.request_id ?? err.requestId }
          : {}),
        ...(details.details ?? err?.details ? { details: details.details ?? err.details } : {}),
      },
    };
    process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
  },
};
