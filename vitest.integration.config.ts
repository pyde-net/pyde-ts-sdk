import { defineConfig } from "vitest/config";
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";

/**
 * Vitest config for the integration tests under tests/integration/.
 * These tests spawn a local devnet (or attach to one via
 * PYDE_DEVNET_URL) and are slower than the unit / property suite.
 *
 * Plugins:
 *   - vite-plugin-wasm: lets vitest resolve the `import
 *     "./pyde_crypto_wasm_bg.wasm"` emit that pyde-crypto-wasm's
 *     bundler-mode pkg/ produces. Without this, vite throws
 *     "ESM integration proposal for Wasm is not supported currently".
 *   - vite-plugin-top-level-await: required by vite-plugin-wasm for
 *     async wasm instantiation in environments without top-level
 *     await support.
 *
 * Run with: `npm run test:integration`.
 *
 * The default `npm test` invocation uses `vitest.config.ts` which
 * excludes `tests/integration/**` to keep CI fast.
 */
export default defineConfig({
  plugins: [wasm(), topLevelAwait()],
  test: {
    globals: false,
    environment: "node",
    include: ["tests/integration/**/*.live.test.ts"],
    testTimeout: 180_000,
    hookTimeout: 120_000,
    // Sequential — only one devnet on default port at a time.
    fileParallelism: false,
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true },
    },
  },
});
