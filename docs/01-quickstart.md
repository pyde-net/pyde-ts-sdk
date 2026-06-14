# 01 — Quickstart

Three flows in five minutes: **read** a balance, **send** a transfer, **call** a deployed contract.

[← TOC](./README.md)

---

## Setup

```bash
npm install pyde-ts-sdk
```

In another shell, start a local devnet (single validator, instant-wave):

```bash
otigen devnet --rpc-listen 127.0.0.1:9933
```

The banner prints 10 prefunded accounts — copy `devnet-0`'s address for the read example.

## 1. Read a balance

```ts
import { Provider, formatQuanta } from "pyde-ts-sdk";

const provider = new Provider("http://127.0.0.1:9933", {
  allowInsecureTransport: true, // required for `http://` — see ProviderOptions
});

const addr = "0xf07856fdf4796baa6d477ddfe926774d367b25c20e8c7d9d337b63034c9e0cfa";
const balance = await provider.getBalance(addr);

console.log(formatQuanta(balance), "PYDE"); // "10.0 PYDE"
```

That's it. `getBalance` returns a `bigint` in quanta (PYDE has 9 decimals); `formatQuanta` is the pretty-print helper.

## 2. Send a transfer

```ts
import { Provider, Wallet, parseQuanta } from "pyde-ts-sdk";

const provider = new Provider("https://rpc.pyde.network");

// Handle-backed wallet — SK lives in the WASM heap, never enters JS.
const wallet = Wallet.generate();
wallet.connect(provider);

// One-time: register the wallet's public key on chain so future txs can be
// authenticated against it. Costs gas; sender's address must hold balance.
await wallet.registerPubkey();

// Standard transfer — gas auto-estimates with a 1.2× safety multiplier.
const receipt = await wallet.transfer(
  "0xrecipient0000000000000000000000000000000000000000000000000000addr",
  parseQuanta("1.5"), // 1.5 PYDE → 1_500_000_000 quanta
);

console.log("tx:", receipt.txHash, "success:", receipt.success);

// Clean up — wipes the SK from the WASM heap.
wallet.destroy();
```

Notes:
- `Wallet.generate()` is the recommended path. SK never leaves the WASM heap; even a JS heap dump can't recover it.
- `transfer(to, amount)` accepts a `bigint`, `number`, or decimal string. Use `bigint` literals for new code (`parseQuanta` returns `bigint`).
- `receipt.success === false` means the chain rejected the tx — inspect `receipt.events` for the revert reason.

## 3. Deploy + call a contract

For the deploy step we use the `otigen` CLI (the SDK does not ship a deploy command — the bundle format + WASM hash gating is the toolchain's job).

```bash
# Once per session — import the devnet prefunded keys into otigen's keystore.
echo "test-pw" | otigen wallet import --from-devnet --password-stdin

# Deploy your bundle from devnet-0 (pays gas).
echo "test-pw" | otigen deploy \
  --bundle ./artifacts/counter.bundle \
  --from devnet-0 \
  --password-stdin \
  --network devnet \
  --json
# → emits NDJSON, the last line carries `contract_address`.
```

From TypeScript, point a `Contract` at the deployed address and call:

```ts
import { Provider, Contract } from "pyde-ts-sdk";

const provider = new Provider("http://127.0.0.1:9933", { allowInsecureTransport: true });

// Load ABI from the otigen build artifact (Node-only).
const counter = await Contract.fromArtifact(
  "./artifacts/counter.bundle/abi.json",
  "0xcontract0000000000000000000000000000000000000000000000000000addr",
  provider,
);

// View call — encoded args + decoded return via the borsh codec.
const count = await counter.read("get_count");
console.log("count:", count); // 0n
```

For write calls, attach a signer:

```ts
import { Wallet } from "pyde-ts-sdk";

const wallet = Wallet.generate();
wallet.connect(provider);
await wallet.registerPubkey();

const withSigner = counter.connect(wallet);
const receipt = await withSigner.write("increment");

console.log(receipt.success ? "incremented" : "reverted");
```

### Type-safe contracts

For full method-name + arg + return type narrowing, generate ABI bindings with `pyde-tsgen`:

```bash
npx pyde-tsgen ./artifacts/counter.bundle/abi.json ./types/counter.d.ts --name Counter
```

That emits a `CounterAbi` shape; bind it to the generic:

```ts
import type { CounterAbi } from "./types/counter";

const counter = await Contract.fromArtifact<CounterAbi>(
  "./artifacts/counter.bundle/abi.json",
  "0xcontract...",
  provider,
);

await counter.read("get_count"); // ✅ → Promise<bigint>
await counter.read("getCount");  // ❌ type error — unknown method
await counter.write("deposit", { amount: 5n }); // ✅
await counter.write("deposit", { amount: "5" }); // ❌ type error — amount must be bigint
```

See [Chapter 04](./04-contract.md) for the full Contract API and [Chapter 05](./05-codegen.md) for the codegen reference.

## Where next?

| If you want to… | Read |
|---|---|
| Tune retries / timeouts / batching | [02 — Provider](./02-provider.md) |
| Keystore + load encrypted SK from disk | [03 — Wallet](./03-wallet.md) |
| Encode complex args (`Vec<Order>`, enums) | [04 — Contract](./04-contract.md) |
| Subscribe to new waves / events live | [08 — WebSocket](./08-websocket.md) |
| MEV-protected (encrypted) submission | [09 — Encrypted mempool](./09-encrypted-mempool.md) |
| Build a dapp with React hooks | [06 — React](./06-react.md) |
