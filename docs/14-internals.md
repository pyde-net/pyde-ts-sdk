# 14 — Internals

Wire format reference, design tradeoffs, "why does it do that". For SDK contributors + anyone debugging cross-language interop.

[← TOC](./README.md)

---

## Table of contents

- [Borsh — the wire format](#borsh--the-wire-format)
  - [Scalars (with exact wire bytes)](#scalars-with-exact-wire-bytes)
  - [Strings, Bytes, Vec](#strings-bytes-vec)
  - [Option, Tuple, Array](#option-tuple-array)
  - [Struct + Enum](#struct--enum)
  - [Fixed-byte arrays](#fixed-byte-arrays)
- [`CallPayload` wrapping](#callpayload-wrapping)
- [Multi-arg encoding](#multi-arg-encoding)
- [Transaction wire format](#transaction-wire-format)
- [ABI normalisation](#abi-normalisation)
  - [`attrs.bits` packing](#attrsbits-packing)
- [Wave header tolerance](#wave-header-tolerance)
- [Receipt status tolerance](#receipt-status-tolerance)
- [Account null-vs-zeroed](#account-null-vs-zeroed)
- [Codec design tradeoffs](#codec-design-tradeoffs)
- [Files involved](#files-involved)
- [Spec references](#spec-references)

---

## Borsh — the wire format

The SDK's contract codec is a **1:1 mirror** of the borsh-rs canonical spec. The chain's `#[pyde::entry]` macro borsh-decodes calldata into typed args and borsh-encodes returns. The SDK matches exactly so cross-language clients (Rust, Go, Zig, AssemblyScript) all see the same bytes.

### Scalars (with exact wire bytes)

| Type | Bytes | Encoding | Example value | Wire bytes |
|---|---|---|---|---|
| `u8`, `i8` | 1 | Direct byte | `u8 = 42` | `2a` |
| `u16`, `i16` | 2 | Little-endian | `u16 = 0x1234` | `34 12` |
| `u32`, `i32` | 4 | Little-endian | `u32 = 0xdeadbeef` | `ef be ad de` |
| `u64`, `i64` | 8 | Little-endian | `u64 = 42` | `2a 00 00 00 00 00 00 00` |
| `u128`, `i128` | 16 | Little-endian | `u128 = 1 << 100` | (1 at byte 12) |
| `u256`, `i256` | 32 | Little-endian (Pyde ext.) | `u256 = 1 << 200` | (1 at byte 25) |
| `bool` | 1 | `0x00` (false) / `0x01` (true) | `true` | `01` |

For signed types, the encoder masks to the type's bit width so two's-complement negatives round-trip correctly:

```
i8 = -1   →  0xff
i8 = -128 →  0x80
i16 = -1  →  0xff 0xff
```

### Strings, Bytes, Vec

| Type | Format | Example | Wire bytes |
|---|---|---|---|
| `String` | 4-byte LE u32 length + UTF-8 bytes (no padding, no null terminator) | `"hi"` | `02 00 00 00 68 69` |
| `Vec<u8>` / `Bytes` | 4-byte LE u32 length + raw bytes | `[0xde, 0xad, 0xbe, 0xef]` | `04 00 00 00 de ad be ef` |
| `Vec<T>` | 4-byte LE u32 count + T-encoded items | `Vec<u64> = [1, 2, 3]` | `03 00 00 00 01 00 00 00 00 00 00 00 02 00 00 00 00 00 00 00 03 00 00 00 00 00 00 00` |

**Empty Vec is 4 bytes, not 0:** `Vec<u8>::default()` → `00 00 00 00` (length 0).

### Option, Tuple, Array

| Type | Format | Example | Wire bytes |
|---|---|---|---|
| `Option<T>` | 1-byte tag (`00` = None, `01` = Some) + T-encoded value if Some | `Option<u32> = None` | `00` |
| `Option<T>` (Some) | `01` + value bytes | `Option<u32> = Some(42)` | `01 2a 00 00 00` |
| `(T1, T2, ...)` tuple | Items concatenated. No header, no length, no separator. | `(u8, u8) = (1, 2)` | `01 02` |
| `[T; N]` fixed array | N items concatenated. No length prefix. | `[u8; 4] = [1, 2, 3, 4]` | `01 02 03 04` |

### Struct + Enum

| Type | Format | Example | Wire bytes |
|---|---|---|---|
| Struct | Fields concatenated in **declaration order**. No header. | `struct Order { id: u64, paid: bool }` with `id=42, paid=true` | `2a 00 00 00 00 00 00 00 01` |
| Enum (unit variants) | 1-byte variant index | `enum Status { Pending=0, Active=1, Cancelled=2 }`, `Active` | `01` |

**v1 supports unit-variant enums only.** Data-carrying variants are planned for v1.1.

### Fixed-byte arrays

| Type | Format | Notes |
|---|---|---|
| `Address`, `Hash`, `Hash32` | 32 raw bytes | Encoder takes a `0x`-prefixed hex string and writes the 32 bytes verbatim. |
| `FixedBytes:N` (where N ≠ 32) | N raw bytes | Same as `[u8; N]`. |

```
Address "0x" + "ab" × 32  →  ab ab ab ab ... ab  (32 bytes)
FixedBytes:4 "0xdeadbeef" →  de ad be ef
```

---

## `CallPayload` wrapping

The chain's `pyde_call` RPC and the tx-data field both expect a borsh-encoded `CallPayload` struct, not bare calldata:

```rust
// pyde_engine_types
struct CallPayload {
    function: String,   // 4-byte LE len + UTF-8
    calldata: Vec<u8>,  // 4-byte LE len + raw bytes
}
```

`Contract.encodeCall` produces:

```
┌─────────────────────────────────────────────────────────────────┐
│  4 bytes — function name length (u32 LE)                        │
├─────────────────────────────────────────────────────────────────┤
│  N bytes — function name UTF-8                                  │
├─────────────────────────────────────────────────────────────────┤
│  4 bytes — calldata length (u32 LE)                             │
├─────────────────────────────────────────────────────────────────┤
│  M bytes — borsh-encoded args (concat — no tuple header)        │
└─────────────────────────────────────────────────────────────────┘
```

**Concrete example** — `two_args(a: u64, b: String)` called with `a = 7`, `b = "hi"`:

```
function name length  : 08 00 00 00            (length 8 — "two_args")
function name         : 74 77 6f 5f 61 72 67 73 ("two_args")
calldata length       : 0e 00 00 00            (length 14)
calldata              : 07 00 00 00 00 00 00 00 02 00 00 00 68 69
                        └────────────────────┘ └────────┘ └──┘
                          a = 7 (u64 LE)         b len     "hi"
```

The chain dispatches by **function name**, not by 4-byte selector hash. ABI artifacts still ship a `selector: [b0, b1, b2, b3]` for forward compatibility — the SDK records it via `selectorBytes` on `AbiFunction` but doesn't use it for routing.

---

## Multi-arg encoding

For a function with N ≥ 2 args, the chain decodes:

```rust
let (a, b, c, ...): (T1, T2, T3, ...) =
    <(T1, T2, T3, ...) as BorshDeserialize>::try_from_slice(&calldata)?;
```

Borsh's tuple encoding is just **"concatenate the field encodings, no header"** — so the SDK encodes each arg in declaration order and concatenates. Same wire bytes as encoding a one-arg tuple, or zero-arg empty buffer.

---

## Transaction wire format

Field order matches `pyde_engine_types::Tx` declaration order verbatim. Borsh serialises in declaration order; reordering is a wire-breaking change.

```
┌────────────────────────────────────────────────────────────────┐
│ Field        | Type              | Wire bytes                  │
├────────────────────────────────────────────────────────────────┤
│ from         | Address           | 32 raw bytes                │
│ to           | Address           | 32 raw bytes                │
│ value        | u128              | 16 LE bytes                 │
│ data         | Vec<u8>           | 4-byte u32 LE len + bytes   │
│ gas_limit    | Gas (u64)         | 8 LE bytes                  │
│ nonce        | u64               | 8 LE bytes                  │
│ signature    | FalconSignature   | 4-byte LE len + sig bytes   │
│ fee_payer    | FeePayer enum     | 1-byte discriminant         │
│              |                   | (+ Address for Paymaster)   │
│ access_list  | Vec<AccessEntry>  | 4-byte LE count + entries   │
│ deadline     | Option<u64>       | 1-byte tag + 8 LE if Some   │
│ chain_id     | u64               | 8 LE bytes                  │
│ tx_type      | TxType enum       | 1-byte discriminant         │
└────────────────────────────────────────────────────────────────┘
```

**`FalconSignature` is `Vec<u8>`** — borsh encodes as `4-byte LE length + bytes`, not as a fixed-size 666-byte array (signatures are variable-length, ~666 bytes typical, up to 690 max).

**`FeePayer::Sender`** is a single `0x00` byte (variant discriminant, no payload).

**`Option::None`** is a single `0x00` byte.

For an **empty** access list, encode `0x00 0x00 0x00 0x00` (Vec count = 0).

---

## ABI normalisation

The `otigen build` artifact uses a discriminated-union type shape:

```json
{
  "functions": [
    {
      "name": "echo_order",
      "selector": [60, 227, 214, 90],
      "attrs": { "bits": 129 },
      "params": [{ "name": "arg0", "ty": { "Custom": "Order" } }],
      "returns": { "Custom": "Order" }
    }
  ],
  "types": [
    {
      "name": "Order",
      "kind": {
        "Struct": {
          "fields": [
            { "name": "id", "ty": "U64" },
            { "name": "maker", "ty": { "FixedBytes": 32 } }
          ]
        }
      }
    }
  ]
}
```

The SDK's `normaliseAbiFunction` / `normaliseAbiType` flatten this to the encoder's expected shape:

| Engine wire | Normalised |
|---|---|
| `"U64"` | `"u64"` |
| `"Bool"` | `"bool"` |
| `"String"`, `"Bytes"`, `"Address"` | unchanged |
| `{ "Custom": "Order" }` | `"Order"` (resolved via struct/enum registry) |
| `{ "Vec": "U64" }` | `"Vec<u64>"` |
| `{ "FixedBytes": 32 }` | `"Address"` (alias) |
| `{ "FixedBytes": N }` for N ≠ 32 | `"FixedBytes:N"` |
| `{ "Option": "U32" }` | `"Option<u32>"` |
| `null` (returns) | `"()"` |

`types[]` is split into `structs[]` + `enums[]` maps the encoder/decoder consults at call time.

### `attrs.bits` packing

The engine packs function attributes into a 16-bit mask:

| Bit | Meaning |
|---|---|
| 0 (`0x01`) | `view` |
| 1 (`0x02`) | `payable` |
| 7 (`0x80`) | (reserved / "external") |
| other | (reserved) |

The normalizer extracts `view = (bits & 1) !== 0`, `payable = (bits & 2) !== 0`.

**Example:** `attrs.bits = 129 = 0x81 = 0b10000001` → `view: true`, `payable: false`, bit 7 set.

---

## Wave header tolerance

The engine's wave-header wire shape ships dual-hash state roots + byte-array anchors + no `timestamp`:

```json
{
  "wave_id": 0,
  "anchor_hash": [23, 162, ...],          // 32-byte JSON array
  "anchor_round": 0,
  "epoch": 0,
  "state_root": {
    "blake3": [15, 156, ...],
    "poseidon2": [0, 0, ...]
  },
  "events_root": [0, 0, ...],
  "tx_count": 0,
  "events_count": 0
}
```

The SDK's `fromWireWaveHeader` tolerates three forms for hash-shaped fields:

- Already-hex `"0xabcd..."` string.
- Raw 32-byte JSON array `[15, 156, 224, ...]`.
- Dual-hash struct `{blake3: [...], poseidon2: [...]}`.

The **Blake3 leg** of `state_root` is the execution-side authority (per the `hash_strategy_and_validation` memo) — that's what the SDK surfaces. Timestamps are synthesised from `anchor_round` when missing.

---

## Receipt status tolerance

The chain emits `status` as a string (`"success" | "reverted" | "out_of_gas"`); older specs used a boolean `success`. The SDK accepts both:

```ts
const status = typeof o.status === "string" ? o.status : null;
const success =
  typeof o.success === "boolean"
    ? o.success
    : status !== null
      ? status === "success"
      : false;
```

It also falls back to `"0x0"` / `[]` for optional fields (`effective_gas`, `fee_burned`, `fee_validator`, `logs`) when the chain doesn't ship them — devnet receipts are sparse.

---

## Account null-vs-zeroed

`pyde_getAccount` returns a populated zero-account for unknown addresses on some engine builds (`account_type: "eoa"`, `balance: 0x0`, etc.) and `null` on others. The SDK's `Provider.getAccount` distinguishes:

```ts
if (!result || typeof result !== "object") return null;
const o = result as Record<string, unknown>;
if (!o.address && !o.nonce && !o.balance) return null; // empty envelope → null
return fromWireAccount(result);
```

A zero-balance account that's been touched (e.g., a registered EOA before its first deposit) has at least `address` populated and surfaces as a populated `Account`. A truly absent account returns `null`.

---

## Codec design tradeoffs

### Why not a single decoder for everything (no normalisation)?

The engine's wire shape moves with the chain ABI version. The SDK normalises once at load time so the encoder / decoder operate on a stable flat-string type representation. Adding a new wire-form variant (e.g., `{ "Map": [K, V] }`) is one switch case in the normalizer, not a rewrite of the encoder.

### Why not codegen the encoder per contract?

Considered. Trade-off: every contract would need a build step + emit, and the runtime / artifact-load path would still need a generic decoder (for unknown ABI artifacts, indexer-style use cases). Keeping one runtime codec covers both cases and the chain's borsh-rs reference implementation is already canonical.

### Why `bigint` for every integer type?

Uniform API. `u32` could be a `number`, but mixing `number` and `bigint` at call sites is a footgun — `1n + 1` throws, `1 + 1n` throws. Picking `bigint` everywhere means call-site code is type-stable and the compiler enforces it.

### Why `Address` as a hex string, not `Uint8Array`?

Three reasons:

1. Most users write address literals as strings; `"0x..."` is the natural form.
2. JSON-RPC, logs, dapp UIs all use string addresses. `Uint8Array` would require encode-on-output everywhere.
3. The borsh encoder is just `bytesFromHex(value)` — the conversion is cheap and happens once per arg.

`Bytes` is `Uint8Array` because the natural use case (arbitrary opaque payloads) is closer to byte semantics than to string semantics.

---

## Files involved

| Path | Role |
|---|---|
| `src/contract.ts` | Borsh codec, `Contract<TAbi>`, ABI normalisation |
| `src/provider.ts` | HTTP JSON-RPC client + wire-shape adapters |
| `src/ws-provider.ts` | WSS subscriptions + reconnect / cursor resume |
| `src/wallet.ts` | Handle vs hex SK, sign / transfer / keystore |
| `src/wallet-adapter.ts` | Dapp ↔ wallet adapter interface |
| `src/crypto.ts` | Thin TS wrapper around `pyde-crypto-wasm` |
| `src/codegen.ts` + `src/cli-tsgen.ts` | `pyde-tsgen` codegen module + CLI |
| `src/react.ts` | React hooks + `<PydeProvider>` |
| `src/errors.ts` | Error hierarchy + `isError` |
| `src/simulate.ts` | Tier 1 RPC-backed simulation; Tier 2 local wasmtime in v1.1 |

---

## Spec references

Tied to the latest Pyde Book (`book.pyde.network`):

| SDK behavior | Spec |
|---|---|
| Borsh wire format | Pyde Book Chapter 11, `HOST_FN_ABI_SPEC.md §14` |
| `CallPayload` shape | `pyde_engine_types::CallPayload` |
| Function attribute bits | `HOST_FN_ABI_SPEC.md §3.5` |
| Wave-header dual-hash state root | `hash_strategy_and_validation` memo |
| Threshold encryption flow | Pyde Book Chapter 8.5 + Chapter 9 |
| Event encoding (Borsh-default) | `HOST_FN_ABI_SPEC.md §14` |
| Address = full Poseidon2 (no truncation) | Pyde Book Chapter 6 |
| u64 nonce + 16-slot sliding window | Pyde Book Chapter 11 |
| Keystore (Argon2id + ChaCha20-Poly1305) | Pyde Book Chapter 17 |
