// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";

import { translateFetchError } from "../../src/cli/lib/http.js";

/**
 * Build a fake fetch-failure error shaped like what node:undici actually
 * throws. We test the translator in isolation — no real network calls.
 */
function undiciLike(code: string): Error {
  const e = new TypeError("fetch failed") as Error & { cause: unknown };
  e.cause = { code, syscall: "connect" };
  return e;
}

describe("translateFetchError", () => {
  const url = "http://localhost:8000";

  test("ECONNREFUSED → friendly message with stack-running hint", () => {
    const translated = translateFetchError(undiciLike("ECONNREFUSED"), url);
    expect(translated).toBeInstanceOf(Error);
    expect(translated.message).toContain(url);
    expect(translated.message).toContain("connection refused");
    expect(translated.message).toContain("arkeon up");
  });

  test("ENOTFOUND → hints at URL misconfiguration", () => {
    const translated = translateFetchError(undiciLike("ENOTFOUND"), url);
    expect(translated.message).toContain(url);
    expect(translated.message).toContain("host not found");
    expect(translated.message).toContain("config get-url");
  });

  test("ETIMEDOUT → timeout-specific message", () => {
    const translated = translateFetchError(undiciLike("ETIMEDOUT"), url);
    expect(translated.message).toContain(url);
    expect(translated.message).toContain("timed out");
  });

  test("unknown code falls back to generic message with URL + original message", () => {
    const translated = translateFetchError(undiciLike("EHOSTUNREACH"), url);
    expect(translated.message).toContain(url);
    // Falls back to the original fetch failed message
    expect(translated.message).toContain("fetch failed");
  });

  test("preserves the original error as `cause` for stack traces", () => {
    const original = undiciLike("ECONNREFUSED");
    const translated = translateFetchError(original, url) as Error & { cause?: unknown };
    expect(translated.cause).toBe(original);
  });

  test("handles errors without a cause field (plain Error)", () => {
    const plain = new Error("boom");
    const translated = translateFetchError(plain, url);
    expect(translated.message).toContain(url);
    expect(translated.message).toContain("boom");
  });

  test("handles non-Error thrown values defensively", () => {
    // fetch can throw strings in exotic runtimes; the translator should
    // not crash trying to read .message on a string.
    const translated = translateFetchError("some string", url);
    expect(translated).toBeInstanceOf(Error);
    expect(translated.message).toContain(url);
  });
});
