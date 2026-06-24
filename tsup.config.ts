import { defineConfig } from "tsup";

// ESM-only build. Tree-shakeable, source-mapped, with type declarations.
// Multi-entry: the main SDK + the codegen module + the codegen CLI.
export default defineConfig({
  entry: ["src/index.ts", "src/codegen.ts", "src/cli-tsgen.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: "es2022",
});
