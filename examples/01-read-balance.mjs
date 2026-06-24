/**
 * Built-dist runner mirror of 01-read-balance.ts. Exists because
 * tsx can't load the `pyde-crypto-wasm` `.wasm` import directly;
 * the built `dist/index.js` is a self-contained ESM bundle that
 * Node can load with `--experimental-wasm-modules`.
 *
 * Run:
 *   npm run build
 *   node --experimental-wasm-modules examples/01-read-balance.mjs <address>
 */
import { Provider, formatQuanta, AccountType } from "../dist/index.js";

const address = process.argv[2];
if (!address) {
  console.error("usage: node --experimental-wasm-modules examples/01-read-balance.mjs <address>");
  process.exit(1);
}

const rpc = process.env.PYDE_RPC_URL ?? "http://127.0.0.1:9933";
const provider = new Provider(rpc, { allowInsecureTransport: rpc.startsWith("http://") });

const [balance, nonce, account] = await Promise.all([
  provider.getBalance(address),
  provider.getNonce(address),
  provider.getAccount(address),
]);

console.log("address:    ", address);
console.log("balance:    ", balance.toString(), "quanta");
console.log("           =", formatQuanta(balance), "PYDE");
console.log("nonce:      ", nonce);
if (account) {
  const kind =
    account.accountType === AccountType.EOA
      ? "EOA"
      : account.accountType === AccountType.Contract
        ? "Contract"
        : "System";
  console.log("account:    ", kind);
  console.log("code hash:  ", account.codeHash);
  console.log("gas tank:   ", account.gasTank.toString(), "quanta");
} else {
  console.log("account:     not registered on-chain");
}
