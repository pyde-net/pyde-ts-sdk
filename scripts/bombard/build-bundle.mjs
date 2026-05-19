#!/usr/bin/env node
/**
 * Bundle bombard.ts + the SDK + the suite artifacts into a self-
 * contained `dist/` directory friends can copy to a USB / Telegram /
 * AirDrop and run with just `node bombard.cjs --rpc-url ...`.
 *
 * Output layout:
 *   dist/
 *     bombard.cjs                       — single file, SDK inlined
 *     wasm/pyde_crypto_wasm.js          — wasm-loader shim
 *     wasm/pyde_crypto_wasm_bg.wasm     — the FALCON / Kyber / Poseidon2 WASM blob
 *     wasm/package.json                 — keeps the wasm/ folder a CJS module so
 *                                         `require("./wasm/pyde_crypto_wasm")` works
 *     suite/out/Helper.json             — pre-compiled contract artifacts
 *     suite/out/MegaContract.json
 *     suite/out/Spawner.json
 *     README.md                         — friend-facing usage doc
 *
 * Friends:
 *   1. Install Node 18+ on their laptop.
 *   2. cd into the dist/ folder.
 *   3. node bombard.cjs --rpc-url ... --chain-id 7331 --senders 50 --tps 10
 *
 * Re-run this script whenever bombard.ts or the suite contracts
 * change.
 */

import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(here, "dist");
const wasmSrc = path.join(here, "..", "..", "wasm");
const suiteOut = path.join(here, "suite", "out");

// ── 0. Sanity checks ────────────────────────────────────────────
if (!fs.existsSync(suiteOut)) {
  console.error(
    "error: suite/out/ not found. Run `cd suite && pyde-dev build` first.",
  );
  process.exit(1);
}
for (const name of ["Helper.json", "MegaContract.json", "Spawner.json"]) {
  if (!fs.existsSync(path.join(suiteOut, name))) {
    console.error(`error: suite/out/${name} missing — re-run pyde-dev build.`);
    process.exit(1);
  }
}
if (!fs.existsSync(path.join(wasmSrc, "pyde_crypto_wasm_bg.wasm"))) {
  console.error(`error: ${wasmSrc}/pyde_crypto_wasm_bg.wasm not found.`);
  process.exit(1);
}

// ── 1. Reset dist ───────────────────────────────────────────────
fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(distDir, { recursive: true });

// ── 2. esbuild bundle ───────────────────────────────────────────
// The SDK's crypto.ts does `require("../wasm/pyde_crypto_wasm")` —
// we mark that path external so the bundle keeps the require call
// intact and we ship the wasm/ folder alongside.
console.log("  bundling bombard.ts → dist/bombard.cjs (esbuild)...");
await build({
  entryPoints: [path.join(here, "bombard.ts")],
  outfile: path.join(distDir, "bombard.cjs"),
  bundle: true,
  platform: "node",
  target: "node18",
  format: "cjs",
  sourcemap: false,
  minify: false,
  external: [
    // The SDK's crypto.ts loads the wasm wrapper via
    // `require("../wasm/pyde_crypto_wasm")`. esbuild resolves that
    // to an absolute path during bundling, but at runtime the
    // bundle is in dist/ so the relative ../wasm wouldn't resolve.
    // Patch the require path post-build (see below) and keep the
    // wasm wrapper as an external module.
    "*/pyde_crypto_wasm",
  ],
  logLevel: "info",
});

// Rewrite the wasm require path. esbuild emits something like
// `require("../wasm/pyde_crypto_wasm")` because of the source's
// relative path; in dist/ it should be `require("./wasm/pyde_crypto_wasm")`
// (the wasm/ folder lives alongside bombard.cjs).
{
  const p = path.join(distDir, "bombard.cjs");
  let txt = fs.readFileSync(p, "utf-8");
  const before = txt;
  txt = txt.replace(
    /require\((["'])(?:\.\.\/)*wasm\/pyde_crypto_wasm\1\)/g,
    'require("./wasm/pyde_crypto_wasm")',
  );
  if (txt === before) {
    console.warn(
      "  warning: did not find a wasm require to rewrite — bundle may be broken.",
    );
  }
  fs.writeFileSync(p, txt);
}

// ── 3. Copy the wasm folder ─────────────────────────────────────
console.log("  copying wasm/ → dist/wasm/...");
const wasmDst = path.join(distDir, "wasm");
fs.mkdirSync(wasmDst, { recursive: true });
for (const name of [
  "pyde_crypto_wasm.js",
  "pyde_crypto_wasm_bg.wasm",
  "package.json",
]) {
  const src = path.join(wasmSrc, name);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(wasmDst, name));
  }
}

// ── 4. Copy the suite artifacts ─────────────────────────────────
console.log("  copying suite/out/ → dist/suite/out/...");
const suiteDst = path.join(distDir, "suite", "out");
fs.mkdirSync(suiteDst, { recursive: true });
for (const name of ["Helper.json", "MegaContract.json", "Spawner.json"]) {
  fs.copyFileSync(path.join(suiteOut, name), path.join(suiteDst, name));
}

// ── 5. Drop a friend-facing README ──────────────────────────────
const readme = `# pyde-bombard (bundle)

Self-contained network stress tester for a Pyde testnet. Distributed
as a flat folder you can copy via USB / AirDrop / Telegram — no
\`npm install\`, no Rust toolchain, no SDK clone.

## Run

\`\`\`bash
# Requires Node.js 18 or newer.
node bombard.cjs \\
  --rpc-url http://testnet.example:8545 \\
  --faucet-url http://testnet.example:8080 \\
  --chain-id 7331 \\
  --duration-secs 600 \\
  --tps 10 \\
  --senders 50
\`\`\`

The script will provision \`--senders\` wallets via the public faucet,
deploy the Helper / MegaContract / Spawner suite, and run an 8-bucket
weighted workload (transfer, increment-AOT, complex_logic, change_status,
deposit, spawn factory, cross-contract ping, threshold-encrypted
increment) for \`--duration-secs\` seconds.

## Multi-laptop coordination

The first laptop deploys the contracts and prints their addresses.
Subsequent laptops re-use those addresses to skip the deploy phase:

\`\`\`bash
node bombard.cjs \\
  --rpc-url ... \\
  --helper 0xab12... \\
  --mega 0xcd34... \\
  --spawner 0xef56...
\`\`\`

## What's in this folder

| File | Purpose |
|---|---|
| \`bombard.cjs\` | Bundled script (SDK inlined) |
| \`wasm/\` | FALCON-512 + Kyber-768 + Poseidon2 WASM blob (loaded at startup) |
| \`suite/out/*.json\` | Pre-compiled contract artifacts (Helper, MegaContract, Spawner) |

## Diagnosing failures

- **\`chain_id mismatch\`** — \`--rpc-url\` and \`--chain-id\` don't match. Trust the node's reported chain_id.
- **\`faucet 429: ip rate limited\`** — faucet's per-IP cooldown is too tight for \`--senders\`. Lower \`--senders\` or have the operator restart the faucet with \`--cooldown 0\`.
- **\`faucet 500: BelowWindow ...\`** — faucet's signing-side nonce is racing the chain commit. Usually transient; re-run.
- **\`AboveWindow\` errors during workload** — per-sender nonce window saturation. Lower \`--tps\` or raise \`--senders\`.
`;
fs.writeFileSync(path.join(distDir, "README.md"), readme);

console.log(`\nBundle ready at: ${distDir}`);
console.log("Copy that whole folder to a hard drive / AirDrop / etc.");
console.log("Friends run: node bombard.cjs --rpc-url ...");
