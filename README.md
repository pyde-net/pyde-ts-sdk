# pyde-ts-sdk

> TypeScript SDK for [Pyde](https://pyde.network) — the blockchain network.

Post-quantum, MEV-resistant by construction, and cross-chain by certificate. This SDK gives dapps, wallets, indexers, and backend services everything they need to read state, build + sign + submit transactions (including the MEV-protected encrypted flow), subscribe to live events, and integrate browser wallets.

- **HTTP + WebSocket RPC** clients with the full Chapter 17 method surface
- **Handle-based signing** by default — FALCON-512 secret keys stay inside `pyde-crypto-wasm`'s WASM heap and never enter the JS heap
- **Encrypted-mempool submission** for MEV-resistant txs (`Wallet.sendEncrypted`)
- **Type-safe contracts** via the `pyde-tsgen` codegen CLI
- **Wallet adapter** pattern (`InMemoryWalletAdapter` + `BrowserWalletAdapter`) for dapp ↔ wallet wiring
- **Isomorphic** (browser + Node) where possible; Node-only paths are clearly flagged

## Status

Pre-1.0, in active development. Track progress under the project's task list; spec citations on every public surface tie each method back to the [Pyde Book](https://book.pyde.network).

## Install

```bash
npm install pyde-ts-sdk
```

## Quickstart

```ts
import { Provider, Wallet } from "pyde-ts-sdk";

const provider = new Provider("https://rpc.pyde.network");
const wallet = Wallet.generate(); // handle-backed; SK stays in WASM heap

wallet.connect(provider);
await wallet.registerPubkey(); // one-time per address
const receipt = await wallet.transfer(
  "0xrecipient...",
  1_000_000_000n, // 1 PYDE in quanta
);
console.log("tx:", receipt.txHash, "success:", receipt.success);
```

## Provider — HTTP RPC

```ts
import { Provider } from "pyde-ts-sdk";

const provider = new Provider("https://rpc.pyde.network", {
  timeout: 30_000,
  retries: 2,
  headers: { "x-trace-id": "..." },
});

// Account / state queries
await provider.getBalance(addr); // → bigint (quanta)
await provider.getNonce(addr); // → number
await provider.getAccount(addr); // → Account record (Chapter 11 §11.1)
await provider.getContractCode(addr); // → WASM bytes hex
await provider.getStorageSlot(slot); // → slot value hex (or null)
await provider.resolveName("alice.pyde"); // → 32-byte address or null

// Wave + finality
await provider.getWave(); // → latest WaveHeader
await provider.getWave(1234); // → specific wave
await provider.getHardFinalityCert(1234); // → threshold-signed cert
await provider.getSnapshotManifest(1234); // → light-client manifest

// View calls
await provider.call(to, data); // → return-data hex (free)
await provider.getWaveId(); // → bigint (current head)
// gas / access-list estimation: queued for Tier-2 (pyde_simulateTransaction wrapper).
// Today: Wallet.transfer / sendCall use fixed 100k / 5M defaults; pin `gasLimit` for tighter bounds.

// Tx lookup + receipts
await provider.getTransaction(txHash); // → TransactionInfo or null
await provider.getTransactionReceipt(txHash); // → Receipt or null
await provider.waitForReceipt(txHash, 10_000); // → Receipt (throws TimeoutError)

// Historical events (HOST_FN_ABI §15.4 — cursor pagination, 5k-wave cap)
const page = await provider.getLogs({
  fromWave: 1000,
  toWave: 2000,
  topics: [[transferTopic]],
  contract: tokenAddr,
  limit: 100,
});
for (const ev of page.events) {
  /* ... */
}
if (page.nextCursor) await provider.getLogs({ ...filter, cursor: page.nextCursor });
```

## WebSocketProvider — live subscriptions

```ts
import { WebSocketProvider } from "pyde-ts-sdk";

const ws = new WebSocketProvider("wss://rpc.pyde.network", {
  // Browser + Node 22+ use globalThis.WebSocket automatically.
  // Node 20 callers can pass require("ws") here:
  // webSocketConstructor: require("ws"),
});
await ws.ready;

const unsubscribe = await ws.subscribeLogs(
  { contract: "0xtoken...", topics: [[transferTopic]] },
  (log) => console.log("transfer:", log.waveId, log.topics, log.data),
);

// Later
await unsubscribe();
ws.destroy(); // tears down everything
```

`subscribeLogs` is the only `pyde_subscribe` topic the engine wires in catalog v0.1. `subscribeNewHeads` / `subscribeAccountChanges` exist on the SDK as forward-compat surfaces but throw `RpcError("logs only in v1; <topic> is not yet wired in the engine")` until the engine ships the extra topics.

Subscriptions are at-least-once with cursor-based resume after a reconnect (HOST_FN_ABI §15.5). The provider tracks each subscription's last delivered cursor and re-subscribes on reconnect with `from: lastCursor`. Listeners may see duplicates around a reconnect — dedupe by `(waveId, txIndex, eventIndex)` if you need exactly-once.

## Wallet — generate, sign, keystore

```ts
import { Wallet } from "pyde-ts-sdk";

// Recommended: handle-backed — SK stays in the WASM heap
const wallet = Wallet.generate();
console.log(wallet.address, wallet.publicKey);

// For keystore encryption (encrypt + discard)
const unsafe = Wallet.generateUnsafe();
const keystore = await unsafe.toKeystore("strong-passphrase");

// Restore from keystore
const restored = await Wallet.fromEncrypted(keystore, "strong-passphrase");

// Node-only file convenience
const w1 = await Wallet.fromKeystoreFile("/keys/alice.json", "passphrase");
await unsafe.saveKeystoreFile("/keys/alice.json", "passphrase");

// Sign / submit — `sendCall` runs a `pyde_simulateTransaction` probe
// for gas + access-list (1.2× safety multiplier on the simulate-
// reported gas_used by default; override via `opts.gasMultiplier`).
// `transfer` uses a fixed 100k gas — plain transfers don't execute code.
// Pin either via `opts.gasLimit` to skip the probe.
const sig = wallet.sign("0xdeadbeef");
const txReceipt = await wallet.sendCall(contractAddr, calldataHex);

// Wipe + drop the WASM-retained SK
wallet.destroy();
```

Keystore format matches `pyde keys generate` (Chapter 17): Argon2id KDF (default m=64MiB, t=3, p=4) + ChaCha20-Poly1305 AEAD. Defaults are tuned for ~250ms on a modern laptop.

## Encrypted (MEV-protected) submission

```ts
// Hex-SK wallet (handle wallets unsupported until pyde-crypto-wasm
// adds buildRawEncryptedTxWithHandle).
const wallet = Wallet.generateUnsafe();

const { envelopeHash, plaintextHash } = await wallet.sendEncrypted(
  contractAddr,
  calldata,
  {
    provider,
    value: 0n,
    deadline: 999_999n, // optional wave deadline
    // gasLimit: 1_000_000,             // omit to auto-estimate
    // estimateAccess: true,            // OFF by default — privacy leak
  },
);
// Receipts post-decryption are keyed by `plaintextHash`, not the
// envelope hash echoed back from the encrypted-mempool admit.
const receipt = await provider.waitForReceipt(plaintextHash);
```

The (to, value, calldata) tuple is threshold-encrypted against the committee pubkey before submission. No validator or RPC operator can read the call before the wave commits. Spec: Chapter 8.5 + Chapter 9.

## Contracts

```ts
import { Contract } from "pyde-ts-sdk";

// Load + bind
const counter = await Contract.fromArtifact(
  "out/Counter.bundle/Counter.abi.json", // otigen build output
  "0xcontract...",
  provider,
);
const withSigner = counter.connect(wallet);

// Read (view call)
const count = await counter.read("get_count"); // → decoded return

// Write (signed tx)
const receipt = await withSigner.write("deposit", { amount: 500n });
const decoded = receipt.decodeReturnData();

// Events
const transfers = await counter.queryFilter("Transfer", 1000n, 2000n);
const decoded = counter.parseLog(rawLog);
```

For type-safe contract bindings, use the codegen CLI:

```bash
npx pyde-tsgen out/Counter.bundle/Counter.abi.json types/counter.d.ts --name Counter
```

That emits `CounterContract` plus per-event interfaces with full TypeScript inference at the call site.

## Wallet adapters

Dapps shouldn't import a specific wallet's SDK. Accept any `WalletAdapter` at runtime:

```ts
import { InMemoryWalletAdapter, BrowserWalletAdapter, type WalletAdapter } from "pyde-ts-sdk";

// Backend / scripts / tests
const adapter: WalletAdapter = new InMemoryWalletAdapter(Wallet.generate());
await adapter.connect();
await adapter.sendTransaction(tx, provider);

// Browser dapp — talks to window.pyde (or wallet-specific namespace)
const adapter: WalletAdapter = new BrowserWalletAdapter();
await adapter.connect();
adapter.on("addressChange", () => /* re-fetch */);
```

Community wallets implement `WalletAdapter` directly; their packages ship the adapter class.

## Utility surface

```ts
import {
  // hex (isomorphic Uint8Array)
  isHexString,
  hexlify,
  getBytes,
  toBeHex,
  concat,
  zeroPadValue,
  stripZeros,
  dataLength,
  dataSlice,
  // units (PYDE / quanta, 9 decimals)
  parseQuanta,
  formatQuanta,
  // addresses
  Address,
  // errors
  PydeError,
  CallExceptionError,
  ConnectionError,
  TimeoutError,
  InvalidArgumentError,
  InsufficientFundsError,
  RpcError,
  SigningError,
  isError,
  isCallException,
} from "pyde-ts-sdk";
```

`parseQuanta` / `formatQuanta` are the PYDE ↔ quanta helpers (9 decimals per Chapter 10). Use `parseUnits` / `formatUnits` for generic-decimal math.

## Crypto surface

```ts
import {
  generateKeypairHandle,
  dropKeypair,
  signMessageWithHandle,
  signTransactionWithHandle,
  generateKeypair,
  signMessage,
  signTransaction, // hex variants
  deriveAddress,
  poseidon2Hash,
  verifySignature,
  computeSelector,
  buildRawEncryptedTx,
  thresholdEncrypt, // MEV-protected flow
  encodeRegisterPubkeyTx,
} from "pyde-ts-sdk";
```

Everything routes to `pyde-crypto-wasm` — the SDK does not implement primitives. Handle-based variants keep the FALCON-512 secret key inside the WASM heap; the hex variants exist for keystore encryption flows (encrypt + discard).

## Spec citations

Every public type and method carries a TSDoc reference to the spec section it implements. Quick map:

| Surface                       | Spec                                |
| ----------------------------- | ----------------------------------- |
| Account record                | Chapter 11 §11.1                    |
| TxType discriminants          | Chapter 11 §11.8                    |
| Wave + HardFinalityCert       | Chapter 6                           |
| Snapshot manifest             | STATE_SYNC.md                       |
| Receipt + fee fields          | Chapter 10                          |
| Log + EventCursor + LogFilter | HOST_FN_ABI §15.2 + §15.4           |
| Subscription mechanics        | HOST_FN_ABI §15.5                   |
| Keystore format               | Chapter 17 (`pyde keys generate`)   |
| Cryptographic primitives      | Chapter 8.2 / 8.3 / 8.4 / 8.5       |
| ABI codec + selector          | SDK_AUTHOR_GUIDE + HOST_FN_ABI §3.7 |
| MEV-protected submission      | Chapter 8.5 + Chapter 9             |

The full book lives at [book.pyde.network](https://book.pyde.network).

## Migration from the pre-pivot SDK

The pre-pivot SDK targeted a different consensus + execution layer. Most APIs survive in shape; specific changes:

- The SDK speaks the engine RPC catalog v0.1 verbatim: `pyde_chainId`, `pyde_waveId`, `pyde_getBalance`, `pyde_getTransactionCount`, `pyde_getAccount`, `pyde_getContractCode`, `pyde_getStorageSlot`, `pyde_resolveName`, `pyde_call`, `pyde_sendRawTransaction`, `pyde_getTransactionReceipt`, `pyde_getTx`, `pyde_getWave`, `pyde_getHardFinalityCert`, `pyde_getSnapshotManifest`, `pyde_getLogs`, `pyde_subscribe` / `pyde_unsubscribe` (logs only in v1). Gas / access-list estimation, encrypted-mempool submission, validator / node / metrics endpoints, and archival `pyde_getReceipt` / full `pyde_getSnapshot` ride a Tier-2 follow-up.
- **`BlockHeader` → `WaveHeader`** (`slot` → `waveId`, adds `anchor`). Wave, not block.
- **`Log` carries `(waveId, txIndex, eventIndex)`** cursor coords for at-least-once delivery.
- **`LogFilter.fromBlock / toBlock` → `fromWave / toWave`**, plus `cursor` and `limit` for HOST_FN_ABI §15.4 cursor pagination.
- **`provider.getLogs` now returns `GetLogsResponse`** (not `Log[]`) — `.events` + optional `.nextCursor`.
- **`Wallet.fromPrivateKey` / `exportPrivateKey` are gone** — the combined-key hex format was pre-pivot. Use `Wallet.fromKeys(pk, sk)` for restoration.
- **`Wallet.fromKeystore(path)` → `Wallet.fromKeystoreFile(path)`** (now async; returns `Promise<Wallet>`). The keystore format itself swapped Poseidon2-derived AES-256-GCM for Argon2id + ChaCha20-Poly1305 to match `pyde keys generate`.
- **TxType**: id 0 is now `Standard` (covers transfers + contract calls); id 2 is vacant (was `Batch`, removed pre-mainnet); add 11 other variants documented in Chapter 11 §11.8.
- **Wallet methods** moved to opts-object style:
  ```ts
  // before
  await wallet.sendCall(provider, to, data, gasLimit, value);
  // after
  await wallet.sendCall(to, data, { provider, gasLimit, value });
  ```
- **`Buffer` → `Uint8Array`** in `hex.ts` public surface (Node `Buffer` still accepted since it extends `Uint8Array`).

Module-level changes:

- **`./codegen`** sub-entry + **`pyde-tsgen` CLI bin** — type-safe contract bindings from `*.abi.json`.
- **`WalletAdapter` interface** + `InMemoryWalletAdapter` / `BrowserWalletAdapter` — new in the post-pivot SDK.

## License

Apache-2.0 © Pyde Network
