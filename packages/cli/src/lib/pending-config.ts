// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * One-shot carrier for the LLM provider config collected by `arkeon init`,
 * consumed by `arkeon up` once the API is healthy. Persisted in a third
 * Conf store (separate from config.ts and credentials.ts) so the lifecycle
 * is obvious: written by init, read+cleared by up.
 *
 * The reason this isn't stored in .env: .env should only hold values that
 * docker-compose / the API actually consume. The LLM config lives in the
 * database (knowledge_config table), not in env vars — see commit that
 * removed the OPENAI_API_KEY hardcoding.
 *
 * Security note: this store contains a plaintext API key between `arkeon
 * init --llm-api-key` and `arkeon up`. We chmod the file to 0600 on every
 * write so other users on multi-user systems can't read it. The window
 * is usually short (seconds to minutes), the caller already put the key
 * in shell history by passing it as a flag, and `arkeon up` clears the
 * entry after pushing it to the running API. See PR #16 review for the
 * full threat-model discussion.
 */

import { chmodSync } from "node:fs";

import Conf from "conf";

export interface PendingLlmConfig {
  /** Free-form provider label, e.g. "openai", "anthropic", "openrouter". */
  provider: string;
  /** OpenAI-compatible base URL (required, no defaults). */
  base_url: string;
  /** API key for the provider. */
  api_key: string;
  /** Model identifier, e.g. "gpt-4.1-nano", "claude-3-5-sonnet-20241022". */
  model: string;
}

const store = new Conf<{ pendingLlmConfig?: PendingLlmConfig }>({
  projectName: "arkeon-cli",
  configName: "pending",
});

/**
 * Harden the on-disk store file to user-only read/write. Idempotent —
 * safe to call on every write even if the file already has 0600. We
 * swallow ENOENT because Conf only creates the file on first write
 * (the call site always runs after a store.set, so ENOENT would be a
 * Conf bug worth surfacing differently, not a chmod concern).
 *
 * Windows intentionally no-ops: POSIX permission bits don't map to NTFS
 * ACLs, and chmod on Windows in Node is a partial fiction that silently
 * no-ops for most bits anyway.
 */
function hardenStoreFile(path: string): void {
  if (process.platform === "win32") {
    return;
  }
  try {
    chmodSync(path, 0o600);
  } catch (error) {
    // ENOENT shouldn't happen after a successful store.set, but we don't
    // want a stat race to turn a write into a hard failure.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

export const pendingConfig = {
  getLlm(): PendingLlmConfig | null {
    return store.get("pendingLlmConfig") ?? null;
  },

  setLlm(value: PendingLlmConfig): void {
    store.set("pendingLlmConfig", value);
    hardenStoreFile(store.path);
  },

  clearLlm(): void {
    store.delete("pendingLlmConfig");
  },

  path(): string {
    return store.path;
  },
};
