// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { defineConfig } from "vitest/config";

// Manual tests require a running arkeon stack and a real LLM API key.
// Not run in CI. Invoke with: OPENAI_API_KEY=sk-... npm run test:manual -w packages/arkeon
export default defineConfig({
  test: {
    include: ["test/manual/**/*.test.ts"],
    environment: "node",
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
    isolate: false,
  },
});
