// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { defineConfig } from "tsup";

// Tsup auto-externalizes everything in package.json `dependencies` and
// bundles `src/**` via relative imports. That's the default behavior —
// no `noExternal`, no explicit `external`. The previous multi-package
// layout needed `noExternal: ["@arkeon-technologies/shared"]` to pull a
// workspace sibling into the bundle, which was the root cause of the
// 0.3.0/0.3.1 packaging bugs: tsup followed the workspace symlink and
// started bundling the entire API server tree with its transitive
// deps, hitting CJS/ESM interop errors in the process.
//
// With everything living under packages/arkeon/src/ as relative
// imports, the default tsup behavior is what we actually want.
//
// If you ever find yourself reaching for `noExternal` or `external`
// here: stop and reason about why. The fix is almost always to move
// the dep into package.json `dependencies` where tsup can see it.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node18",
  outDir: "dist",
  clean: true,
  dts: false,
  sourcemap: true,
  shims: true,
  banner: {
    js: "#!/usr/bin/env node",
  },
});
