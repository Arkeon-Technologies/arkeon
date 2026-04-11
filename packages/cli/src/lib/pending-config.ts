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
 */

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

export const pendingConfig = {
  getLlm(): PendingLlmConfig | null {
    return store.get("pendingLlmConfig") ?? null;
  },

  setLlm(value: PendingLlmConfig): void {
    store.set("pendingLlmConfig", value);
  },

  clearLlm(): void {
    store.delete("pendingLlmConfig");
  },

  path(): string {
    return store.path;
  },
};
