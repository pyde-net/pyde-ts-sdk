# 14 — Internals

Wire format reference, design tradeoffs, "why does it do that". For SDK contributors + anyone debugging cross-language interop.

[← TOC](./README.md)

## Borsh — the wire format

The SDK's contract codec is a 1:1 mirror of the **borsh-rs canonical** spec. The chain's `#[pyde::entry]` macro borsh-decodes calldata into typed args and borsh-encodes returns. The SDK matches exactly so cross-language clients (Rust, Go, Zig, AssemblyScript) all see the same bytes.

### Scalars

| Type | Bytes | Encoding |
|---|---|---|
| `u8`, `i8` | 1 | Direct byte (`i8` is two's complement) |
| `u16`, `i16` | 2 | Little-endian (`i16` two's complement) |
| `u32`, `i32` | 4 | Little-endian |
| `u64`, `i64` | 8 | Little-endian |
| `u128`, `i128` | 16 | Little-endian |
| `u256`, `i256` | 32 | Little-endian (Pyde extension; borsh-rs doesn't ship u256 natively) |
| `bool` | 1 | `0x00` (false) or `0x01` (true) |

For signed types, the encoder masks to the type's bit width so two's-complement negatives round-trip correctly.

### Strings, Bytes, Vec

| Type | Format |
|---|---|
| `String` | 4-byte LE u32 length + UTF-8 bytes. **No padding, no null terminator.** |
| `Vec<u8>` / `Bytes` | 4-byte LE u32 length + raw bytes. |
| `Vec<T>` | 4-byte LE u32 count + T-encoded items. |

### Option, Tuple, Array

| Type | Format |
|---|---|
| `Option<T>` | 1-byte tag (`0x00` = None, `0x01` = Some) + T-encoded value if Some. |
| `(T1, T2, ...)` tuple | Items concatenated. No header, no length, no separator. |
| `[T; N]` fixed array | N items concatenated. No length prefix. |

### Struct + Enum

| Type | Format |
|---|---|
| Struct | Fields concatenated in declaration order. No header. |
| Enum (unit variants only) | 1-byte variant index. v1 supports unit variants only — data-carrying variants are planned for v1.1. |

### Fixed-byte arrays

| Type | Format |
|---|---|
| `Address`, `Hash`, `Hash32` | 32 raw bytes |
| `FixedBytes:N` (where N ≠ 32) | N raw bytes |

`Address` is a `[u8; 32]` array; encoder takes a `0x`-prefixed hex string and writes the 32 bytes verbatim.

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
4-byte u32 LE        // function name length
N bytes              // function name UTF-8
4-byte u32 LE        // calldata length
M bytes              // borsh-encoded args (concat — no tuple header)
```

The chain dispatches by **function name**, not by 4-byte selector hash. ABI artifacts still ship a `selector: [b0, b1, b2, b3]` for forward compatibility — the SDK records it via `selectorBytes` on `AbiFunction` but doesn't use it for routing.

## Multi-arg encoding

For a function with N ≥ 2 args, the chain decodes:

```rust
let (a, b, c, ...): (T1, T2, T3, ...) =
    <(T1, T2, T3, ...) as BorshDeserialize>::try_from_slice(&calldata)?;
```

Borsh's tuple encoding is just "concatenate the field encodings, no header" — so the SDK encodes each arg in declaration order and concatenates. Same wire bytes as encoding a one-arg tuple, or zero-arg empty buffer.

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
  "events_count": 0,
  ...
}
```

The SDK's `fromWireWaveHeader` tolerates three forms for hash-shaped fields:
- Already-hex `"0xabcd..."` string.
- Raw 32-byte JSON array `[15, 156, 224, ...]`.
- Dual-hash struct `{blake3: [...], poseidon2: [...]}`.

The Blake3 leg of `state_root` is the execution-side authority (per the `hash_strategy_and_validation` memo) — that's what the SDK surfaces. Timestamps are synthesised from `anchor_round` when missing.

## Account null-vs-zeroed

`pyde_getAccount` returns a populated zero-account for unknown addresses on some engine builds (with `account_type: "eoa"`, `balance: 0x0`, etc.) and `null` on others. The SDK's `Provider.getAccount` distinguishes:

```ts
if (!result || typeof result !== "object") return null;
const o = result as Record<string, unknown>;
if (!o.address && !o.nonce && !o.balance) return null; // empty envelope → null
return fromWireAccount(result);
```

A zero-balance account that's been touched (e.g., a registered EOA before its first deposit) has at least `address` populated and surfaces as a populated `Account`. A truly absent account returns `null`.

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
