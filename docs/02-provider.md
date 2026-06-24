# 02 — Provider

HTTP JSON-RPC client for a Pyde node. **Use this when you need to read chain state, submit signed transactions, or compose batch reads.**

[← TOC](./README.md)

---

## Table of contents

- [Quick start](#quick-start)
- [Construction](#construction)
- [`ProviderOptions` — every field explained](#provideroptions--every-field-explained)
- Read surface
  - [`getBalance(address)`](#getbalanceaddress)
  - [`getNonce(address)`](#getnonceaddress)
  - [`getChainId()`](#getchainid)
  - [`getNonceAndChainId(address)`](#getnonceandchainidaddress)
  - [`getAccount(address)`](#getaccountaddress)
  - [`getContractCode(address)`](#getcontractcodeaddress)
  - [`getStorageSlot(slotHash)`](#getstorageslotslothash)
  - [`getWaveId()`](#getwaveid)
  - [`getBaseFee()`](#getbasefee)
  - [`getFeeData()`](#getfeedata)
  - [`resolveName(name)`](#resolvenamename)
  - [`getWave(waveId?)`](#getwavewaveid)
  - [`getHardFinalityCert(waveId)`](#gethardfinalitycertwaveid)
  - [`getSnapshot()`](#getsnapshot)
  - [`getSnapshotManifest()`](#getsnapshotmanifest)
- View calls + simulation
  - [`call(to, data, overrides?)`](#callto-data-overrides)
  - [`simulateTransaction(signedTxHex)`](#simulatetransactionsignedtxhex)
- Write surface
  - [`sendRawTransaction(signedTxHex)`](#sendrawtransactionsignedtxhex)
  - [`sendRawEncryptedTransaction(encTxHex)`](#sendrawencryptedtransactionenctxhex)
  - [`getThresholdPublicKey()`](#getthresholdpublickey)
- Receipts + waiting
  - [`getTransaction(txHash)`](#gettransactiontxhash)
  - [`getTransactionReceipt(txHash)`](#gettransactionreceipttxhash)
  - [`getReceiptArchival(txHash)`](#getreceiptarchivaltxhash)
  - [`waitForReceipt(txHash, timeoutMs?)`](#waitforreceipttxhash-timeoutms)
  - [`sendAndWait(signedTxHex, timeoutMs?)`](#sendandwaitsignedtxhex-timeoutms)
- Logs + events
  - [`getLogs(filter)`](#getlogsfilter)
  - [`getEvents(filter?)`](#geteventsfilter)
- Validators
  - [`getValidator(address)`](#getvalidatoraddress)
  - [`getOperatorValidators(address)`](#getoperatorvalidatorsaddress)
- Node introspection
  - [`getNodeInfo()`](#getnodeinfo)
  - [`getMetrics()`](#getmetrics)
- Batch RPC
  - [`batch(calls)`](#batchcalls)
- [Retry semantics](#retry-semantics)
- [Errors](#errors)
- [Gotchas](#gotchas)

---

## Quick start

```ts
import { Provider, formatQuanta } from "pyde-ts-sdk";

const provider = new Provider("https://rpc.pyde.network");

const balance = await provider.getBalance("0xaddress...");
console.log(`${formatQuanta(balance)} PYDE`);
```

**Expected output:**

```
10.5 PYDE
```

---

## Construction

```ts
new Provider(rpcUrl: string, options?: ProviderOptions)
```

**Args:**

| Name      | Type              | Required | Description                                                             |
| --------- | ----------------- | -------- | ----------------------------------------------------------------------- |
| `rpcUrl`  | `string`          | yes      | HTTPS endpoint. `http://` throws unless `allowInsecureTransport: true`. |
| `options` | `ProviderOptions` | no       | Timeouts, retries, custom headers.                                      |

**Returns:** `Provider` instance.

**Throws:** `InvalidArgumentError` when `rpcUrl` starts with `http://` and `allowInsecureTransport` is not set.

**Example — production:**

```ts
const provider = new Provider("https://rpc.pyde.network", {
  timeout: 30_000,
  retries: 2,
});
```

**Example — local devnet:**

```ts
const provider = new Provider("http://127.0.0.1:9933", {
  allowInsecureTransport: true,
});
```

---

## `ProviderOptions` — every field explained

```ts
interface ProviderOptions {
  timeout?: number;
  retries?: number;
  headers?: Record<string, string>;
  allowInsecureTransport?: boolean;
}
```

| Field                    | Type                     | Default  | What it does                                                                                                                                                                          |
| ------------------------ | ------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `timeout`                | `number` (ms)            | `30_000` | Per-request timeout. The fetch is aborted when this elapses; the call rejects with `TimeoutError`.                                                                                    |
| `retries`                | `number`                 | `0`      | Number of retries on **transport** errors (`fetch` threw, 5xx, `ECONNRESET`). Exponential backoff between attempts. Does **not** retry on `RpcError` — those mean the chain answered. |
| `headers`                | `Record<string, string>` | `{}`     | Custom HTTP headers merged into every request. Useful for API keys, trace IDs, etc.                                                                                                   |
| `allowInsecureTransport` | `boolean`                | `false`  | Required to use `http://`. Production should never set this.                                                                                                                          |

**Example — auth header + tight timeout:**

```ts
const provider = new Provider("https://rpc.pyde.network", {
  timeout: 10_000,
  headers: { "x-api-key": process.env.PYDE_KEY! },
});
```

**Example — retry on flaky network:**

```ts
const provider = new Provider("https://rpc.pyde.network", {
  retries: 3, // attempts = 1 initial + 3 retries = 4 total
  timeout: 5_000,
});
```

---

## `getBalance(address)`

Get the spendable balance of an address.

**Spec:** Chapter 17.4 · RPC method `pyde_getBalance`

**Signature:**

```ts
provider.getBalance(address: string): Promise<bigint>
```

**Args:**

| Name      | Type     | Description                            |
| --------- | -------- | -------------------------------------- |
| `address` | `string` | `0x`-prefixed 64 hex chars (32 bytes). |

**Returns:** `Promise<bigint>` — balance in **quanta** (1 PYDE = 10⁹ quanta). Use `formatQuanta` to render as a PYDE string.

**Example:**

```ts
const balance = await provider.getBalance(
  "0xf07856fdf4796baa6d477ddfe926774d367b25c20e8c7d9d337b63034c9e0cfa",
);
console.log("balance:", balance, "quanta");
console.log("balance:", formatQuanta(balance), "PYDE");
```

**Expected output:**

```
balance: 10000000000n quanta
balance: 10.0 PYDE
```

**Errors:**

- `RpcError` — chain returned an error (e.g., `pyde_getBalance` not implemented).
- `InvalidArgumentError` — malformed address.
- `TimeoutError` — request exceeded `options.timeout`.

---

## `getNonce(address)`

Get the next available nonce slot in the 16-slot sliding window.

**Spec:** Engine RPC catalog v0.1 §4 · RPC method `pyde_getTransactionCount`

**Signature:**

```ts
provider.getNonce(address: string): Promise<bigint>
```

**Args:**

| Name      | Type     | Description                    |
| --------- | -------- | ------------------------------ |
| `address` | `string` | `0x`-prefixed 32-byte address. |

**Returns:** `Promise<bigint>` — next available nonce. `bigint` because chain nonces are u64; `number` would silently truncate above 2⁵³.

**Example:**

```ts
const nonce = await provider.getNonce("0xaddr...");
console.log("nonce:", nonce);
```

**Expected output:**

```
nonce: 42n
```

**Notes:**

- 16-slot window means up to 16 unconfirmed txs can be in flight (Chapter 11 §11.4).
- Returns `0n` for fresh accounts.

---

## `getChainId()`

Get the chain ID this RPC serves. **Cached per Provider instance** after the first call.

**Spec:** Chapter 17.4 · RPC method `pyde_chainId`

**Signature:**

```ts
provider.getChainId(): Promise<number>
```

**Returns:** `Promise<number>` — chain ID. Standard values: `1` = mainnet, `31337` = devnet.

**Example:**

```ts
const chainId = await provider.getChainId();
console.log("chain:", chainId);
```

**Expected output:**

```
chain: 31337
```

**Notes:**

- Chain ID is **genesis-immutable** — the SDK caches it after the first call.
- To clear the cache: construct a new `Provider`.

---

## `getNonceAndChainId(address)`

Batch fetch of nonce + chainId in a single round-trip. Used internally when building a transaction.

**Signature:**

```ts
provider.getNonceAndChainId(address: string): Promise<[bigint, number]>
```

**Args:**

| Name      | Type     | Description                    |
| --------- | -------- | ------------------------------ |
| `address` | `string` | `0x`-prefixed 32-byte address. |

**Returns:** `Promise<[bigint, number]>` — `[nonce, chainId]` tuple.

**Example:**

```ts
const [nonce, chainId] = await provider.getNonceAndChainId("0xaddr...");
console.log(`nonce=${nonce} chainId=${chainId}`);
```

**Expected output:**

```
nonce=0n chainId=31337
```

---

## `getAccount(address)`

Fetch the full account record.

**Spec:** Chapter 17.4 · RPC method `pyde_getAccount`

**Signature:**

```ts
provider.getAccount(address: string): Promise<Account | null>
```

**Args:**

| Name      | Type     | Description                    |
| --------- | -------- | ------------------------------ |
| `address` | `string` | `0x`-prefixed 32-byte address. |

**Returns:** `Promise<Account | null>`:

- `null` — no account record on chain (never been touched).
- `Account` — populated record.

**`Account` shape:**

```ts
interface Account {
  address: string; // 0x + 64 hex
  nonce: bigint; // u64
  balance: bigint; // u128 quanta
  codeHash: string; // 0x + 64 hex; "0x" + 64*"0" for EOAs
  storageRoot: string; // 0x + 64 hex
  accountType: AccountType; // EOA | Contract | System
  authKeys: string; // hex
  gasTank: bigint; // u128 quanta — paymaster pool
  keyNonce: number; // for key rotation events
}
```

**Example:**

```ts
const account = await provider.getAccount("0xaddr...");
if (account === null) {
  console.log("never touched on chain");
} else {
  console.log("type:", account.accountType);
  console.log("balance:", account.balance);
  console.log("nonce:", account.nonce);
}
```

**Expected output:**

```
type: 0
balance: 10000000000n
nonce: 0n
```

**Notes:**

- `null` vs zero-balance EOA are distinguished — see the M-4 fix in [docs/13-migration.md](./13-migration.md).

---

## `getContractCode(address)`

Get a contract's WASM bytecode as hex.

**Spec:** Chapter 17.4 · RPC method `pyde_getContractCode`

**Signature:**

```ts
provider.getContractCode(address: string): Promise<string>
```

**Args:**

| Name      | Type     | Description       |
| --------- | -------- | ----------------- |
| `address` | `string` | Contract address. |

**Returns:** `Promise<string>` — `0x`-prefixed hex of the WASM module bytes, or `"0x"` (empty) for EOAs.

**Example:**

```ts
const code = await provider.getContractCode("0xcontract...");
if (code === "0x") {
  console.log("EOA — no code");
} else {
  console.log("WASM size:", (code.length - 2) / 2, "bytes");
}
```

**Expected output:**

```
WASM size: 27121 bytes
```

---

## `getStorageSlot(slotHash)`

Get the value at a single global storage slot key. Returns `null` if the slot was never written.

**Spec:** Engine RPC catalog v0.1 §13 · RPC method `pyde_getStorageSlot`

**Signature:**

```ts
provider.getStorageSlot(slotHash: string): Promise<string | null>
```

**Args:**

| Name       | Type     | Description                                                                               |
| ---------- | -------- | ----------------------------------------------------------------------------------------- |
| `slotHash` | `string` | `0x`-prefixed 32-byte **global** key. Slots are global in v1 — no per-contract iteration. |

**Returns:** `Promise<string \| null>` — slot value hex, or `null` if the slot was never written.

**Note:** The caller computes the full key. v1 has no JMT prefix-iteration primitive, so there's no `pyde_getContractState`.

**Canonical derivation** (HOST_FN_ABI_SPEC §7.1):

```text
slot = Poseidon2(self_address || field_bytes [|| key_bytes])
```

- `self_address` — 32-byte contract address.
- `field_bytes` — arbitrary bytes the contract author picked (e.g., `b"balances"`), **not** a numeric slot index. Contracts emit them verbatim from the storage field's declared name.
- `key_bytes` — optional, used for mapping-style fields like `balances[user_address]`.

Raw and typed-storage host-fn paths share the same preimage, so tools that resolve a slot from a schema read the same slot the contract writes.

`poseidon2Hash(dataHex)` takes a `0x`-prefixed hex string for the full preimage and returns the 32-byte slot key as `0x` + 64 hex.

**Example — read a scalar field `count`:**

```ts
import { poseidon2Hash, hexlify, concat } from "pyde-ts-sdk";

const contract = "0xcontract...";

// preimage = self_address || field_bytes ("count" UTF-8)
const fieldHex = hexlify(new TextEncoder().encode("count"));
const preimage = concat([contract, fieldHex]);

const slotKey = poseidon2Hash(preimage);
const value = await provider.getStorageSlot(slotKey);
console.log("count slot:", value);
```

**Example — read a mapping entry `balances[user]`:**

```ts
const userAddr = "0xuser...";

// preimage = self_address || field_bytes ("balances") || key_bytes (user addr)
const fieldHex = hexlify(new TextEncoder().encode("balances"));
const preimage = concat([contract, fieldHex, userAddr]);

const slotKey = poseidon2Hash(preimage);
const balance = await provider.getStorageSlot(slotKey);
console.log("balance hex:", balance);
```

**Expected output:**

```
slot 0: 0x0000000000000001
```

---

## `resolveName(name)`

Resolve a Pyde Name Service `*.pyde` name to its 32-byte address.

**Signature:**

```ts
provider.resolveName(name: string): Promise<string | null>
```

**Args:**

| Name   | Type     | Description                              |
| ------ | -------- | ---------------------------------------- |
| `name` | `string` | A registered name, e.g., `"alice.pyde"`. |

**Returns:** `Promise<string | null>`:

- `string` — the 32-byte address (hex).
- `null` — name not registered.

**Example:**

```ts
const addr = await provider.resolveName("alice.pyde");
console.log(addr ?? "not registered");
```

**Expected output:**

```
0x0cf4448bb99519a4aa04c7a5ee740483434f1b4bd234dc50e5032af30815e250
```

---

## `getWave(waveId?)`

Get the wave header for a specific wave id.

**Spec:** Chapter 6 · RPC method `pyde_getWave`

**Signature:**

```ts
provider.getWave(waveId?: Wave): Promise<WaveHeader | null>
```

**Args:**

| Name     | Type                | Description                                                               |
| -------- | ------------------- | ------------------------------------------------------------------------- |
| `waveId` | `bigint` (optional) | Specific wave id. Omit for "latest committed" — currently engine-blocked. |

**Returns:** `Promise<WaveHeader | null>` — header or `null` if the wave isn't on chain (e.g., asked for a future wave).

**`WaveHeader` shape:**

```ts
interface WaveHeader {
  waveId: bigint;
  timestamp: string;
  anchor: string; // 0x + 64 hex; canonical anchor hash
  stateRoot?: string; // 0x + 64 hex
  eventsRoot?: string; // 0x + 64 hex
  txCount?: number;
}
```

**Example:**

```ts
const head = await provider.getWave(0n);
if (head) {
  console.log("waveId:", head.waveId);
  console.log("anchor:", head.anchor);
  console.log("txCount:", head.txCount);
}
```

**Expected output:**

```
waveId: 0n
anchor: 0x17a219ada3881881d056334ecd5af5b3e30c29e7b4e43daafacb54cc8c2d5272
txCount: 0
```

**Gotchas:**

- The no-arg `getWave()` path needs `pyde_getWaveNumber` / `pyde_blockNumber`; neither is exposed on devnet today. Always pass an explicit `waveId` in the meantime.
- The wave header wire shape varies — see [internals → wave header tolerance](./14-internals.md#wave-header-tolerance).

---

## `getHardFinalityCert(waveId)`

Get the threshold-signed hard-finality certificate for a wave.

**Spec:** Engine RPC catalog v0.1 §24 · RPC method `pyde_getHardFinalityCert`

**Signature:**

```ts
provider.getHardFinalityCert(waveId: number | bigint): Promise<HardFinalityCert | null>
```

**Args:**

| Name     | Type               | Description                                                     |
| -------- | ------------------ | --------------------------------------------------------------- |
| `waveId` | `number \| bigint` | Wave id. Engine expects a bare u64 number on the wire (not hex). |

**Returns:** `Promise<HardFinalityCert | null>` — certificate or `null` if the wave hasn't reached hard finality.

**Status:** Single-validator devnet can't produce the ≥85 (`QUORUM`) signatures finalisation requires, so this returns `null` for every wave there. Method also currently returns `-32601` on otigen devnet (catalog method listed but not yet wired) — the SDK surfaces that cleanly as `RpcError`. Lights up on multi-validator testnet + matching otigen build.

**Example:**

```ts
const cert = await provider.getHardFinalityCert(1000);
console.log("finalized:", cert !== null);
```

**Expected output:**

```
finalized: true
```

---

## `getSnapshot()`

Fetch the full state snapshot at the state store's `last_flushed_wave`.

**Spec:** Engine RPC catalog v0.1 §25 · RPC method `pyde_getSnapshot`

**Signature:**

```ts
provider.getSnapshot(): Promise<string>
```

**Returns:** `Promise<string>` — standard-base64 (RFC 4648 §4, **not** URL-safe) encoding the borsh-encoded `SnapshotBundle { manifest, chunks }`. Multi-MB on populated chains; consumers base64-decode → borsh-decode → `SnapshotLoader::apply`. The loader verifies per-chunk Blake3 + state-root, so transport integrity is enforced at the consumer.

**Example:**

```ts
const blob = await provider.getSnapshot();
console.log("snapshot bytes (base64):", blob.length);
// Pipe into a SnapshotLoader, or persist for a fresh node bootstrap.
```

---

## `getSnapshotManifest()`

Just the snapshot manifest — small wire payload, useful to pin a `--state-sync-checkpoint` without downloading the body.

**Spec:** Engine RPC catalog v0.1 §26 · RPC method `pyde_getSnapshotManifest`

**Signature:**

```ts
provider.getSnapshotManifest(): Promise<SnapshotManifest | null>
```

**Returns:** `Promise<SnapshotManifest | null>`:

```ts
interface SnapshotManifest {
  waveId: bigint;        // wave the manifest was built at (last_flushed_wave)
  stateRoot: string;     // Blake3 root of the snapshot at waveId
  chunkSize: number;     // bytes per chunk
  chunkCount: number;    // number of chunks comprising the snapshot
  chunkHashes: string[]; // Blake3 hash per chunk, in positional order
  totalKeys: number;     // total state keys captured
}
```

The engine takes no params — it always returns the manifest at the state store's current `last_flushed_wave`.

**Example:**

```ts
const manifest = await provider.getSnapshotManifest();
if (manifest) {
  console.log("at wave:", manifest.waveId);
  console.log("chunks:", manifest.chunkCount, "x", manifest.chunkSize, "bytes");
  console.log("state root:", manifest.stateRoot);
}
```

**Notes:**

- v1 ships single Blake3 state-root + flat `chunkHashes`. Dual-root (Blake3 + Poseidon2) + committee signatures (per the state-sync book design) are deferred until the archival service ships.

---

## `getWaveId()`

Return the current head wave id. Pyde's analogue of EVM `block.number`.

**Spec:** Engine RPC catalog v0.1 §2 · RPC method `pyde_waveId`

**Signature:**

```ts
provider.getWaveId(): Promise<Wave>
```

**Returns:** `Promise<bigint>` — current committed head.

**Example:**

```ts
const head = await provider.getWaveId();
console.log("head:", head);
```

**Expected output:**

```
head: 12345n
```

Used internally by `getWave()` when no wave id is passed.

---

## `getBaseFee()`

Current network base fee per gas unit.

**Spec:** Engine RPC catalog v0.1 · Chapter 10 — EIP-1559-per-wave · RPC method `pyde_getBaseFee`

**Signature:**

```ts
provider.getBaseFee(): Promise<bigint>
```

**Returns:** `Promise<bigint>` — base fee in quanta per gas unit.

**Example:**

```ts
const baseFee = await provider.getBaseFee();
console.log("baseFee:", baseFee, "quanta/gas");
```

The base fee floats per wave per Chapter 10's EIP-1559-style adjustment, anchored to recent wave gas utilisation. v1 has no priority tips, so `gasPrice === baseFee` (see [`getFeeData()`](#getfeedata)).

---

## `getFeeData()`

Current fee data — base fee, derived gas price, and recent-wave utilisation snapshots.

**Spec:** Engine RPC catalog v0.1 · Chapter 10 · RPC method `pyde_getFeeData`

**Signature:**

```ts
provider.getFeeData(): Promise<FeeData>

interface FeeData {
  /** Effective gas price (= baseFee in v1; no priority fees). */
  gasPrice: bigint;
  /** Base fee per gas unit. */
  baseFee: bigint;
}
```

**Returns:** `Promise<FeeData>` — `{baseFee, gasPrice}` where `gasPrice = baseFee + suggested_tip`. v1's suggested tip is always 0, so `gasPrice === baseFee`.

**Example:**

```ts
const fd = await provider.getFeeData();
console.log("baseFee:", fd.baseFee, "gasPrice:", fd.gasPrice);
// → baseFee: 1n gasPrice: 1n
```

---

## `call(to, data, overrides?)`

Run an off-chain view call against current state.

**Spec:** Chapter 17.4 · RPC method `pyde_call`

**Signature:**

```ts
provider.call(to: string, data: string, overrides?: CallOverrides): Promise<string>
```

**Args:**

| Name        | Type                       | Description                                                                                            |
| ----------- | -------------------------- | ------------------------------------------------------------------------------------------------------ |
| `to`        | `string`                   | Contract address.                                                                                      |
| `data`      | `string`                   | Borsh-encoded `CallPayload {function, calldata}` bytes (hex). Usually built via `Contract.encodeCall`. |
| `overrides` | `CallOverrides` (optional) | `from`, `value`, `gasLimit` overrides for the simulation context.                                      |

**`CallOverrides`:**

```ts
interface CallOverrides {
  from?: string;
  value?: bigint | number | string;
  gasLimit?: number;
}
```

**Returns:** `Promise<string>` — `0x`-prefixed hex of the return value.

**Example — direct call (rare; prefer `Contract.read`):**

```ts
import { Contract } from "pyde-ts-sdk";
const counter = await Contract.fromArtifact(abi, addr, provider);

const calldata = counter.encodeCall("get_count");
const ret = await provider.call(addr, calldata);
console.log("ret hex:", ret);
```

**Expected output:**

```
ret hex: 0x2a00000000000000
```

(That's borsh-encoded `u64 = 42` — 8 LE bytes.)

**Errors:**

- `CallExceptionError` — call reverted. `.revertReason` carries the chain's message.
- `RpcError` — chain returned a JSON-RPC error.

---

## `simulateTransaction(signedTxHex)`

Dry-run a signed transaction against current state. Returns the would-be receipt + the read/write access list the run would touch. Powers gas + access-list inference for `Wallet.sendCall`.

**Spec:** Engine RPC catalog v0.1 §12 · RPC method `pyde_simulateTransaction`

**Signature:**

```ts
provider.simulateTransaction(signedTxHex: string): Promise<SimulateTransactionResult>
```

**`SimulateTransactionResult`:**

```ts
interface SimulateTransactionResult {
  receipt: Receipt | null;
  reads: string[];   // slot hashes the tx would read
  writes: string[];  // slot hashes the tx would write
}
```

**Returns:**

- `receipt: null` for plain native transfers (no execution to receipt).
- `receipt: Receipt` (with `gas_used`, `success`, `logs`, `return_data`) for contract calls.
- `reads` / `writes` — the access list the chain inferred during the dry-run. Use it to populate `opts.accessList` on real submits for parallel scheduling.

**Example — gas + access-list inference:**

```ts
const probe = wallet.signTransaction({ ...tx, gasLimit: 100_000_000 });
const sim = await provider.simulateTransaction(probe);

if (sim.receipt && sim.receipt.success) {
  const realGas = Math.ceil(parseInt(sim.receipt.gasUsed, 16) * 1.2);
  const accessList = [{
    address: tx.to,
    reads: sim.reads,
    writes: sim.writes,
  }];
  const signed = wallet.signTransaction({ ...tx, gasLimit: realGas });
  await provider.sendRawTransaction(signed);
}
```

`Wallet.sendCall` does this automatically: signs a probe tx, simulates, and re-signs with `gasUsed × gasMultiplier` (default `1.2`) plus the inferred access list. Falls back to a fixed 5,000,000 default on sim failure.

**Notes:**

- v1 has **no separate `pyde_estimateGas` / `pyde_estimateAccess`** — both responsibilities ride on this single endpoint.
- `Wallet.transfer` skips simulate and uses a fixed 100,000 default (plain transfers don't execute code; the chain doesn't ship a useful receipt for them).
- `Contract.estimateGas(...)` is a thin wrapper that returns 5,000,000 + validates arg encoding; for tight bounds, build the populated tx and call this method directly.

---

## `sendRawTransaction(signedTxHex)`

Submit a signed transaction.

**Spec:** Chapter 17.4 · RPC method `pyde_sendRawTransaction`

**Signature:**

```ts
provider.sendRawTransaction(signedTxHex: string): Promise<TransactionResponse>
```

**Args:**

| Name          | Type     | Description                             |
| ------------- | -------- | --------------------------------------- |
| `signedTxHex` | `string` | Output of `wallet.signTransaction(tx)`. |

**Returns:** `Promise<TransactionResponse>`:

```ts
interface TransactionResponse {
  hash: string; // tx hash
  wait: (timeoutMs?: number) => Promise<Receipt>; // convenience receipt poll
}
```

**Important:** Does **not** wait for the tx to commit. Use `wait()` or `provider.waitForReceipt(hash)`.

**Example:**

```ts
const signed = wallet.signTransaction(tx);
const submitted = await provider.sendRawTransaction(signed);
console.log("submitted:", submitted.hash);

const receipt = await submitted.wait();
console.log("included:", receipt.success);
```

**Expected output:**

```
submitted: 0x3d352d22070ca9d42e6167c8f65a70923e0d105fa3e89b02b72f56f0db55fecb
included: true
```

---

## `sendRawEncryptedTransaction(encTxHex)`

Submit a threshold-encrypted tx (MEV-protected).

**Spec:** Chapter 8.5 · RPC method `pyde_sendRawEncryptedTransaction`

**Signature:**

```ts
provider.sendRawEncryptedTransaction(encTxHex: string): Promise<TransactionResponse>
```

See [Chapter 09 — encrypted mempool](./09-encrypted-mempool.md) for the construction flow. Most callers use `wallet.sendEncrypted` rather than calling this directly.

---

## `getThresholdPublicKey()`

Get the current committee's threshold encryption public key.

**Spec:** Engine RPC catalog v0.1 §20 · RPC method `pyde_getThresholdPublicKey`

**Signature:**

```ts
provider.getThresholdPublicKey(): Promise<ThresholdPublicKey | null>
```

**Returns:** `Promise<ThresholdPublicKey | null>`:

```ts
interface ThresholdPublicKey {
  epoch: bigint;     // u64 — epoch this key belongs to
  scheme: string;    // "mock" | "kyber-768" | "kyber-768-goldilocks" | …
  publicKey: string; // 0x-prefixed hex of the public key
}
```

- `null` if no DKG ceremony has run yet (chain at boot, no bootstrap, no real DKG epochs).
- `scheme: "mock"` is the v1 boot default — a deterministic mock pubkey under `epoch: 0` so the encrypted-mempool path is reachable from the first wave.
- `scheme: "kyber-768…"` (with optional parameter-set tag, e.g. `"kyber-768-goldilocks"` for the Goldilocks-prime accelerated build) means real DKG state is live and encrypted submissions will decrypt at wave-commit.

**Notes:**

- The key **rotates per epoch**. SDK refetches on every encrypted submission rather than caching.
- Used internally by `wallet.sendEncrypted` / `transferEncrypted`; rarely called directly.
- `wallet.sendEncrypted` warns when the scheme does **not** start with `"kyber-768"` — anything else (including `"mock"`) means submissions sit unprocessed on chain.

---

## `getTransaction(txHash)`

Look up a committed transaction by hash.

**Signature:**

```ts
provider.getTransaction(txHash: string): Promise<TransactionInfo | null>
```

**Returns:** `Promise<TransactionInfo | null>`:

- `null` — tx not on chain.
- Object with `txHash`, `waveId`, `txIndex`, `from`, `to`, `value`, `data`, `nonce`, `gasLimit`, `chainId`, etc.

**Example:**

```ts
const tx = await provider.getTransaction("0xhash...");
console.log("wave:", tx?.waveId);
console.log("from:", tx?.from);
```

---

## `getTransactionReceipt(txHash)`

Fetch a receipt by tx hash.

**Spec:** Chapter 17.4 · RPC method `pyde_getTransactionReceipt`

**Signature:**

```ts
provider.getTransactionReceipt(txHash: string): Promise<Receipt | null>
```

**Returns:** `Promise<Receipt | null>`:

- `null` — tx not yet committed (or never will be).
- `Receipt` — populated receipt.

**`Receipt` shape:**

```ts
interface Receipt {
  txHash: string;
  success: boolean;
  gasUsed: string; // 0x-prefixed hex
  effectiveGas: string; // 0x0 when chain doesn't ship it
  feePaid: string;
  feeBurned: string;
  feeValidator: string;
  returnData?: string;
  /** Structured reject payload on reverted receipts; null on success / out_of_gas. */
  revertReason: RevertReason | null;
  logs: Log[];
}

type RevertCategory = "EngineValidation" | "Contract" | "Vm";

interface RevertReason {
  /** Engine-categorised reject layer. Forward-compat string allowed. */
  category: RevertCategory | (string & {});
  /** Human-readable reason from that layer. Branch on `category`, not the string. */
  message: string;
}
```

`revertReason.category` is `"EngineValidation"` (pre-execution rejects: nonce window, fee balance, native handler reject), `"Contract"` (contract code called `revert(msg)` explicitly), or `"Vm"` (wasmtime trap / OOB / executor gas exhausted). `CallExceptionError` exposes `isEngineValidation` / `isContractRevert` / `isVmTrap` accessors that wrap the same field — see [Chapter 10 — Errors](./10-errors.md#callexceptionerror).

**Example:**

```ts
const receipt = await provider.getTransactionReceipt(hash);
if (receipt === null) {
  console.log("not yet committed");
} else if (receipt.success) {
  console.log("ok; gas used:", parseInt(receipt.gasUsed, 16));
} else {
  console.log("reverted:", receipt.revertReason?.category, receipt.revertReason?.message);
}
```

**Expected output:**

```
ok; gas used: 100000
```

---

## `getReceiptArchival(txHash)`

Fetch the archival raw-serde receipt by hash. **Different wire shape** from `getTransactionReceipt` — useful for explorers / indexers that need byte-array fields + JSON-number wave ids + PascalCase status (`"Success"` / `"Reverted"` / `"OutOfGas"`).

**Spec:** Engine RPC catalog v0.1 §21 · RPC method `pyde_getReceipt`

**Signature:**

```ts
provider.getReceiptArchival(txHash: string): Promise<unknown | null>
```

**Returns:** `Promise<unknown | null>` — the raw archival receipt object as-is (no SDK-side normalisation), or `null` when the tx isn't on chain.

**Example:**

```ts
const raw = await provider.getReceiptArchival(hash);
if (raw) {
  console.log("raw archival receipt:", raw);
  // Consume the byte-array tx_hash + raw integer wave_id directly.
}
```

**Notes:**

- The SDK returns this as `unknown` deliberately — archival consumers (block explorers, analytics pipelines) own the schema decode.
- For human / wallet flows use `getTransactionReceipt(txHash)` (canonical hex-string shape).

---

## `waitForReceipt(txHash, timeoutMs?)`

Poll until the receipt is available or `timeoutMs` elapses.

**Signature:**

```ts
provider.waitForReceipt(txHash: string, timeoutMs?: number): Promise<Receipt>
```

**Args:**

| Name        | Type     | Default  | Description                        |
| ----------- | -------- | -------- | ---------------------------------- |
| `txHash`    | `string` | required | Tx hash from `sendRawTransaction`. |
| `timeoutMs` | `number` | `10_000` | Stop polling after this many ms.   |

**Returns:** `Promise<Receipt>` — receipt once available.

**Throws:** `TimeoutError` if no receipt by `timeoutMs`.

**Example:**

```ts
const receipt = await provider.waitForReceipt(hash, 30_000);
console.log("included after waiting:", receipt.success);
```

**Polling cadence:** ~500 ms.

---

## `sendAndWait(signedTxHex, timeoutMs?)`

One-shot — submit + wait + throw on revert. Convenience for scripts.

**Signature:**

```ts
provider.sendAndWait(signedTxHex: string, timeoutMs?: number): Promise<Receipt>
```

**Throws:**

- `CallExceptionError` when `receipt.success === false` (with `gasUsed` + decoded `reason`).
- `TimeoutError` when no receipt by `timeoutMs`.
- `RpcError` when `sendRawTransaction` fails.

**Example:**

```ts
const receipt = await provider.sendAndWait(wallet.signTransaction(tx));
console.log("tx hash:", receipt.txHash);
```

---

## `getLogs(filter)`

Page historical event logs.

**Spec:** `HOST_FN_ABI_SPEC.md §15.4` · RPC method `pyde_getLogs`

**Signature:**

```ts
provider.getLogs(filter: LogFilter): Promise<GetLogsResponse>
```

**`LogFilter`:**

```ts
interface LogFilter {
  fromWave: Wave; // bigint
  toWave: Wave; // bigint
  topics?: (string[] | null)[]; // up to 4 positional slots
  contract?: string;
  cursor?: EventCursor;
  limit?: number; // default 100
}
```

**Returns:** `Promise<GetLogsResponse>`:

```ts
interface GetLogsResponse {
  events: Log[];
  nextCursor?: EventCursor;
}
```

**Example:**

```ts
const page = await provider.getLogs({
  fromWave: 0n,
  toWave: 1000n,
  contract: "0xtoken...",
  topics: [[transferTopic0]],
});
console.log(`got ${page.events.length} logs`);
if (page.nextCursor) {
  console.log("more pages — resume from", page.nextCursor);
}
```

**Expected output:**

```
got 47 logs
more pages — resume from { waveId: 998n, txIndex: 0, eventIndex: 3 }
```

**Constraints:**

- `toWave - fromWave ≤ 5_000` (HOST_FN_ABI §15.4).
- Larger queries fail; page via `cursor`.

---

## `getEvents(filter?)`

Permissive event scan. Same engine surface as `getLogs` but tolerant of malformed filters (returns `[]` instead of failing) — useful for opportunistic indexers that don't want to crash on edge inputs.

**Spec:** Engine RPC catalog v0.1 §13 · RPC method `pyde_getEvents`

**Signature:**

```ts
provider.getEvents(filter?: {
  fromWave?: bigint;
  toWave?: bigint;
  contract?: string;
}): Promise<EventLog[]>
```

**Args:**

| Name              | Type     | Description                                        |
| ----------------- | -------- | -------------------------------------------------- |
| `filter.fromWave` | `bigint` | Inclusive lower bound. Default 0.                  |
| `filter.toWave`   | `bigint` | Inclusive upper bound. Default current head.       |
| `filter.contract` | `string` | Restrict to a single contract.                     |

**Returns:** `Promise<EventLog[]>` — flat array (no pagination cursor; use `getLogs` for strict / paginated semantics).

**Example:**

```ts
const events = await provider.getEvents({
  fromWave: 0n,
  toWave: 1000n,
  contract: "0xtoken...",
});
console.log(`scanned ${events.length} events`);
```

**Notes:**

- Use `getLogs` when you need strict validation, topic filtering, or pagination. `getEvents` is the easy-mode read.

---

## `getValidator(address)`

Fetch the validator record for a validator address.

**Spec:** Engine RPC catalog v0.1 §16 · RPC method `pyde_getValidator`

**Signature:**

```ts
provider.getValidator(address: string): Promise<ValidatorInfo | null>
```

**`ValidatorInfo` shape:** operator, FALCON pubkey, stake amount, status (active / unbonding / jailed), `unbond_wave`, `jail_until_wave`, `last_claimed_rps`, `uptime_bps`. `null` when no validator at that address.

**Example:**

```ts
const v = await provider.getValidator("0xvalidator...");
if (v) {
  console.log("operator:", v.operator);
  console.log("stake:", v.stake);
  console.log("status:", v.status);
}
```

---

## `getOperatorValidators(address)`

Reverse index — every validator address an operator controls.

**Spec:** Engine RPC catalog v0.1 §17 · RPC method `pyde_getOperatorValidators`

**Signature:**

```ts
provider.getOperatorValidators(address: string): Promise<string[]>
```

**Returns:** `Promise<string[]>` — validator addresses, at most 3 per operator (the staking model caps operator-controlled validators at 3).

**Example:**

```ts
const validators = await provider.getOperatorValidators("0xoperator...");
console.log("operator runs", validators.length, "validator(s)");
```

---

## `getNodeInfo()`

Identity + network info for the RPC node.

**Spec:** Engine RPC catalog v0.1 §18 · RPC method `pyde_getNodeInfo`

**Signature:**

```ts
provider.getNodeInfo(): Promise<NodeInfo>
```

**`NodeInfo` shape:**

```ts
interface NodeInfo {
  peerId: string;              // libp2p peer id
  falconPubkey: string | null; // signing key; null for full/archive nodes (can't sign)
  listenAddrs: string[];       // libp2p multiaddrs
  agentVersion: string;        // node software self-id, e.g. "pyde/0.1.0"
  protocolVersion: string;     // wire protocol family + version, e.g. "pyde/1"
}
```

`agentVersion` vs `protocolVersion` — different layers:

| Field             | Catalog format       | What it answers                                            | Analogue                                            |
| ----------------- | -------------------- | ---------------------------------------------------------- | --------------------------------------------------- |
| `agentVersion`    | `"pyde/<semver>"`    | "What build of the node software am I talking to?"         | EVM `web3_clientVersion` (e.g. `Geth/v1.13.0`)      |
| `protocolVersion` | `"pyde/<integer>"`   | "Which version of the Pyde wire protocol does this speak?" | EVM `eth_protocolVersion` (e.g. `65` for eth/65)    |

Compatibility checks: gate `protocolVersion === "pyde/1"` for v1 wire calls; surface `agentVersion` in logs / telemetry to pin down "which build serves this RPC" during outages.

Gate "this node can sign waves" UX on the non-null `falconPubkey` variant.

**Example:**

```ts
const info = await provider.getNodeInfo();
console.log("peer:", info.peerId);
console.log("signing-capable:", info.falconPubkey !== null);
```

---

## `getMetrics()`

Instantaneous `MainLoopMetrics` snapshot.

**Spec:** Engine RPC catalog v0.1 §19 · RPC method `pyde_getMetrics`

**Signature:**

```ts
provider.getMetrics(): Promise<MetricsSnapshot>
```

**Returns:** `Promise<MetricsSnapshot>` — a counter map. Field names map to internal `MainLoopMetrics` counters (waves committed, txs admitted, mempool depth, etc.) and may change between engine versions.

**Example:**

```ts
const m = await provider.getMetrics();
console.log("metric keys:", Object.keys(m).length);
```

**Notes:**

- For **time-series scraping** use the Prometheus `/metrics` HTTP endpoint instead. This RPC is for one-shot point-in-time reads.

---

## `batch(calls)`

Send multiple JSON-RPC calls in **one** HTTP round-trip.

**Signature:**

```ts
provider.batch(calls: { method: string; params: unknown[] }[]): Promise<unknown[]>
```

**Returns:** `Promise<unknown[]>` — raw results in request order. Caller post-processes.

**Example:**

```ts
const random = "0x" + "12".repeat(32);
const [chainId, balance, nonce] = await provider.batch([
  { method: "pyde_chainId", params: [] },
  { method: "pyde_getBalance", params: [random] },
  { method: "pyde_getTransactionCount", params: [random] },
]);

console.log("chainId:", parseInt(chainId as string, 16));
console.log("balance:", BigInt(balance as string));
console.log("nonce:", parseInt(nonce as string, 16));
```

**Expected output:**

```
chainId: 31337
balance: 0n
nonce: 0
```

**Notes:**

- One HTTP round-trip → much lower latency than N sequential calls.
- Results are returned in request order regardless of how the chain processes them.

---

## Retry semantics

| Layer                            | What retries                              | When                      | Backoff                                      |
| -------------------------------- | ----------------------------------------- | ------------------------- | -------------------------------------------- |
| `options.retries`                | transport errors (5xx, ECONNRESET, abort) | `fetch` throws            | exponential, capped                          |
| `callWithFallback` (internal)    | per-fallback-method-name list             | `method not found`        | none — try next                              |
| `WebSocketProvider` reconnect    | socket dropped                            | `close` event             | exponential, capped at `reconnectMaxDelayMs` |
| `Wallet.sendCall` simulate fallback | once                                   | `simulateTransaction` fails | fixed 5M default + no access list           |
| `waitForReceipt`                 | every ~500 ms until `timeoutMs`           | receipt not yet available | linear                                       |

**Never retries on:**

- `RpcError` — chain answered with an explicit error.
- `CallExceptionError` — chain answered with revert.

---

## Errors

| Class                  | When                                                                                | Recovery                  |
| ---------------------- | ----------------------------------------------------------------------------------- | ------------------------- |
| `InvalidArgumentError` | `http://` URL without `allowInsecureTransport: true`; malformed address.            | Fix the input.            |
| `ConnectionError`      | Transport failed.                                                                   | Retry with backoff.       |
| `TimeoutError`         | Request exceeded `options.timeout`.                                                 | Retry / extend timeout.   |
| `RpcError`             | Chain returned `{error: {code, message}}`. `.code` carries the JSON-RPC error code. | Inspect `.rpcError.code`. |
| `CallExceptionError`   | `pyde_call` reverted. `.revertReason` populated.                                    | Show the user the reason. |

See [Chapter 10 — Errors](./10-errors.md) for the full hierarchy + type guards.

---

## Gotchas

- **bigint everywhere on the wire.** `getNonce`, `getBalance`, `getWave`, `getWaveId`, log cursor fields are all `bigint`. JSON-RPC ships hex strings; the SDK parses them losslessly. Don't `Number(nonce)` unless you know it's small.
- **`getWave()` no-arg path now resolves the head via `pyde_waveId`** (use `getWaveId()` directly if you only need the number). Older docs referenced `pyde_getWaveNumber` / `pyde_blockNumber` — those never existed in the v1 catalog.
- **`getLogs` wave span is capped at 5,000.** Larger queries return an RPC error; page via `cursor`.
- **`http://` URLs throw.** Devnet local dev: pass `allowInsecureTransport: true`. Anywhere else: use `https://`.
- **Chain-id is cached.** First `getChainId()` hits the network; subsequent reads from the cache. Rebuild the Provider for a fresh fetch.
- **`getThresholdPublicKey` rotates per epoch.** Don't cache it client-side.
- **The chain dispatches by function name**, not by 4-byte selector. `provider.call(to, data)` expects `data` to be a borsh-encoded `CallPayload`, not raw calldata + selector. Use `Contract.encodeCall` to build it.
