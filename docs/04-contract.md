# 04 — Contract

ABI-aware contract wrapper. Loads an `otigen` build artifact, encodes args via the borsh codec, dispatches view calls + writes, decodes returns + events.

[← TOC](./README.md)

## Why this exists

The chain's `#[pyde::entry]` macro borsh-decodes calldata into typed args and borsh-encodes return values. The TypeScript codec in this module is a 1:1 mirror of the borsh-rs wire format — same bytes, same field order. The chain dispatches by function **name** (a String inside `CallPayload`), not by selector hash.

Live-verified against `otigen/examples/borsh-coverage` — full struct (`Order {id, maker, items, paid}`), enum (`Status`), `Vec<u64>` round-trip via `Contract.read` in the integration suite.

## Constructors

```ts
Contract.fromArtifact<T extends AbiShape = DefaultAbi>(
  artifactPath: string,
  address: string,
  provider: Provider,
): Promise<Contract<T>>
```
Read an `*.abi.json` from disk (Node only). Pass a `pyde-tsgen`-emitted `<Name>Abi` as the type parameter for full narrowing — see [Type-safe contracts](#type-safe-contracts).

```ts
Contract.fromJson<T>(json: string, address: string, provider: Provider): Contract<T>
```
Same shape from an in-memory JSON string. Use in browsers (the build artifact is shipped as part of your bundle).

```ts
Contract.create<T>(address: string, provider: Provider): Contract<T>
```
Empty Contract — manually register functions with `addFunction()`. Rarely useful; prefer the artifact path.

## Wallet binding

```ts
contract.connect(wallet: Wallet): Contract<TAbi>
```
Returns a new instance with `wallet` attached for write operations. The original (read-only) instance stays usable.

```ts
const counter = await Contract.fromArtifact(abi, addr, provider);
const writable = counter.connect(wallet);

await counter.read("get_count");        // anyone can read
await writable.write("increment", {});  // signer required
```

## Read surface

```ts
contract.read<M extends ViewName<TAbi>>(method: M, args?: FnArgs<TAbi, M>): Promise<FnReturns<TAbi, M>>
```
View call. Encodes args → wraps in `CallPayload` → sends to `provider.call` → borsh-decodes the return. **No signer required.**

```ts
const count: bigint = await counter.read("get_count");
const balance: bigint = await token.read("balance_of", { owner: "0xabc..." });
```

```ts
contract.simulate<M>(method, args?): Promise<FnReturns<TAbi, M>>
```
Same as `read` but accepts non-view methods too. Runs the call against current state without committing.

```ts
contract.estimateGas<M>(method, args?): Promise<number>
```
Pre-flight gas estimate via `provider.estimateGas`.

## Write surface

```ts
contract.write<M extends WriteName<TAbi>>(
  method: M,
  args?: FnArgs<TAbi, M>,
  options?: { gasLimit?: number; value?: bigint | number | string },
): Promise<ContractReceipt>
```
Signs + submits + waits for the receipt. Returns a `ContractReceipt` with `decodeReturnData()`:

```ts
const receipt = await counter.connect(wallet).write("deposit", { amount: 500n }, { value: 500n });
if (!receipt.success) throw new Error("reverted");
const decoded = receipt.decodeReturnData(); // null for ()-return functions
```

If the ABI marks `payable: false` and you pass non-zero `value`, the SDK throws before submission.

### `populateTransaction` — build but don't send

```ts
contract.populateTransaction<M>(method, args?, options?): Promise<TxFields>
```
Build the unsigned `TxFields` envelope. Useful for multisig flows, offline signing, or transaction review:

```ts
const tx = await counter.connect(wallet).populateTransaction("deposit", { amount: 500n });
console.log(tx.to, tx.data, tx.nonce); // review before signing
const signed = wallet.signTransaction(tx);
```

## Events

```ts
contract.queryFilter<E extends EventName<TAbi>>(
  eventName: E,
  fromWave?: bigint,
  toWave?: bigint,
): Promise<EventLog<EvtArgs<TAbi, E>>[]>
```
Historical log query. Bounds in waves (bigint), 5,000-wave cap per HOST_FN_ABI §15.4. Returns `EventLog<TArgs>` — `args` is the decoded named-field object.

```ts
const transfers = await token.queryFilter("Transfer", 1000n, 2000n);
for (const ev of transfers) {
  console.log(ev.name, ev.args.from, ev.args.to, ev.args.amount);
}
```

```ts
contract.parseLog(log: Log): EventLog | null
```
Decode a single raw log against the contract's ABI. Returns `null` if no event signature matches `log.topics[0]`.

```ts
contract.getEventTopic(eventName: string): string
```
The 32-byte topic-0 the chain emits for an event — useful when building custom log filters (e.g., to subscribe via WebSocketProvider).

## Type-safe contracts

`Contract<TAbi>` narrows `read` / `write` / `simulate` / `estimateGas` / `populateTransaction` / `queryFilter` / `parseLog` to method-name + arg-shape + return-type from the bound ABI.

Generate the ABI shape with `pyde-tsgen`:

```bash
npx pyde-tsgen ./artifacts/counter.bundle/abi.json ./types/counter.d.ts --name Counter
```

Then bind it:

```ts
import { Contract } from "pyde-ts-sdk";
import type { CounterAbi } from "./types/counter";

const counter = await Contract.fromArtifact<CounterAbi>(abiPath, addr, provider);

await counter.read("get_count");           // ✅ → Promise<bigint>
await counter.read("getCount");            // ❌ TS2345 — not in TAbi["functions"]
await counter.write("deposit", { amount: 5n });
await counter.write("deposit", { amount: "5" }); // ❌ — amount must be bigint
await counter.queryFilter("Transfer");     // ✅ — known event
await counter.queryFilter("Unknown");      // ❌
```

The plain `Contract` (no generic) accepts any method name and types as `unknown`. See [Chapter 05 — Codegen](./05-codegen.md) for the ABI shape format.

## Encoding helpers

```ts
contract.encodeCall(method: string, args?: Record<string, any>): string
```
The full borsh-encoded `CallPayload {function, calldata}` bytes you'd put in `tx.data`. Used internally by `write`; exposed for callers building txs manually.

```ts
contract.encodeCallArgs(method: string, args?: Record<string, any>): string
```
Just the borsh-encoded args (no `CallPayload` wrapper). Used for byte-level comparison against a borsh-rs encoder in tests.

## The borsh codec — supported types

| ABI type | Wire format | JS type |
|---|---|---|
| `u8`, `i8` | 1 byte | `bigint` |
| `u16`, `i16` | 2 LE bytes | `bigint` |
| `u32`, `i32` | 4 LE bytes | `bigint` |
| `u64`, `i64` | 8 LE bytes | `bigint` |
| `u128`, `i128` | 16 LE bytes | `bigint` |
| `u256`, `i256` | 32 LE bytes (Pyde extension) | `bigint` |
| `bool` | 1 byte (`00` / `01`) | `boolean` |
| `Address`, `Hash`, `Hash32` | 32 raw bytes | `0x`-prefixed 64-hex string |
| `FixedBytes:N` | N raw bytes | `0x`-prefixed hex string |
| `String` | 4-byte LE u32 length + UTF-8 bytes | `string` |
| `Bytes`, `Vec<u8>` | 4-byte LE u32 length + raw bytes | `Uint8Array` (or hex on encode) |
| `Vec<T>` | 4-byte LE u32 count + items | `T[]` |
| `Option<T>` | 1-byte tag (0=None, 1=Some) + value if Some | `T \| null` |
| `(T1, T2, ...)` tuple | items concatenated, no header | `[T1, T2, ...]` |
| `[T; N]` fixed array | N items concatenated, no header | `T[]` (length N) |
| struct (declared in ABI) | fields concatenated in declaration order | `{ field: T, ... }` |
| enum (unit variants only) | 1-byte variant index | `"VariantName" \| number` |

Multi-arg functions: the chain decodes `<(T1, T2, ...) as BorshDeserialize>::try_from_slice` — the SDK concatenates each borsh-encoded arg in order, with no tuple header.

**Selectors:** the chain dispatches by function **name**, not selector. The SDK still records `selector` bytes from the ABI for forward compatibility but doesn't use them in `pyde_call` / `tx.data` encoding.

## Standalone codecs

```ts
import {
  decodeU64, decodeI64, decodeU128, decodeI128, decodeU256, decodeI256,
  decodeBool, decodeAddress, decodeString, decodeBytes,
  decodeVecU64, decodeVecBool, decodeVecAddress,
} from "pyde-ts-sdk";
```
Standalone helpers when you have a hex return value and the type. Most callers go through `Contract.read` which decodes for you.

## `Interface` — no contract instance

```ts
import { Interface } from "pyde-ts-sdk";

const iface = await Interface.fromArtifact("./Counter.abi.json");
const calldata = iface.encodeFunctionData("deposit", { amount: 500n });
const decoded = iface.decodeFunctionResult("get_count", returnHex);
```
Useful for encoding inside scripts, indexers, or tx-builder backends — no `Provider` or contract address required.

## `DeployData` — Deploy-tx payload

```ts
import { DeployData } from "pyde-ts-sdk";

const data = await DeployData.fromArtifact("./out/Counter.bundle", {
  // init args (matches the contract's `pyde::init` signature)
});
const tx = await wallet.deploy(data);
```
The CLI flow via `otigen deploy` is usually cleaner; this is the in-process equivalent.

## Errors

| Class | When |
|---|---|
| `Error("Unknown function 'X'")` | `read` / `write` called with a method not in the ABI. |
| `Error("missing required param 'X'")` | An arg was undefined. Hex-backed wallets only. |
| `Error("expected ... got ...")` | Type mismatch in `encodeValue` (e.g. string passed where `bigint` expected). |
| `RpcError` from `Provider.call` | Chain returned `decode CallPayload from data` → SDK and chain disagree on wire format; file a bug. |
| `CallExceptionError` | `pyde_call` reverted; `revertReason` populated. |

See [Chapter 14 — Internals](./14-internals.md) for the full wire-format reference and design rationale.

## Gotchas

- **Function args are passed by name.** `contract.read("balance_of", { owner: "0x..." })`. The ABI declares param names like `arg0`, `arg1` if the source didn't; codegen surfaces the right names.
- **`bigint` for every integer type.** Even `u8` decodes to `bigint` — keeps the API uniform.
- **`Address` is a hex string, not a `Uint8Array`.** Encoder accepts `"0x" + 64hex` or `64hex` (no prefix).
- **`Bytes` accepts hex strings too.** `{ data: "0xdeadbeef" }` works as well as `{ data: new Uint8Array([0xde, 0xad, 0xbe, 0xef]) }`.
- **Enum variants are 1 byte each — only the first 256 variants encode.**
- **Data-carrying enum variants are not yet supported** (only unit variants).
- **The chain ignores the SDK's `selectorBytes`.** Dispatch is by name. If your ABI ships custom selectors, they're informational — keep them but don't depend on them for routing.
