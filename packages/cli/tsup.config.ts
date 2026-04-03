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
  noExternal: ["arkeon-shared"],
  banner: {
    js: "#!/usr/bin/env node",
  },
});
