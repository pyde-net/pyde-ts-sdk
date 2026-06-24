# 04 — Contract

ABI-aware contract wrapper. Loads an `otigen` build artifact, encodes args via the borsh codec, dispatches view calls + writes, decodes returns + events.

[← TOC](./README.md)

---

## Table of contents

- [Why this exists](#why-this-exists)
- [Quick reference — minimal example](#quick-reference--minimal-example)
- Constructors
  - [`Contract.fromArtifact<TAbi>(...)`](#contractfromartifacttabipath-address-provider)
  - [`Contract.fromJson<TAbi>(...)`](#contractfromjsontabijson-address-provider)
  - [`Contract.create<TAbi>(...)`](#contractcreatetabiaddress-provider)
- Wallet binding
  - [`contract.connect(wallet)`](#contractconnectwallet)
- Read surface
  - [`contract.read(method, args?)`](#contractreadmethod-args)
  - [`contract.simulate(method, args?)`](#contractsimulatemethod-args)
  - [`contract.estimateGas(method, args?)`](#contractestimategasmethod-args)
- Write surface
  - [`contract.write(method, args?, options?)`](#contractwritemethod-args-options)
  - [`contract.populateTransaction(method, args?, options?)`](#contractpopulatetransactionmethod-args-options)
- Events
  - [`contract.queryFilter(eventName, fromWave?, toWave?)`](#contractqueryfiltereventname-fromwave-towave)
  - [`contract.parseLog(log)`](#contractparseloglog)
  - [`contract.getEventTopic(eventName)`](#contractgeteventtopiceventname)
- Type-safe contracts (`Contract<TAbi>`)
  - [Generating bindings with `pyde-tsgen`](#generating-bindings-with-pyde-tsgen)
  - [Binding `TAbi` to a Contract](#binding-tabi-to-a-contract)
- Encoding helpers
  - [`contract.encodeCall(method, args?)`](#contractencodecallmethod-args)
  - [`contract.encodeCallArgs(method, args?)`](#contractencodecallargsmethod-args)
- [The borsh codec — supported types (full table)](#the-borsh-codec--supported-types-full-table)
- Standalone decoders
  - [`decodeU64` / `decodeI64` / etc.](#standalone-decoders)
- Helper classes
  - [`Interface` — no contract instance](#interface--no-contract-instance)
  - [`DeployData` — deploy-tx payload](#deploydata--deploy-tx-payload)
- [Errors](#errors)
- [Gotchas](#gotchas)

---

## Why this exists

The chain's `#[pyde::entry]` macro borsh-decodes calldata into typed args and borsh-encodes return values. The TypeScript codec in this module is a **1:1 mirror** of the borsh-rs wire format — same bytes, same field order. The chain dispatches by function **name** (a String inside `CallPayload`), not by selector hash.

Live-verified against `otigen/examples/borsh-coverage`: full struct (`Order {id, maker, items, paid}`), enum (`Status`), `Vec<u64>` round-trip via `Contract.read` in the integration suite.

---

## Quick reference — minimal example

```ts
import { Provider, Contract, Wallet } from "pyde-ts-sdk";

const provider = new Provider("http://127.0.0.1:9933", { allowInsecureTransport: true });
const counter = await Contract.fromArtifact(
  "./artifacts/counter.bundle/abi.json",
  "0xcontract...",
  provider,
);

// Read
const count = await counter.read("get_count");
console.log("count:", count);
// → count: 0n

// Write
const wallet = Wallet.generate();
wallet.connect(provider);
await wallet.registerPubkey();

const writable = counter.connect(wallet);
const receipt = await writable.write("increment");
console.log("incremented; new count:", await counter.read("get_count"));
// → incremented; new count: 1n
```

---

## `Contract.fromArtifact<TAbi>(path, address, provider)`

Read an `*.abi.json` file from disk (Node-only).

**Signature:**

```ts
Contract.fromArtifact<TAbi extends AbiShape = DefaultAbi>(
  artifactPath: string,
  address: string,
  provider: Provider,
): Promise<Contract<TAbi>>
```

**Args:**

| Name           | Type       | Description                                           |
| -------------- | ---------- | ----------------------------------------------------- |
| `artifactPath` | `string`   | Filesystem path to the `abi.json` (or full artifact). |
| `address`      | `string`   | Deployed contract address.                            |
| `provider`     | `Provider` | Bound provider.                                       |

**Generic:**

- `TAbi` — `pyde-tsgen`-emitted shape for type-safe method/event narrowing. Defaults to `DefaultAbi` (loose). See [Binding TAbi](#binding-tabi-to-a-contract).

**Returns:** `Promise<Contract<TAbi>>`.

**Example:**

```ts
const counter = await Contract.fromArtifact(
  "./out/Counter.bundle/abi.json",
  "0xcontract...",
  provider,
);
```

---

## `Contract.fromJson<TAbi>(json, address, provider)`

Same as `fromArtifact` but accepts an in-memory JSON string. Use in browsers where the artifact is part of your bundle.

**Signature:**

```ts
Contract.fromJson<TAbi extends AbiShape = DefaultAbi>(
  json: string,
  address: string,
  provider: Provider,
): Contract<TAbi>
```

**Example:**

```ts
import abiJson from "./counter.abi.json?raw"; // Vite: ?raw loads as string

const counter = Contract.fromJson(abiJson, "0xcontract...", provider);
```

---

## `Contract.create<TAbi>(address, provider)`

Empty contract — manually register functions with `addFunction()`. Rarely useful; prefer artifact-based construction.

**Signature:**

```ts
Contract.create<TAbi extends AbiShape = DefaultAbi>(
  address: string,
  provider: Provider,
): Contract<TAbi>
```

---

## `contract.connect(wallet)`

Bind a wallet for `write` / `sendCall` operations. Returns a **new** Contract instance; the original (read-only) stays usable.

**Signature:**

```ts
contract.connect(wallet: Wallet): Contract<TAbi>
```

**Example:**

```ts
const counter = await Contract.fromArtifact(abi, addr, provider);
const writable = counter.connect(wallet);

await counter.read("get_count"); // anyone can read
await writable.write("increment", {}); // signer required
```

---

## `contract.read(method, args?)`

Off-chain view call. Encodes args → wraps in `CallPayload` → sends to `provider.call` → borsh-decodes the return.

**Signature (untyped):**

```ts
contract.read(method: string, args?: Record<string, any>): Promise<any>
```

**Signature (with `TAbi`):**

```ts
contract.read<M extends ViewName<TAbi>>(
  method: M,
  args?: FnArgs<TAbi, M>,
): Promise<FnReturns<TAbi, M>>
```

**Args:**

| Name     | Type             | Description                                                                   |
| -------- | ---------------- | ----------------------------------------------------------------------------- |
| `method` | function name    | ABI-declared function. With `TAbi` bound: type-narrowed to view-only methods. |
| `args`   | named-arg object | Each key is a param name; value matches the ABI type.                         |

**Returns:** decoded return value (per ABI declaration).

**No signer required.**

**Example — primitive return:**

```ts
const count = await counter.read("get_count");
console.log(count);
// → 42n
```

**Example — args + primitive return:**

```ts
const balance = await token.read("balance_of", { owner: "0xabc..." });
console.log(balance);
// → 1000000000000n
```

**Example — struct return:**

```ts
// Contract:
//   struct Order { id: u64, maker: Address, items: Vec<String>, paid: bool }
//   fn echo_order(o: Order) -> Order
const order = {
  id: 42n,
  maker: "0x" + "ab".repeat(32),
  items: ["apple", "banana"],
  paid: true,
};
const result = await contract.read("echo_order", { arg0: order });
console.log(result);
// → {
//     id: 42n,
//     maker: "0xababab...ab",
//     items: ["apple", "banana"],
//     paid: true,
//   }
```

**Example — enum return:**

```ts
// Contract:
//   enum Status { Pending, Active, Cancelled }
//   fn get_status() -> Status
const status = await contract.read("get_status");
console.log(status);
// → "Active"
```

---

## `contract.simulate(method, args?)`

Same as `read` but accepts non-view methods too. Runs the call against current state without committing.

**Signature:**

```ts
contract.simulate(method: string, args?: Record<string, any>): Promise<any>
```

Useful for previewing a state-changing call's return value.

---

## `contract.estimateGas(method, args?)`

Pre-flight gas estimate. v1 engine has no dedicated `pyde_estimateGas`; gas + access-list ride a single `pyde_simulateTransaction` dry-run. This convenience wrapper returns a fixed 5,000,000 default + validates arg encoding. For real chain estimates, build the populated tx and call [`provider.simulateTransaction(signedTxHex)`](./02-provider.md#simulatetransactionsignedtxhex) directly.

**Signature:**

```ts
contract.estimateGas(method: string, args?: Record<string, any>): Promise<number>
```

**Example:**

```ts
const gas = await counter.estimateGas("increment");
console.log("will cost:", gas);
// → will cost: 45000
```

---

## `contract.write(method, args?, options?)`

Sign + submit + wait for the receipt. **Wallet required** (call `connect(wallet)` first).

**Signature (untyped):**

```ts
contract.write(
  method: string,
  args?: Record<string, any>,
  options?: { gasLimit?: number; value?: bigint | number | string },
): Promise<ContractReceipt>
```

**Returns:** `Promise<ContractReceipt>`:

```ts
interface ContractReceipt extends Receipt {
  decodeReturnData(): any | null; // decodes per ABI return type
}
```

**Example:**

```ts
const receipt = await counter.connect(wallet).write("deposit", { amount: 500n }, { value: 500n });

if (!receipt.success) {
  throw new Error("reverted");
}
const decoded = receipt.decodeReturnData();
console.log("returned:", decoded);
// → returned: null  (for ()-return functions)
```

**Payability check:**

- If the ABI marks `payable: false` and you pass non-zero `value`, the SDK **throws before submission**.

**Example — payable check:**

```ts
await counter.write("get_count", {}, { value: 1n });
// → throws: "get_count() is not payable — cannot send value"
```

---

## `contract.populateTransaction(method, args?, options?)`

Build the unsigned `TxFields` envelope. Useful for multisig flows, offline signing, or transaction review.

**Signature:**

```ts
contract.populateTransaction(
  method: string,
  args?: Record<string, any>,
  options?: { gasLimit?: number; value?: bigint | number | string },
): Promise<TxFields>
```

**Example:**

```ts
const tx = await counter.connect(wallet).populateTransaction("deposit", { amount: 500n });
console.log("to:", tx.to);
console.log("data length:", (tx.data.length - 2) / 2, "bytes");
console.log("nonce:", tx.nonce);

// Review, then sign externally:
const signed = wallet.signTransaction(tx);
const submitted = await provider.sendRawTransaction(signed);
```

---

## `contract.queryFilter(eventName, fromWave?, toWave?)`

Page historical event logs decoded into typed `EventLog`s.

**Spec:** `HOST_FN_ABI_SPEC.md §15.4`. Max span 5,000 waves per request.

**Signature (untyped):**

```ts
contract.queryFilter(
  eventName: string,
  fromWave?: bigint,
  toWave?: bigint,
): Promise<EventLog[]>
```

**Signature (with `TAbi`):**

```ts
contract.queryFilter<E extends EventName<TAbi>>(
  eventName: E,
  fromWave?: bigint,
  toWave?: bigint,
): Promise<EventLog<EvtArgs<TAbi, E>>[]>
```

**`EventLog` shape:**

```ts
interface EventLog<TArgs = Record<string, any>> {
  name: string; // event name
  args: TArgs; // decoded named fields
  log: Log; // raw log (waveId, txIndex, eventIndex, etc.)
}
```

**Example:**

```ts
const transfers = await token.queryFilter("Transfer", 1000n, 2000n);
for (const ev of transfers) {
  console.log(
    `wave=${ev.log.waveId} ` +
      `from=${ev.args.from} ` +
      `to=${ev.args.to} ` +
      `amount=${ev.args.amount}`,
  );
}
```

**Expected output:**

```
wave=1042n from=0xabc... to=0xdef... amount=1000n
wave=1057n from=0xdef... to=0x123... amount=500n
```

---

## `contract.parseLog(log)`

Decode a single raw `Log` against the contract's ABI. Returns `null` if no event signature matches `log.topics[0]`.

**Signature:**

```ts
contract.parseLog(log: Log): EventLog | null
```

**Example — pair with `getLogs`:**

```ts
const page = await provider.getLogs({
  fromWave: 0n,
  toWave: 1000n,
  contract: token.address,
});

for (const log of page.events) {
  const ev = token.parseLog(log);
  if (ev) {
    console.log(ev.name, ev.args);
  }
}
```

---

## `contract.getEventTopic(eventName)`

The 32-byte topic-0 the chain emits for an event.

**Signature:**

```ts
contract.getEventTopic(eventName: string): string
```

**Returns:** `string` — `0x` + 64 hex.

**Useful when subscribing to logs via `WebSocketProvider`:**

```ts
import { WebSocketProvider } from "pyde-ts-sdk";

const ws = new WebSocketProvider("wss://rpc.pyde.network");
const transferTopic = token.getEventTopic("Transfer");

const unsub = await ws.subscribeLogs(
  { topics: [[transferTopic]], contract: token.address },
  (log) => {
    const ev = token.parseLog(log);
    if (ev) console.log("Transfer:", ev.args);
  },
);
```

---

## Generating bindings with `pyde-tsgen`

```bash
npx pyde-tsgen ./artifacts/counter.bundle/abi.json ./types/counter.d.ts --name Counter
```

The CLI emits a `CounterAbi` shape + per-event interfaces + a legacy `CounterContract` interface.

See [Chapter 05 — Codegen](./05-codegen.md).

---

## Binding `TAbi` to a Contract

```ts
import { Contract } from "pyde-ts-sdk";
import type { CounterAbi } from "./types/counter";

const counter = await Contract.fromArtifact<CounterAbi>(abi, addr, provider);

// ✅ method narrowed
await counter.read("get_count"); // → Promise<bigint>

// ❌ TS2345 — not a method on CounterAbi
await counter.read("getCount");

// ✅ typed args
await counter.write("deposit", { amount: 5n });

// ❌ type error — amount must be bigint
await counter.write("deposit", { amount: "5" });

// ✅ event narrowed
await counter.queryFilter("Transfer");

// ❌ TS2345 — unknown event
await counter.queryFilter("Unknown");
```

The plain `Contract` (no generic) accepts any method name and types as `unknown`.

---

## `contract.encodeCall(method, args?)`

The full borsh-encoded `CallPayload {function, calldata}` bytes you'd put in `tx.data`. Used internally by `write`; exposed for callers building txs manually.

**Signature:**

```ts
contract.encodeCall(method: string, args?: Record<string, any>): string
```

**Returns:** `string` — `0x` + hex of the borsh-encoded `CallPayload`.

**Example:**

```ts
const calldata = counter.encodeCall("deposit", { amount: 500n });
console.log("CallPayload bytes:", (calldata.length - 2) / 2);
```

---

## `contract.encodeCallArgs(method, args?)`

Just the borsh-encoded args (no `CallPayload` wrapper). For byte-level comparison against a borsh-rs encoder in tests.

**Signature:**

```ts
contract.encodeCallArgs(method: string, args?: Record<string, any>): string
```

---

## The borsh codec — supported types (full table)

The SDK's codec is a 1:1 mirror of the borsh-rs wire format. Every type below has a round-trip live-verified against `otigen/examples/borsh-coverage`.

### Scalars

| ABI type | Wire format              | JS type   | Range            |
| -------- | ------------------------ | --------- | ---------------- |
| `u8`     | 1 byte                   | `bigint`  | 0..255           |
| `u16`    | 2 LE bytes               | `bigint`  | 0..65,535        |
| `u32`    | 4 LE bytes               | `bigint`  | 0..4,294,967,295 |
| `u64`    | 8 LE bytes               | `bigint`  | 0..2⁶⁴-1         |
| `u128`   | 16 LE bytes              | `bigint`  | 0..2¹²⁸-1        |
| `u256`   | 32 LE bytes (Pyde ext.)  | `bigint`  | 0..2²⁵⁶-1        |
| `i8`     | 1 byte, two's complement | `bigint`  | -128..127        |
| `i16`    | 2 LE bytes               | `bigint`  | -32,768..32,767  |
| `i32`    | 4 LE bytes               | `bigint`  | -2³¹..2³¹-1      |
| `i64`    | 8 LE bytes               | `bigint`  | -2⁶³..2⁶³-1      |
| `i128`   | 16 LE bytes              | `bigint`  | -2¹²⁷..2¹²⁷-1    |
| `i256`   | 32 LE bytes (Pyde ext.)  | `bigint`  | -2²⁵⁵..2²⁵⁵-1    |
| `bool`   | 1 byte (`00` / `01`)     | `boolean` | —                |

### Bytes + addresses

| ABI type                    | Wire format                 | JS type                         |
| --------------------------- | --------------------------- | ------------------------------- |
| `Address`, `Hash`, `Hash32` | 32 raw bytes                | `string` — `0x` + 64 hex        |
| `FixedBytes:N` (N ≠ 32)     | N raw bytes                 | `string` — `0x` + 2N hex        |
| `String`                    | 4-byte LE len + UTF-8 bytes | `string`                        |
| `Bytes`, `Vec<u8>`          | 4-byte LE len + raw bytes   | `Uint8Array` (or hex on encode) |

### Containers

| ABI type              | Wire format                                 | JS type          |
| --------------------- | ------------------------------------------- | ---------------- |
| `Vec<T>`              | 4-byte LE count + items                     | `T[]`            |
| `Option<T>`           | 1-byte tag (0=None, 1=Some) + value if Some | `T \| null`      |
| `(T1, T2, ...)` tuple | items concatenated, no header               | `[T1, T2, ...]`  |
| `[T; N]` fixed array  | N items concatenated, no header             | `T[]` (length N) |

### User-declared types

| ABI type                  | Wire format                              | JS type                     |
| ------------------------- | ---------------------------------------- | --------------------------- |
| struct (declared in ABI)  | fields concatenated in declaration order | `{ field: T, ... }`         |
| enum (unit variants only) | 1-byte variant index                     | `"VariantName"` or `number` |

### Multi-arg encoding

Functions with 2+ args: the chain decodes `<(T1, T2, ...) as BorshDeserialize>::try_from_slice` — the SDK concatenates each borsh-encoded arg in order, **no tuple header**.

### Selectors are ignored

The ABI ships `selector: [b0, b1, b2, b3]` for forward compatibility but the chain dispatches by function **name** (a String inside `CallPayload`), not selector.

---

## Standalone decoders

When you have a raw hex return value and the type, decode without instantiating a `Contract`.

```ts
import {
  decodeU64,
  decodeI64,
  decodeU128,
  decodeI128,
  decodeU256,
  decodeI256,
  decodeBool,
  decodeAddress,
  decodeString,
  decodeBytes,
  decodeVecU64,
  decodeVecBool,
  decodeVecAddress,
} from "pyde-ts-sdk";
```

**Example:**

```ts
const hex = "0x2a00000000000000";
console.log(decodeU64(hex));
// → 42n
```

**Example — Vec:**

```ts
const hex = "0x03000000" + "01" + "00" + "01";
console.log(decodeVecBool(hex));
// → [true, false, true]
```

---

## `Interface` — no contract instance

Use when you need to encode/decode without a `Provider` or contract address — script encoders, indexer backends.

```ts
import { Interface } from "pyde-ts-sdk";

const iface = await Interface.fromArtifact("./Counter.abi.json");

const calldata = iface.encodeFunctionData("deposit", { amount: 500n });
console.log("calldata bytes:", (calldata.length - 2) / 2);

const decoded = iface.decodeFunctionResult("get_count", "0x2a00000000000000");
console.log("decoded:", decoded);
// → decoded: 42n
```

---

## `DeployData` — deploy-tx payload

```ts
import { DeployData, Wallet } from "pyde-ts-sdk";

const data = await DeployData.fromArtifact("./out/Counter.bundle", {
  // init args matching the contract's `pyde::init` signature
});

const wallet = Wallet.generate();
wallet.connect(provider);
const receipt = await wallet.deploy(data);
console.log("contract:", receipt.returnData);
```

Most authors use the `otigen deploy` CLI instead.

---

## Errors

| Error                                 | When                                                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `Error("Unknown function 'X'")`       | `read` / `write` called with a method not in the ABI.                                                  |
| `Error("missing required param 'X'")` | An arg was `undefined`.                                                                                |
| `Error("expected ... got ...")`       | Type mismatch in `encodeValue` (e.g. string passed where `bigint` expected).                           |
| `Error("X() is not payable")`         | `write` with non-zero `value` on a non-payable function.                                               |
| `RpcError` (from `Provider.call`)     | Chain returned `decode CallPayload from data` → file a bug; the SDK and chain disagree on wire format. |
| `CallExceptionError`                  | `pyde_call` reverted; `revertReason` populated.                                                        |

See [Chapter 10 — Errors](./10-errors.md).

---

## Gotchas

- **Function args are passed by name.** `contract.read("balance_of", { owner: "0x..." })`. The ABI declares param names like `arg0`, `arg1` if the source didn't; codegen surfaces the right names.
- **`bigint` for every integer type.** Even `u8` decodes to `bigint` — keeps the API uniform.
- **`Address` is a hex string, not a `Uint8Array`.** Encoder accepts `"0x" + 64hex` or `64hex` (no prefix).
- **`Bytes` accepts hex strings too.** `{ data: "0xdeadbeef" }` works as well as `{ data: new Uint8Array([0xde, 0xad, 0xbe, 0xef]) }`.
- **Enum variants are 1 byte each — only the first 256 variants encode.**
- **Data-carrying enum variants are not yet supported** (only unit variants).
- **The chain ignores the SDK's `selectorBytes`.** Dispatch is by name. If your ABI ships custom selectors, they're informational.
- **`queryFilter` wave span is capped at 5,000.** Larger queries return an RPC error.
- **Contract.write payability check happens client-side**. If the chain ABI is out of date, the SDK may permit a value-bearing call against a contract that the chain rejects.
