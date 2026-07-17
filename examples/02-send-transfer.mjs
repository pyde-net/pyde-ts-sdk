/**
 * Built-dist runner mirror of 02-send-transfer.ts. Use this when
 * running the example directly against a local devnet — tsx can't
 * load the vendored `.wasm` import, but the built `dist/index.js`
 * is a self-contained ESM bundle that Node loads with
 * `--experimental-wasm-modules`.
 *
 * Run:
 *   npm run build
 *   otigen devnet --rpc-listen 127.0.0.1:9933 --prefund-count 2
 *   node --experimental-wasm-modules examples/02-send-transfer.mjs
 */
import { Provider, Wallet, keypairFromSeed, parseQuanta, formatQuanta } from "../dist/index.js";
import { blake3 } from "@noble/hashes/blake3";

function devnetSeed(i) {
  const prefix = new TextEncoder().encode("pyde-devnet-v1/");
  const idx = new Uint8Array(8);
  new DataView(idx.buffer).setBigUint64(0, BigInt(i), true);
  const input = new Uint8Array(prefix.length + idx.length);
  input.set(prefix, 0);
  input.set(idx, prefix.length);
  return blake3(input);
}
const toHex = (b) => "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

const rpc = process.env.PYDE_RPC_URL ?? "http://127.0.0.1:9933";
const provider = new Provider(rpc, { allowInsecureTransport: rpc.startsWith("http://") });

const kp = keypairFromSeed(toHex(devnetSeed(1)));
const wallet = Wallet.fromKeys(kp.publicKey, kp.secretKey);
wallet.connect(provider);

console.log("from:   ", wallet.address);
console.log("balance:", formatQuanta(await wallet.getBalance()), "PYDE");

const recipient = process.env.RECIPIENT_ADDRESS ?? "0x" + "aa".repeat(32);
const amount = parseQuanta("0.1");

const receipt = await wallet.transfer(recipient, amount);
console.log("tx:     ", receipt.txHash);
console.log("status: ", receipt.success ? "success" : "reverted");
console.log("gas:    ", parseInt(receipt.gasUsed.replace(/^0x/, ""), 16));
console.log("balance after:", formatQuanta(await wallet.getBalance()), "PYDE");
console.log("recipient now:", formatQuanta(await provider.getBalance(recipient)), "PYDE");
