import { defineConfig } from "vitest/config";

/**
 * Vitest config for the integration tests under tests/integration/.
 * These tests spawn a local devnet (or attach to one via
 * PYDE_DEVNET_URL) and are slower than the unit / property suite.
 *
 * Run with: `npm run test:integration`.
 *
 * The default `npm test` invocation uses `vitest.config.ts` which
 * excludes `tests/integration/**` to keep CI fast.
 */
export default defineConfig({
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
