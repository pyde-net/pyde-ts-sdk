import { defineConfig } from "tsup";

// ESM-only build. Tree-shakeable, source-mapped, with type declarations.
// Phase 9 (codegen CLI) and Phase 10 (React hooks) will add their own
// entry points here when they land.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: "es2022",
});
