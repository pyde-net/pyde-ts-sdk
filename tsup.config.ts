import { defineConfig } from "tsup";

// ESM-only build. Tree-shakeable, source-mapped, with type declarations.
// Multi-entry: the main SDK + the codegen module + the codegen CLI.
//
// vendor/crypto-wasm/ stays UNBUNDLED — wasm-bindgen's `bundler`-target
// output references its sibling `.js` bindings via the wasm's internal
// import section, so we keep the three files (entry .js, bindings .js,
// .wasm) co-located. Marking them external in esbuild + copying them
// verbatim into dist/vendor/ preserves the relative-path relationship.
// Bundlers downstream (Vite, webpack, Next.js) treat the relative
// imports just like wasm-pack expects.
export default defineConfig({
  entry: ["src/index.ts", "src/codegen.ts", "src/cli-tsgen.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: "es2022",
  external: [/vendor\/crypto-wasm\/.*/],
  // Copy the vendor JS + wasm here. The .d.ts files are copied
  // separately by the `build:vendor-dts` npm script, which runs
  // strictly AFTER tsup's DTS phase finishes — tsup's DTS plugin
  // otherwise races onSuccess and removes "unknown" .d.ts files it
  // didn't itself emit.
  onSuccess:
    "mkdir -p dist/vendor/crypto-wasm && " +
    "cp src/vendor/crypto-wasm/*.js src/vendor/crypto-wasm/*.wasm src/vendor/crypto-wasm/VENDOR.txt dist/vendor/crypto-wasm/",
});
