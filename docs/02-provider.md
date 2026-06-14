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
  - [`getContractState(address, slotHash)`](#getcontractstateaddress-slothash)
  - [`resolveName(name)`](#resolvenamename)
  - [`getWave(waveId?)`](#getwavewaveid)
  - [`getHardFinalityCert(waveId)`](#gethardfinalitycertwaveid)
  - [`getSnapshotManifest(waveId)`](#getsnapshotmanifestwaveid)
  - [`getBaseFee()`](#getbasefee)
  - [`getFeeData()`](#getfeedata)
- View calls + estimation
  - [`call(to, data, overrides?)`](#callto-data-overrides)
  - [`estimateGas(to, data, overrides?)`](#estimategasto-data-overrides)
  - [`estimateAccess(params)`](#estimateaccessparams)
- Write surface
  - [`sendRawTransaction(signedTxHex)`](#sendrawtransactionsignedtxhex)
  - [`sendRawEncryptedTransaction(encTxHex)`](#sendrawencryptedtransactionenctxhex)
  - [`getThresholdPublicKey()`](#getthresholdpublickey)
- Receipts + waiting
  - [`getTransaction(txHash)`](#gettransactiontxhash)
  - [`getTransactionReceipt(txHash)`](#gettransactionreceipttxhash)
  - [`waitForReceipt(txHash, timeoutMs?)`](#waitforreceipttxhash-timeoutms)
  - [`sendAndWait(signedTxHex, timeoutMs?)`](#sendandwaitsignedtxhex-timeoutms)
- Logs
  - [`getLogs(filter)`](#getlogsfilter)
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

| Name | Type | Required | Description |
|---|---|---|---|
| `rpcUrl` | `string` | yes | HTTPS endpoint. `http://` throws unless `allowInsecureTransport: true`. |
| `options` | `ProviderOptions` | no | Timeouts, retries, custom headers. |

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

| Field | Type | Default | What it does |
|---|---|---|---|
| `timeout` | `number` (ms) | `30_000` | Per-request timeout. The fetch is aborted when this elapses; the call rejects with `TimeoutError`. |
| `retries` | `number` | `0` | Number of retries on **transport** errors (`fetch` threw, 5xx, `ECONNRESET`). Exponential backoff between attempts. Does **not** retry on `RpcError` — those mean the chain answered. |
| `headers` | `Record<string, string>` | `{}` | Custom HTTP headers merged into every request. Useful for API keys, trace IDs, etc. |
| `allowInsecureTransport` | `boolean` | `false` | Required to use `http://`. Production should never set this. |

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

| Name | Type | Description |
|---|---|---|
| `address` | `string` | `0x`-prefixed 64 hex chars (32 bytes). |

**Returns:** `Promise<bigint>` — balance in **quanta** (1 PYDE = 10⁹ quanta). Use `formatQuanta` to render as a PYDE string.

**Example:**

```ts
const balance = await provider.getBalance("0xf07856fdf4796baa6d477ddfe926774d367b25c20e8c7d9d337b63034c9e0cfa");
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

**Spec:** Chapter 17.4 · RPC methods `pyde_getNonce` → falls back to `pyde_getTransactionCount`

**Signature:**

```ts
provider.getNonce(address: string): Promise<bigint>
```

**Args:**

| Name | Type | Description |
|---|---|---|
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

| Name | Type | Description |
|---|---|---|
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

| Name | Type | Description |
|---|---|---|
| `address` | `string` | `0x`-prefixed 32-byte address. |

**Returns:** `Promise<Account | null>`:
- `null` — no account record on chain (never been touched).
- `Account` — populated record.

**`Account` shape:**

```ts
interface Account {
  address: string;        // 0x + 64 hex
  nonce: bigint;          // u64
  balance: bigint;        // u128 quanta
  codeHash: string;       // 0x + 64 hex; "0x" + 64*"0" for EOAs
  storageRoot: string;    // 0x + 64 hex
  accountType: AccountType; // EOA | Contract | System
  authKeys: string;       // hex
  gasTank: bigint;        // u128 quanta — paymaster pool
  keyNonce: number;       // for key rotation events
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

| Name | Type | Description |
|---|---|---|
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

## `getContractState(address, slotHash)`

Get a single contract storage slot's value.

**Spec:** Chapter 17.4 · RPC method `pyde_getContractState`

**Signature:**

```ts
provider.getContractState(address: string, slotHash: string): Promise<string>
```

**Args:**

| Name | Type | Description |
|---|---|---|
| `address` | `string` | Contract address. |
| `slotHash` | `string` | `0x`-prefixed 32-byte Poseidon2 slot key. |

**Returns:** `Promise<string>` — `0x`-prefixed hex of the slot's bytes.

**Example:**

```ts
const slot = await provider.getContractState(
  "0xcontract...",
  "0x" + "00".repeat(32), // slot 0 (first declared state field)
);
console.log("slot 0:", slot);
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

| Name | Type | Description |
|---|---|---|
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

| Name | Type | Description |
|---|---|---|
| `waveId` | `bigint` (optional) | Specific wave id. Omit for "latest committed" — currently engine-blocked. |

**Returns:** `Promise<WaveHeader | null>` — header or `null` if the wave isn't on chain (e.g., asked for a future wave).

**`WaveHeader` shape:**

```ts
interface WaveHeader {
  waveId: bigint;
  timestamp: string;
  anchor: string;          // 0x + 64 hex; canonical anchor hash
  stateRoot?: string;      // 0x + 64 hex
  eventsRoot?: string;     // 0x + 64 hex
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

**Spec:** Chapter 6 · RPC method `pyde_getHardFinalityCert`

**Signature:**

```ts
provider.getHardFinalityCert(waveId: number): Promise<HardFinalityCert | null>
```

**Args:**

| Name | Type | Description |
|---|---|---|
| `waveId` | `number` | Wave id. |

**Returns:** `Promise<HardFinalityCert | null>` — certificate or `null` if the wave hasn't reached hard finality.

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

## `getSnapshotManifest(waveId)`

Get the snapshot manifest for a wave (light-client state-sync protocol).

**Spec:** `STATE_SYNC.md` · RPC method `pyde_getSnapshotManifest`

**Signature:**

```ts
provider.getSnapshotManifest(waveId: number): Promise<SnapshotManifest | null>
```

**Args:**

| Name | Type | Description |
|---|---|---|
| `waveId` | `number` | Snapshot wave id. |

**Returns:** `Promise<SnapshotManifest | null>`:

```ts
interface SnapshotManifest {
  waveId: bigint;
  chunks: ChunkRef[]; // chunk references for downloading partial state
  stateRoot: string;
}
```

**Example:**

```ts
const manifest = await provider.getSnapshotManifest(10_000);
if (manifest) {
  console.log("chunks:", manifest.chunks.length);
  console.log("state root:", manifest.stateRoot);
}
```

---

## `getBaseFee()`

Get the current base fee per gas.

**Spec:** Chapter 10 · RPC methods `pyde_getBaseFee` → falls back to `pyde_gasPrice`

**Signature:**

```ts
provider.getBaseFee(): Promise<bigint>
```

**Returns:** `Promise<bigint>` — base fee in quanta per gas.

**Example:**

```ts
const baseFee = await provider.getBaseFee();
console.log("base fee:", baseFee, "quanta/gas");
```

**Expected output:**

```
base fee: 1n quanta/gas
```

**Notes:**
- v1 has **no priority tip**. Gas price equals the base fee.

---

## `getFeeData()`

Convenience wrapper exposing the fee market.

**Signature:**

```ts
provider.getFeeData(): Promise<FeeData>
```

**Returns:** `Promise<FeeData>`:

```ts
interface FeeData {
  baseFee: bigint;
  gasPrice: bigint;            // === baseFee in v1
  maxFeePerGas: bigint | null; // === baseFee in v1
  maxPriorityFeePerGas: bigint; // 0n in v1 (no tips)
}
```

**Example:**

```ts
const fee = await provider.getFeeData();
console.log(fee);
```

**Expected output:**

```
{ baseFee: 1n, gasPrice: 1n, maxFeePerGas: 1n, maxPriorityFeePerGas: 0n }
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

| Name | Type | Description |
|---|---|---|
| `to` | `string` | Contract address. |
| `data` | `string` | Borsh-encoded `CallPayload {function, calldata}` bytes (hex). Usually built via `Contract.encodeCall`. |
| `overrides` | `CallOverrides` (optional) | `from`, `value`, `gasLimit` overrides for the simulation context. |

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

## `estimateGas(to, data, overrides?)`

Estimate gas required for a call. Used by `Wallet.transfer` / `sendCall` for auto-estimation.

**Spec:** Chapter 17.4 · RPC method `pyde_estimateGas`

**Signature:**

```ts
provider.estimateGas(to: string, data: string, overrides?: CallOverrides): Promise<number>
```

**Returns:** `Promise<number>` — gas estimate.

**Example:**

```ts
const gas = await provider.estimateGas(
  "0xcontract...",
  counter.encodeCall("increment"),
);
console.log("estimated:", gas);
```

**Expected output:**

```
estimated: 45000
```

**Notes:**
- Not yet exposed on devnet — `Wallet.transfer` falls back to 100k / 5M defaults when this throws `method not found`.

---

## `estimateAccess(params)`

Simulate a call and return the inferred access list (slots read / written).

**Spec:** Chapter 17.4 · RPC method `pyde_estimateAccess`

**Signature:**

```ts
provider.estimateAccess(params: {
  to: string;
  data: string;
  from?: string;
  value?: bigint | number | string;
  gasLimit?: number;
}): Promise<AccessEntry[]>
```

**Returns:** `Promise<AccessEntry[]>`:

```ts
interface AccessEntry {
  address: string;       // contract address
  storageKeys: string[]; // 32-byte slot keys (hex)
  accessType: "Read" | "Write";
}
```

**Example:**

```ts
const accessList = await provider.estimateAccess({
  to: "0xcontract...",
  data: counter.encodeCall("increment"),
});
console.log("access entries:", accessList.length);
for (const entry of accessList) {
  console.log(entry.accessType, entry.storageKeys.length, "slots");
}
```

**Expected output:**

```
access entries: 1
Write 1 slots
```

**Notes:**
- Used by wallets to attach access lists to outgoing txs so the chain's parallel scheduler can place them without blocking.
- **Off by default for encrypted submissions** — leaks the touched slot keys.

---

## `sendRawTransaction(signedTxHex)`

Submit a signed transaction.

**Spec:** Chapter 17.4 · RPC method `pyde_sendRawTransaction`

**Signature:**

```ts
provider.sendRawTransaction(signedTxHex: string): Promise<TransactionResponse>
```

**Args:**

| Name | Type | Description |
|---|---|---|
| `signedTxHex` | `string` | Output of `wallet.signTransaction(tx)`. |

**Returns:** `Promise<TransactionResponse>`:

```ts
interface TransactionResponse {
  hash: string;                                  // tx hash
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

**Signature:**

```ts
provider.getThresholdPublicKey(): Promise<string>
```

**Returns:** `Promise<string>` — `0x`-prefixed hex of the Kyber-768 public key.

**Notes:**
- The key **rotates per epoch**. SDK refetches on every encrypted submission rather than caching.
- Used internally by `wallet.sendEncrypted`; rarely called directly.

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
  gasUsed: string;       // 0x-prefixed hex
  effectiveGas: string;  // 0x0 when chain doesn't ship it
  feePaid: string;
  feeBurned: string;
  feeValidator: string;
  returnData?: string;
  logs: Log[];
}
```

**Example:**

```ts
const receipt = await provider.getTransactionReceipt(hash);
if (receipt === null) {
  console.log("not yet committed");
} else if (receipt.success) {
  console.log("ok; gas used:", parseInt(receipt.gasUsed, 16));
} else {
  console.log("reverted");
}
```

**Expected output:**

```
ok; gas used: 100000
```

---

## `waitForReceipt(txHash, timeoutMs?)`

Poll until the receipt is available or `timeoutMs` elapses.

**Signature:**

```ts
provider.waitForReceipt(txHash: string, timeoutMs?: number): Promise<Receipt>
```

**Args:**

| Name | Type | Default | Description |
|---|---|---|---|
| `txHash` | `string` | required | Tx hash from `sendRawTransaction`. |
| `timeoutMs` | `number` | `10_000` | Stop polling after this many ms. |

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
  fromWave: Wave;                    // bigint
  toWave: Wave;                      // bigint
  topics?: (string[] | null)[];      // up to 4 positional slots
  contract?: string;
  cursor?: EventCursor;
  limit?: number;                    // default 100
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

| Layer | What retries | When | Backoff |
|---|---|---|---|
| `options.retries` | transport errors (5xx, ECONNRESET, abort) | `fetch` throws | exponential, capped |
| `callWithFallback` (internal) | per-fallback-method-name list | `method not found` | none — try next |
| `WebSocketProvider` reconnect | socket dropped | `close` event | exponential, capped at `reconnectMaxDelayMs` |
| `Wallet.transfer` gas estimation | once | `estimateGas` fails | hardcoded fallback (100k / 5M) |
| `waitForReceipt` | every ~500 ms until `timeoutMs` | receipt not yet available | linear |

**Never retries on:**
- `RpcError` — chain answered with an explicit error.
- `CallExceptionError` — chain answered with revert.

---

## Errors

| Class | When | Recovery |
|---|---|---|
| `InvalidArgumentError` | `http://` URL without `allowInsecureTransport: true`; malformed address. | Fix the input. |
| `ConnectionError` | Transport failed. | Retry with backoff. |
| `TimeoutError` | Request exceeded `options.timeout`. | Retry / extend timeout. |
| `RpcError` | Chain returned `{error: {code, message}}`. `.code` carries the JSON-RPC error code. | Inspect `.rpcError.code`. |
| `CallExceptionError` | `pyde_call` reverted. `.revertReason` populated. | Show the user the reason. |

See [Chapter 10 — Errors](./10-errors.md) for the full hierarchy + type guards.

---

## Gotchas

- **bigint everywhere on the wire.** `getNonce`, `getBalance`, `getWave`, `latestWaveId`, log cursor fields are all `bigint`. JSON-RPC ships hex strings; the SDK parses them losslessly. Don't `Number(nonce)` unless you know it's small.
- **`getWave()` no-arg path doesn't work today.** Engine doesn't expose `pyde_getWaveNumber` or `pyde_blockNumber` — pass a concrete `waveId`.
- **`getLogs` wave span is capped at 5,000.** Larger queries return an RPC error; page via `cursor`.
- **`http://` URLs throw.** Devnet local dev: pass `allowInsecureTransport: true`. Anywhere else: use `https://`.
- **Chain-id is cached.** First `getChainId()` hits the network; subsequent reads from the cache. Rebuild the Provider for a fresh fetch.
- **`getThresholdPublicKey` rotates per epoch.** Don't cache it client-side.
- **The chain dispatches by function name**, not by 4-byte selector. `provider.call(to, data)` expects `data` to be a borsh-encoded `CallPayload`, not raw calldata + selector. Use `Contract.encodeCall` to build it.
