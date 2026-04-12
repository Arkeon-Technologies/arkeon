// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { defineConfig } from "vitest/config";

// Default suite = unit tests only. The e2e tests under test/e2e/ need
// a running arkeon stack on localhost:8000 and are invoked via the
// dedicated `test:e2e` script (vitest.e2e.config.ts).
export default defineConfig({
  test: {
    include: ["test/unit/**/*.test.ts"],
    environment: "node",
  },
});
