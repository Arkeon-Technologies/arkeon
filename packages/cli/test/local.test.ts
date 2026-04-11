// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";

import {
  buildLlmConfigFromFlags,
  generateSecrets,
  parseEnv,
  renderEnv,
} from "../src/lib/local.js";

// ---------------------------------------------------------------------------
// renderEnv — substitutes KEY= placeholders in the .env.example template
// ---------------------------------------------------------------------------

describe("renderEnv", () => {
  test("substitutes an empty KEY= line with the given value", () => {
    const template = "# comment\nADMIN_BOOTSTRAP_KEY=\nOTHER=kept\n";
    const out = renderEnv(template, { ADMIN_BOOTSTRAP_KEY: "ak_xyz" });
    expect(out).toContain("ADMIN_BOOTSTRAP_KEY=ak_xyz");
    expect(out).toContain("OTHER=kept");
    expect(out).toContain("# comment");
  });

  test("preserves surrounding comments and blank lines", () => {
    const template = [
      "# Admin bootstrap key",
      "# Rotate after first use.",
      "ADMIN_BOOTSTRAP_KEY=",
      "",
      "# Encryption key",
      "ENCRYPTION_KEY=",
      "",
    ].join("\n");

    const out = renderEnv(template, {
      ADMIN_BOOTSTRAP_KEY: "ak_abc",
      ENCRYPTION_KEY: "deadbeef",
    });

    const lines = out.split("\n");
    expect(lines).toContain("# Admin bootstrap key");
    expect(lines).toContain("# Rotate after first use.");
    expect(lines).toContain("ADMIN_BOOTSTRAP_KEY=ak_abc");
    expect(lines).toContain("# Encryption key");
    expect(lines).toContain("ENCRYPTION_KEY=deadbeef");
  });

  test("substitutes multiple keys in one pass; output round-trips via parseEnv", () => {
    // Don't byte-compare — the `\s*$` regex in renderEnv consumes
    // trailing whitespace, which can shift newlines. The contract that
    // matters is: parseEnv(renderEnv(template, values))[key] === value
    // for every supplied key.
    const template = "A=\nB=\nC=\n";
    const out = renderEnv(template, { A: "1", B: "2", C: "3" });
    expect(parseEnv(out)).toEqual({ A: "1", B: "2", C: "3" });
  });

  test("does not touch KEY= lines that already have a value", () => {
    // Catches the case where someone runs init on top of an unrelated
    // template that happens to have PORT=8000 already set — we don't
    // want to wipe that default.
    const template = "PORT=8000\nADMIN_BOOTSTRAP_KEY=\n";
    const out = renderEnv(template, { ADMIN_BOOTSTRAP_KEY: "ak_xyz" });
    expect(out).toContain("PORT=8000");
    expect(out).toContain("ADMIN_BOOTSTRAP_KEY=ak_xyz");
  });

  test("appends missing keys at the end rather than silently dropping them", () => {
    // If .env.example drifts and stops containing a key we depend on,
    // renderEnv should still write it — protects against template rot.
    const template = "# just comments\n# no keys\n";
    const out = renderEnv(template, { ADMIN_BOOTSTRAP_KEY: "ak_xyz" });
    expect(out).toContain("ADMIN_BOOTSTRAP_KEY=ak_xyz");
    expect(out.trimEnd().endsWith("ADMIN_BOOTSTRAP_KEY=ak_xyz")).toBe(true);
  });

  test("handles KEY= with trailing whitespace", () => {
    const template = "ADMIN_BOOTSTRAP_KEY=   \n";
    const out = renderEnv(template, { ADMIN_BOOTSTRAP_KEY: "ak_xyz" });
    expect(out).toContain("ADMIN_BOOTSTRAP_KEY=ak_xyz");
    expect(out).not.toContain("ADMIN_BOOTSTRAP_KEY=   ");
  });

  test("end-to-end against a representative .env.example fragment", () => {
    const template = [
      "# =====================================================================",
      "# REQUIRED",
      "# =====================================================================",
      "",
      "ADMIN_BOOTSTRAP_KEY=",
      "ENCRYPTION_KEY=",
      "MEILI_MASTER_KEY=",
      "POSTGRES_PASSWORD=",
      "ARKE_APP_PASSWORD=",
      "",
      "PORT=8000",
      "PG_PORT=5432",
    ].join("\n");

    const out = renderEnv(template, {
      ADMIN_BOOTSTRAP_KEY: "ak_a",
      ENCRYPTION_KEY: "b".repeat(64),
      MEILI_MASTER_KEY: "c".repeat(48),
      POSTGRES_PASSWORD: "d".repeat(64),
      ARKE_APP_PASSWORD: "e".repeat(64),
    });

    const parsed = parseEnv(out);
    expect(parsed.ADMIN_BOOTSTRAP_KEY).toBe("ak_a");
    expect(parsed.ENCRYPTION_KEY).toBe("b".repeat(64));
    expect(parsed.MEILI_MASTER_KEY).toBe("c".repeat(48));
    expect(parsed.POSTGRES_PASSWORD).toBe("d".repeat(64));
    expect(parsed.ARKE_APP_PASSWORD).toBe("e".repeat(64));
    // Pre-existing defaults must be preserved.
    expect(parsed.PORT).toBe("8000");
    expect(parsed.PG_PORT).toBe("5432");
  });
});

// ---------------------------------------------------------------------------
// parseEnv — minimal dotenv-style parser
// ---------------------------------------------------------------------------

describe("parseEnv", () => {
  test("parses simple KEY=value lines", () => {
    expect(parseEnv("A=1\nB=2")).toEqual({ A: "1", B: "2" });
  });

  test("skips blank lines and comments", () => {
    const text = ["# a comment", "", "A=1", "   # indented comment", "B=2"].join("\n");
    expect(parseEnv(text)).toEqual({ A: "1", B: "2" });
  });

  test("strips surrounding double quotes", () => {
    expect(parseEnv('A="hello"')).toEqual({ A: "hello" });
  });

  test("strips surrounding single quotes", () => {
    expect(parseEnv("A='hello'")).toEqual({ A: "hello" });
  });

  test("preserves internal whitespace but trims outer whitespace", () => {
    expect(parseEnv("A=  hello world  ")).toEqual({ A: "hello world" });
  });

  test("skips lines without =", () => {
    const text = "JUST_A_WORD\nA=1";
    expect(parseEnv(text)).toEqual({ A: "1" });
  });

  test("later values override earlier ones for the same key", () => {
    expect(parseEnv("A=1\nA=2")).toEqual({ A: "2" });
  });

  test("handles CRLF line endings", () => {
    expect(parseEnv("A=1\r\nB=2\r\n")).toEqual({ A: "1", B: "2" });
  });

  test("empty value is an empty string, not undefined", () => {
    expect(parseEnv("A=")).toEqual({ A: "" });
  });

  test("value with `=` inside is preserved after the first =", () => {
    expect(parseEnv("DATABASE_URL=postgres://user:pass@host/db?sslmode=require")).toEqual({
      DATABASE_URL: "postgres://user:pass@host/db?sslmode=require",
    });
  });
});

// ---------------------------------------------------------------------------
// generateSecrets — shape and format assertions (statistical, not byte-exact)
// ---------------------------------------------------------------------------

describe("generateSecrets", () => {
  test("returns all five required keys", () => {
    const s = generateSecrets();
    expect(Object.keys(s).sort()).toEqual([
      "ADMIN_BOOTSTRAP_KEY",
      "ARKE_APP_PASSWORD",
      "ENCRYPTION_KEY",
      "MEILI_MASTER_KEY",
      "POSTGRES_PASSWORD",
    ]);
  });

  test("ADMIN_BOOTSTRAP_KEY has ak_ prefix + 64 hex chars", () => {
    const { ADMIN_BOOTSTRAP_KEY } = generateSecrets();
    expect(ADMIN_BOOTSTRAP_KEY).toMatch(/^ak_[0-9a-f]{64}$/);
  });

  test("ENCRYPTION_KEY is exactly 64 hex chars", () => {
    const { ENCRYPTION_KEY } = generateSecrets();
    expect(ENCRYPTION_KEY).toMatch(/^[0-9a-f]{64}$/);
    expect(ENCRYPTION_KEY).toHaveLength(64);
  });

  test("MEILI_MASTER_KEY is 48 hex chars (24 bytes)", () => {
    const { MEILI_MASTER_KEY } = generateSecrets();
    expect(MEILI_MASTER_KEY).toMatch(/^[0-9a-f]{48}$/);
  });

  test("POSTGRES_PASSWORD is URL-safe (alphanumeric hex only)", () => {
    // Matches the rule in .env.example: `must be URL-safe. Passwords
    // containing @ : / ? # $ will either break URL parsing or be
    // re-interpolated by compose.` Hex generation satisfies this.
    const { POSTGRES_PASSWORD } = generateSecrets();
    expect(POSTGRES_PASSWORD).toMatch(/^[0-9a-f]+$/);
    expect(POSTGRES_PASSWORD).toHaveLength(64);
  });

  test("ARKE_APP_PASSWORD is URL-safe and has 64 hex chars", () => {
    const { ARKE_APP_PASSWORD } = generateSecrets();
    expect(ARKE_APP_PASSWORD).toMatch(/^[0-9a-f]{64}$/);
  });

  test("consecutive calls produce different values (randomness sanity check)", () => {
    const a = generateSecrets();
    const b = generateSecrets();
    expect(a.ADMIN_BOOTSTRAP_KEY).not.toBe(b.ADMIN_BOOTSTRAP_KEY);
    expect(a.ENCRYPTION_KEY).not.toBe(b.ENCRYPTION_KEY);
    expect(a.MEILI_MASTER_KEY).not.toBe(b.MEILI_MASTER_KEY);
    expect(a.POSTGRES_PASSWORD).not.toBe(b.POSTGRES_PASSWORD);
    expect(a.ARKE_APP_PASSWORD).not.toBe(b.ARKE_APP_PASSWORD);
  });
});

// ---------------------------------------------------------------------------
// buildLlmConfigFromFlags — partial-flag validation for `arkeon init`
// ---------------------------------------------------------------------------

describe("buildLlmConfigFromFlags", () => {
  const full = {
    llmProvider: "openai",
    llmBaseUrl: "https://api.openai.com/v1",
    llmApiKey: "sk-test",
    llmModel: "gpt-4.1-nano",
  };

  test("returns null when no flags are provided", () => {
    expect(buildLlmConfigFromFlags({})).toBeNull();
  });

  test("returns a full config when all four flags are provided", () => {
    expect(buildLlmConfigFromFlags(full)).toEqual({
      provider: "openai",
      base_url: "https://api.openai.com/v1",
      api_key: "sk-test",
      model: "gpt-4.1-nano",
    });
  });

  test("throws naming the missing flags when only provider is given", () => {
    expect(() => buildLlmConfigFromFlags({ llmProvider: "openai" })).toThrow(
      /--llm-base-url, --llm-api-key, --llm-model/,
    );
  });

  test("throws naming the missing flags when three of four are given", () => {
    expect(() =>
      buildLlmConfigFromFlags({
        llmProvider: "openai",
        llmBaseUrl: "https://api.openai.com/v1",
        llmApiKey: "sk-test",
      }),
    ).toThrow(/--llm-model/);
  });

  test("throws on an invalid base URL", () => {
    expect(() =>
      buildLlmConfigFromFlags({ ...full, llmBaseUrl: "not a url" }),
    ).toThrow(/not a valid URL/);
  });

  test("accepts any OpenAI-compatible provider label (no hardcoded allowlist)", () => {
    const cfg = buildLlmConfigFromFlags({
      llmProvider: "openrouter",
      llmBaseUrl: "https://openrouter.ai/api/v1",
      llmApiKey: "sk-or-v1-xxx",
      llmModel: "anthropic/claude-3.5-sonnet",
    });
    expect(cfg?.provider).toBe("openrouter");
    expect(cfg?.model).toBe("anthropic/claude-3.5-sonnet");
  });

  test("accepts a localhost URL for local provider endpoints", () => {
    const cfg = buildLlmConfigFromFlags({
      llmProvider: "local",
      llmBaseUrl: "http://localhost:11434/v1",
      llmApiKey: "ollama",
      llmModel: "llama3",
    });
    expect(cfg?.base_url).toBe("http://localhost:11434/v1");
  });
});
