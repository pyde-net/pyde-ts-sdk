# 11 — Utility surface

Units (PYDE ↔ quanta), hex helpers (isomorphic `Uint8Array` + hex strings), address validation.

[← TOC](./README.md)

## Units

Pyde uses **9 decimals**. The on-chain unit is **quanta** (1 PYDE = 10⁹ quanta). Always work in `bigint` quanta inside the SDK; convert to PYDE only at display time.

```ts
import { parseQuanta, formatQuanta, parsePyde, formatPyde, parseUnits, formatUnits } from "pyde-ts-sdk";
```

### `parseQuanta(value: string): bigint`

Decimal-string → bigint quanta. Accepts both whole and fractional inputs.

```ts
parseQuanta("1.5");      // → 1500000000n
parseQuanta("1000");     // → 1000000000000n
parseQuanta("0.000001"); // → 1000n
```

### `formatQuanta(value: bigint | number | string): string`

Bigint / number / hex / decimal-string → human PYDE string with up to 9 decimal places, trimmed.

```ts
formatQuanta(1500000000n); // → "1.5"
formatQuanta(10n ** 9n);   // → "1.0"
formatQuanta(0n);          // → "0.0"
```

`parsePyde` / `formatPyde` are aliases — the surface exports both names for symmetry with the `parseUnits` / `formatUnits` generic pair.

### `parseUnits(value: string, decimals: number): bigint` and `formatUnits(value, decimals): string`

Generic decimal-aware versions for custom decimal counts (e.g., stablecoin contracts with 6 decimals).

```ts
parseUnits("1.5", 6);     // → 1500000n
formatUnits(1500000n, 6); // → "1.5"
```

### When to use which

| Working with | Use |
|---|---|
| Native PYDE on chain | `parseQuanta` / `formatQuanta` |
| Native PYDE in dapp UI | `parseQuanta` / `formatQuanta` |
| Custom-decimal tokens | `parseUnits(..., tokenDecimals)` |
| Anywhere quanta is the natural unit (gas, fees, raw amounts) | `bigint` directly, no conversion |

## Hex helpers

Isomorphic — work in both Node and the browser. Internally use `Uint8Array` + `DataView`, no `Buffer`.

```ts
import {
  isHexString, hexlify, getBytes, toBeHex,
  concat, zeroPadValue, stripZeros,
  dataLength, dataSlice,
} from "pyde-ts-sdk";
```

### `isHexString(value, length?): boolean`

Quack-check for a `0x`-prefixed hex string. `length` is byte count (not char count) — `isHexString(addr, 32)` checks a 32-byte address.

```ts
isHexString("0xdeadbeef");      // true
isHexString("0xdeadbeef", 4);   // true (4 bytes)
isHexString("not hex");         // false
isHexString("0xdeadbeef", 32);  // false (wrong length)
```

### `hexlify(value): string`

Anything → `0x`-prefixed hex string.

```ts
hexlify(new Uint8Array([1, 2, 3])); // "0x010203"
hexlify(42);                         // "0x2a"
hexlify(42n);                        // "0x2a"
hexlify("0xff");                     // "0xff"
```

### `getBytes(value): Uint8Array`

Hex string or `Uint8Array` → `Uint8Array`. Inverse of `hexlify`.

```ts
getBytes("0x010203");                  // Uint8Array(3) [1, 2, 3]
getBytes(new Uint8Array([4, 5]));      // Uint8Array(2) [4, 5]
```

### `toBeHex(value, width?): string`

Bigint / number → big-endian hex, optionally zero-padded to `width` bytes.

```ts
toBeHex(1);          // "0x01"
toBeHex(1, 4);       // "0x00000001"
toBeHex(0x1234n, 4); // "0x00001234"
```

### `concat(values): string`

Concatenate hex strings or `Uint8Array`s into a single hex string.

```ts
concat(["0xabcd", new Uint8Array([0xef]), "0x01"]); // "0xabcdef01"
```

### `zeroPadValue(value, length): string`

Left-pad with zeros to `length` bytes.

```ts
zeroPadValue("0x1234", 4); // "0x00001234"
```

### `stripZeros(value): string`

Strip leading zero bytes.

```ts
stripZeros("0x00001234"); // "0x1234"
```

### `dataLength(hex): number`

Byte length (hex char count / 2).

```ts
dataLength("0xdeadbeef"); // 4
```

### `dataSlice(hex, start, end?): string`

Slice by byte offsets — like `Uint8Array.subarray` but for hex strings.

```ts
dataSlice("0xdeadbeef", 1);    // "0xadbeef"
dataSlice("0xdeadbeef", 1, 3); // "0xadbe"
```

## Addresses (`Address`)

```ts
import { Address } from "pyde-ts-sdk";
```

Object namespace — every method is a pure function.

| Method | Returns | Notes |
|---|---|---|
| `Address.zero()` | `string` | The 32-byte zero address. |
| `Address.isZero(addr)` | `boolean` | True if all bytes are zero. |
| `Address.isValid(addr)` | `boolean` | 32 bytes, valid hex chars. |
| `Address.validate(addr)` | `string` | Validates + normalises to `0x`-prefix. Throws on invalid. |
| `Address.equals(a, b)` | `boolean` | Case-insensitive compare. |
| `Address.isValidPrivateKey(hex)` | `boolean` | Checks a combined FALCON-512 (pk + sk) hex blob — 2,178 bytes. |

### Why 32 bytes?

Pyde addresses are the **full Poseidon2** hash of a registration payload — no truncation, no checksum bits. 32 bytes everywhere; no Ethereum-style 20-byte addresses.

This also means parachain / contract addresses share the same address space as EOAs — there's no separate "contract id" type.

## Encoding constants

Worth keeping handy:

| Constant | Value |
|---|---|
| Zero address | `0x` + `00` × 32 |
| Decimals per PYDE | 9 |
| FALCON-512 pubkey size | 897 bytes (1,794 hex chars) |
| FALCON-512 secret key size | 1,281 bytes (2,562 hex chars) |
| FALCON-512 signature size | ~666 bytes (compact-encoded) |
| Poseidon2 hash output | 32 bytes |
| Blake3 hash output | 32 bytes |
| Kyber-768 ciphertext size | 1,088 bytes |
| Address byte length | 32 |

## Gotchas

- **PYDE has 9 decimals, not 18.** Don't reuse `ethers.formatEther` — wrong decimal count.
- **`parseQuanta("1")` is 1 *PYDE*, not 1 *quanta*.** Use `1n` directly for one quanta.
- **`Number(quanta)` loses precision above 2^53.** Format via `formatQuanta` instead of pre-converting to `Number`.
- **Addresses are case-insensitive on chain** but display in lower-case by convention. `Address.equals` normalises both sides.
- **`isHexString(x, 32)` checks 32 bytes (64 hex chars).** Some other libraries take `length` as char count — different convention.
