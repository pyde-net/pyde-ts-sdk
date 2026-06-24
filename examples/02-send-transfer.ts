/**
 * Example 02: derive a wallet from a known seed, register its pubkey
 * (one-time), and send a native PYDE transfer.
 *
 * Uses devnet-1 — the second prefunded account in `otigen devnet`'s
 * deterministic genesis. Auto-funded with 10 PYDE so we don't need an
 * external faucet step.
 *
 * Run:
 *   otigen devnet --rpc-listen 127.0.0.1:9933 --prefund-count 2
 *   npx tsx examples/02-send-transfer.ts
 *
 * Or against a custom endpoint:
 *   PYDE_RPC_URL=https://rpc.pyde.network npx tsx examples/02-send-transfer.ts
 *
 * Note: tsx can't load the vendored `.wasm` directly. From this repo,
 * run `npm run build` then `node --experimental-wasm-modules examples/02-send-transfer.mjs`
 * — the `.mjs` sibling imports from `dist/index.js` and works under
 * plain Node.
 */

import { Provider, Wallet, keypairFromSeed, parseQuanta, formatQuanta } from "../src/index";
import { blake3 } from "@noble/hashes/blake3";

// Engine genesis derives devnet-N from `blake3("pyde-devnet-v1/" || u64_le(N))`.
function devnetSeed(i: number): Uint8Array {
  const prefix = new TextEncoder().encode("pyde-devnet-v1/");
  const idx = new Uint8Array(8);
  new DataView(idx.buffer).setBigUint64(0, BigInt(i), true);
  const input = new Uint8Array(prefix.length + idx.length);
  input.set(prefix, 0);
  input.set(idx, prefix.length);
  return blake3(input);
}
const toHex = (b: Uint8Array): string =>
  "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

async function main(): Promise<void> {
  const rpc = process.env.PYDE_RPC_URL ?? "http://127.0.0.1:9933";
  const provider = new Provider(rpc, { allowInsecureTransport: rpc.startsWith("http://") });

  // Re-derive devnet-1 from its canonical seed — already auth-keyed at
  // genesis, no `registerPubkey` needed.
  const kp = keypairFromSeed(toHex(devnetSeed(1)));
  const wallet = Wallet.fromKeys(kp.publicKey, kp.secretKey);
  wallet.connect(provider);

  console.log("from:   ", wallet.address);
  console.log("balance:", formatQuanta(await wallet.getBalance()), "PYDE");

  const recipient = process.env.RECIPIENT_ADDRESS ?? "0x" + "aa".repeat(32);
  const amount = parseQuanta("0.1"); // 100,000,000 quanta

  const receipt = await wallet.transfer(recipient, amount);
  console.log("tx:     ", receipt.txHash);
  console.log("status: ", receipt.success ? "success" : "reverted");
  console.log("gas:    ", parseInt(receipt.gasUsed.replace(/^0x/, ""), 16));
  console.log("balance after:", formatQuanta(await wallet.getBalance()), "PYDE");
  console.log("recipient now:", formatQuanta(await provider.getBalance(recipient)), "PYDE");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
