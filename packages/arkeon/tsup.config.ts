// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node18",
  outDir: "dist",
  clean: true,
  dts: false,
  sourcemap: true,
  shims: true,
  noExternal: ["@arkeon-technologies/shared"],
  banner: {
    js: "#!/usr/bin/env node",
  },
});
