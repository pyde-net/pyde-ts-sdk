import { defineConfig } from "vitest/config";
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";

// vite-plugin-wasm + top-level-await let tests import modules that
// transitively load `pyde-crypto-wasm`'s ESM-bundler shape (the
// `import "./pyde_crypto_wasm_bg.wasm"` emit). Without them vitest
// throws "ESM integration proposal for Wasm is not supported".
export default defineConfig({
  plugins: [wasm(), topLevelAwait()],
  test: {
    globals: false,
    environment: "node",
    include: ["src/**/*.test.ts", "tests/property/**/*.test.ts"],
    exclude: ["tests/integration/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
    },
  },
});
