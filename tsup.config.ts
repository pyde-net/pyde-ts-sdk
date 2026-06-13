import { defineConfig } from "tsup";

// ESM-only build. Tree-shakeable, source-mapped, with type declarations.
// Multi-entry: the main SDK + the codegen module + the codegen CLI.
// Phase 10 (React hooks) will add `src/react/index.ts` here when it lands.
export default defineConfig({
  entry: ["src/index.ts", "src/codegen.ts", "src/cli-tsgen.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: "es2022",
});
