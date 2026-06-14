# 02 — Provider

HTTP JSON-RPC client for a Pyde node. One instance per RPC endpoint; thread-safe for the use cases it supports (browser fetch + Node fetch).

[← TOC](./README.md)

## Overview

```ts
import { Provider } from "pyde-ts-sdk";

const provider = new Provider("https://rpc.pyde.network", {
  timeout: 30_000,
  retries: 2,
  headers: { "x-api-key": process.env.PYDE_KEY! },
});
```

The constructor enforces HTTPS by default — passing a `http://` URL throws unless `allowInsecureTransport: true` is set.

## Constructor

```ts
new Provider(rpcUrl: string, options?: ProviderOptions)
```

**`ProviderOptions`:**

| Field | Default | Notes |
|---|---|---|
| `timeout` | `30_000` | Per-request, milliseconds. |
| `retries` | `0` | On transient transport errors (5xx, ECONNRESET). Exponential backoff. |
| `headers` | `{}` | Merged into every JSON-RPC request. |
| `allowInsecureTransport` | `false` | **Required** to use `http://` / `ws://`. Production should never set this. |

## Read surface

### Account queries

```ts
provider.getBalance(address: string): Promise<bigint>
```
Returns spendable balance in quanta (`u128`). Pyde uses 9 decimals — use `formatPyde` to render.

```ts
provider.getNonce(address: string): Promise<bigint>
```
Next available slot in the 16-slot sliding nonce window (Chapter 11). Returns `bigint` so 64-bit nonces don't silently truncate above `2^53`.

```ts
provider.getChainId(): Promise<number>
```
Genesis-immutable chain id, cached per Provider instance.

```ts
provider.getNonceAndChainId(address: string): Promise<[bigint, number]>
```
One round-trip combo for building a tx.

```ts
provider.getAccount(address: string): Promise<Account | null>
```
Full account record. Returns `null` when the chain has no record (distinct from a zero-balance EOA — see [internals](./14-internals.md#account-null-vs-zeroed) for the wire-field probe).

### Contract code + state

```ts
provider.getContractCode(address: string): Promise<string>
```
Returns the contract's WASM bytecode as hex. Empty string (`"0x"`) for EOAs.

```ts
provider.getContractState(address: string, slotHash: string): Promise<string>
```
Single contract storage slot, hex. `slotHash` is the Poseidon2-derived key.

### Name resolution

```ts
provider.resolveName(name: string): Promise<string | null>
```
Resolves a `*.pyde` name to its 32-byte address via the Pyde Name Service. Returns `null` if the name isn't registered.

### Wave header + finality

```ts
provider.getWave(waveId?: Wave): Promise<WaveHeader | null>
```
Returns the wave header for a specific `waveId` (`bigint`), or `null` if absent. Omit the arg for "latest committed" — note this currently needs `pyde_getWaveNumber` / `pyde_blockNumber`, neither of which the devnet exposes; pass an explicit wave id in the meantime.

```ts
provider.getHardFinalityCert(waveId: number): Promise<HardFinalityCert | null>
```
Threshold-signed finality certificate for a wave (Chapter 6 / 17.4).

```ts
provider.getSnapshotManifest(waveId: number): Promise<SnapshotManifest | null>
```
Light-client snapshot manifest (state-sync protocol).

### Fee market

```ts
provider.getBaseFee(): Promise<bigint>
```
Current base fee in quanta per gas. v1 has no priority tip — gas price = base fee.

```ts
provider.getFeeData(): Promise<FeeData>
```
Wrapper exposing `{ baseFee, gasPrice, maxFeePerGas, maxPriorityFeePerGas }` — `baseFee === gasPrice` in v1, `maxPriorityFeePerGas === 0n`.

### View calls + estimation

```ts
provider.call(to: string, data: string, overrides?: CallOverrides): Promise<string>
```
Off-chain view-function dispatch via `pyde_call`. Free; no tx, no consensus. `data` is the borsh-encoded `CallPayload` (see [Chapter 04](./04-contract.md) — most callers use `Contract.read` rather than this directly).

```ts
provider.estimateGas(to: string, data: string, overrides?: CallOverrides): Promise<number>
```
Pre-flight gas estimate. Fall-back: when the engine doesn't expose `pyde_estimateGas`, `Wallet.transfer` / `sendCall` use a fixed 100k / 5M default — see [Wallet → gas auto-estimate](./03-wallet.md#gas-auto-estimate).

```ts
provider.estimateAccess(params: { to, data, from?, value?, gasLimit? }): Promise<AccessEntry[]>
```
Returns the inferred access list (slots the call would read / write). Used by wallets to attach access lists to outgoing txs so the chain's parallel scheduler can place them without blocking. **Off by default for encrypted submissions — leaks the touched slot keys.**

### Logs + cursor paging

```ts
provider.getLogs(filter: LogFilter): Promise<GetLogsResponse>
```

```ts
type LogFilter = {
  fromWave: Wave;          // inclusive bigint lower bound
  toWave: Wave;            // inclusive bigint upper bound (max 5,000 wave span)
  topics?: (string[] | null)[]; // up to 4 positional slots, null = wildcard
  contract?: string;       // restrict to one contract
  cursor?: EventCursor;    // resume from a previous page
  limit?: number;          // default 100
};
```

Span constraint: `toWave - fromWave ≤ 5_000` per HOST_FN_ABI §15.4. Use `cursor` for at-least-once paging.

## Write surface

```ts
provider.sendRawTransaction(signedTxHex: string): Promise<TransactionResponse>
```
Submit a signed tx. `signedTxHex` is the output of `wallet.signTransaction(tx)`. Returns immediately with `{ txHash }` — does **not** wait for inclusion.

```ts
provider.sendRawEncryptedTransaction(encTxHex: string): Promise<TransactionResponse>
```
Submit a threshold-encrypted tx (`Wallet.sendEncrypted` builds it). See [Chapter 09](./09-encrypted-mempool.md).

```ts
provider.getThresholdPublicKey(): Promise<string>
```
Current committee's threshold encryption public key. Used by encrypted-tx builders.

## Receipts + waiting

```ts
provider.getTransaction(txHash: string): Promise<TransactionInfo | null>
```

```ts
provider.getTransactionReceipt(txHash: string): Promise<Receipt | null>
```

```ts
provider.waitForReceipt(txHash: string, timeoutMs = 10_000): Promise<Receipt>
```
Poll until inclusion or timeout. Throws `TimeoutError` on expiry.

```ts
provider.sendAndWait(signedTxHex: string, timeoutMs = 10_000): Promise<Receipt>
```
One-shot — submits + waits + throws on revert. Convenience for scripts.

## Batch RPC

```ts
provider.batch(calls: { method: string; params: unknown[] }[]): Promise<unknown[]>
```

One HTTP round-trip for multiple JSON-RPC calls. Results returned in request order; raw `unknown` (caller post-processes).

```ts
const random = "0x" + "12".repeat(32);
const [chainId, balance, nonce] = await provider.batch([
  { method: "pyde_chainId", params: [] },
  { method: "pyde_getBalance", params: [random] },
  { method: "pyde_getTransactionCount", params: [random] },
]);
```

## Retry + fallback

- `options.retries` retries on transport errors (5xx, ECONNRESET, abort). It does **not** retry on `RpcError` (the chain answered with a specific error code).
- `getNonce` / `getBaseFee` / `latestWaveId` use an internal `callWithFallback` that tries multiple method names in order — the first one that doesn't return `method not found` wins. This rides out engine RPC-name churn pre-1.0.

## Errors

| Class | When |
|---|---|
| `InvalidArgumentError` | `http://` URL without `allowInsecureTransport: true`. |
| `ConnectionError` | Transport failed (fetch threw, network unreachable). |
| `TimeoutError` | Request exceeded `options.timeout`. |
| `RpcError` | Chain returned `{error: {code, message}}` — `.code` carries the JSON-RPC error code. |
| `CallExceptionError` | `pyde_call` reverted; `.revertReason` carries the chain's message. |

See [Chapter 10 — Errors](./10-errors.md) for the full hierarchy and `isError` guard.

## Gotchas

- **Bigint everywhere on the wire.** `getNonce`, `getBalance`, `getWave`, `latestWaveId`, log cursor fields are all `bigint`. JSON-RPC ships hex strings; the SDK parses them losslessly. Don't `Number(nonce)` unless you know it's small.
- **`getWave()` no-arg path doesn't work today.** Engine doesn't expose `pyde_getWaveNumber` or `pyde_blockNumber` — pass a concrete `waveId`. Tracked in the engine-side gap list in [README → Status](./README.md#status).
- **`getLogs` wave span is capped at 5,000.** Larger queries return an RPC error; page via `cursor`.
- **`http://` URLs throw.** Devnet local dev: pass `allowInsecureTransport: true`. Anywhere else: use `https://`.
- **Chain-id is cached.** First `getChainId()` call hits the network; subsequent reads from the cached value. Rebuild the Provider if you ever need a fresh fetch.
