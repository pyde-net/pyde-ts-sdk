# 11 — Utility surface

Units (PYDE ↔ quanta), hex helpers (isomorphic `Uint8Array` + hex strings), address validation, encoding constants.

[← TOC](./README.md)

---

## Table of contents

- Units
  - [`parseQuanta(value)`](#parsequantavalue)
  - [`formatQuanta(value)`](#formatquantavalue)
  - [`parseUnits(value, decimals)`](#parseunitsvalue-decimals)
  - [`formatUnits(value, decimals)`](#formatunitsvalue-decimals)
- Hex helpers
  - [`isHexString(value, length?)`](#ishexstringvalue-length)
  - [`hexlify(value)`](#hexlifyvalue)
  - [`getBytes(value)`](#getbytesvalue)
  - [`toBeHex(value, width?)`](#tobehexvalue-width)
  - [`concat(values)`](#concatvalues)
  - [`zeroPadValue(value, length)`](#zeropadvaluevalue-length)
  - [`stripZeros(value)`](#stripzerosvalue)
  - [`dataLength(hex)`](#datalengthhex)
  - [`dataSlice(hex, start, end?)`](#dataslicehex-start-end)
- Addresses
  - [`Address.zero()`](#addresszero)
  - [`Address.isZero(addr)`](#addressiszeroaddr)
  - [`Address.isValid(addr)`](#addressisvalidaddr)
  - [`Address.equals(a, b)`](#addressequalsa-b)
  - [`Address.isValidPrivateKey(hex)`](#addressisvalidprivatekeyhex)
- [Encoding constants — handy reference](#encoding-constants--handy-reference)
- [Gotchas](#gotchas)

---

## Units

Pyde uses **9 decimals**. The on-chain unit is **quanta** (1 PYDE = 10⁹ quanta). Always work in `bigint` quanta inside the SDK; convert to PYDE only at display time.

```ts
import { parseQuanta, formatQuanta, parseUnits, formatUnits } from "pyde-ts-sdk";
```

### `parseQuanta(value)`

Decimal-string → bigint quanta.

**Signature:**

```ts
function parseQuanta(value: string): bigint;
```

**Args:**

| Name    | Type     | Description                                 |
| ------- | -------- | ------------------------------------------- |
| `value` | `string` | A decimal string, e.g., `"1.5"` (1.5 PYDE). |

**Returns:** `bigint` — quanta.

**Throws:** when `value` isn't a valid decimal.

**Example:**

```ts
console.log(parseQuanta("1.5")); // → 1500000000n
console.log(parseQuanta("1000")); // → 1000000000000n
console.log(parseQuanta("0.000001")); // → 1000n
console.log(parseQuanta("0")); // → 0n
```

---

### `formatQuanta(value)`

Bigint / number / hex / decimal-string → human PYDE string.

**Signature:**

```ts
function formatQuanta(value: bigint | number | string): string;
```

**Returns:** `string` — PYDE string with up to 9 decimal places, trimmed.

**Example:**

```ts
console.log(formatQuanta(1500000000n)); // → "1.5"
console.log(formatQuanta(10n ** 9n)); // → "1.0"
console.log(formatQuanta(0n)); // → "0.0"
console.log(formatQuanta("0x3b9aca00")); // hex string → "1.0"
```

---

### `parseUnits(value, decimals)`

Generic decimal-aware parser for custom decimal counts (e.g., a stablecoin contract with 6 decimals).

**Signature:**

```ts
function parseUnits(value: string, decimals: number): bigint;
```

**Example:**

```ts
console.log(parseUnits("1.5", 6)); // → 1500000n
console.log(parseUnits("100", 18)); // → 100000000000000000000n
```

---

### `formatUnits(value, decimals)`

Generic decimal-aware formatter.

**Signature:**

```ts
function formatUnits(value: bigint | number | string, decimals: number): string;
```

**Example:**

```ts
console.log(formatUnits(1500000n, 6)); // → "1.5"
console.log(formatUnits(10n ** 18n, 18)); // → "1.0"
```

---

### When to use which

| Working with                                                 | Use                              |
| ------------------------------------------------------------ | -------------------------------- |
| Native PYDE on chain                                         | `parseQuanta` / `formatQuanta`   |
| Native PYDE in dapp UI                                       | `parseQuanta` / `formatQuanta`   |
| Custom-decimal tokens                                        | `parseUnits(..., tokenDecimals)` |
| Anywhere quanta is the natural unit (gas, fees, raw amounts) | `bigint` directly, no conversion |

---

## Hex helpers

Isomorphic — work in both Node and the browser. Internally use `Uint8Array` + `DataView`, no `Buffer`.

```ts
import {
  isHexString,
  hexlify,
  getBytes,
  toBeHex,
  concat,
  zeroPadValue,
  stripZeros,
  dataLength,
  dataSlice,
} from "pyde-ts-sdk";
```

---

### `isHexString(value, length?)`

Quack-check for a `0x`-prefixed hex string.

**Signature:**

```ts
function isHexString(value: unknown, length?: number): boolean;
```

**Args:**

| Name     | Type      | Description                                                                            |
| -------- | --------- | -------------------------------------------------------------------------------------- |
| `value`  | `unknown` | Anything.                                                                              |
| `length` | `number`  | Optional **byte** count (not char count). `isHexString(addr, 32)` checks for 32 bytes. |

**Returns:** `boolean`.

**Example:**

```ts
console.log(isHexString("0xdeadbeef")); // → true
console.log(isHexString("0xdeadbeef", 4)); // → true (4 bytes)
console.log(isHexString("not hex")); // → false
console.log(isHexString("0xdeadbeef", 32)); // → false (wrong length)
console.log(isHexString(42)); // → false
```

---

### `hexlify(value)`

Anything → `0x`-prefixed hex string.

**Signature:**

```ts
function hexlify(value: string | Uint8Array | bigint | number): string;
```

**Args:**

| Name    | Type    | Description                                                                                              |
| ------- | ------- | -------------------------------------------------------------------------------------------------------- |
| `value` | several | `Uint8Array` (encoded as hex), `bigint` / `number` (encoded as BE hex), or already-`0x`-prefixed string. |

**Returns:** `string` — `0x` + hex.

**Example:**

```ts
console.log(hexlify(new Uint8Array([1, 2, 3]))); // → "0x010203"
console.log(hexlify(42)); // → "0x2a"
console.log(hexlify(42n)); // → "0x2a"
console.log(hexlify("0xff")); // → "0xff"
```

---

### `getBytes(value)`

Hex string or `Uint8Array` → `Uint8Array`. Inverse of `hexlify`.

**Signature:**

```ts
function getBytes(value: string | Uint8Array): Uint8Array;
```

**Example:**

```ts
console.log(getBytes("0x010203")); // → Uint8Array(3) [1, 2, 3]
console.log(getBytes(new Uint8Array([4, 5]))); // → Uint8Array(2) [4, 5]
```

---

### `toBeHex(value, width?)`

Bigint / number → big-endian hex, optionally zero-padded to `width` bytes.

**Signature:**

```ts
function toBeHex(value: bigint | number, width?: number): string;
```

**Example:**

```ts
console.log(toBeHex(1)); // → "0x01"
console.log(toBeHex(1, 4)); // → "0x00000001"
console.log(toBeHex(0x1234n, 4)); // → "0x00001234"
```

---

### `concat(values)`

Concatenate hex strings and/or `Uint8Array`s into a single hex string.

**Signature:**

```ts
function concat(values: (string | Uint8Array)[]): string;
```

**Example:**

```ts
console.log(concat(["0xabcd", new Uint8Array([0xef]), "0x01"]));
// → "0xabcdef01"
```

---

### `zeroPadValue(value, length)`

Left-pad with zeros to `length` bytes.

**Signature:**

```ts
function zeroPadValue(value: string | Uint8Array, length: number): string;
```

**Example:**

```ts
console.log(zeroPadValue("0x1234", 4)); // → "0x00001234"
console.log(zeroPadValue("0x1234", 32)); // → "0x0000…00001234" (32-byte address-shaped)
```

---

### `stripZeros(value)`

Strip leading zero bytes.

**Signature:**

```ts
function stripZeros(value: string | Uint8Array): string;
```

**Example:**

```ts
console.log(stripZeros("0x00001234")); // → "0x1234"
console.log(stripZeros("0x00")); // → "0x"
```

---

### `dataLength(hex)`

Byte length (hex char count / 2).

**Signature:**

```ts
function dataLength(value: string): number;
```

**Example:**

```ts
console.log(dataLength("0xdeadbeef")); // → 4
console.log(dataLength("0x")); // → 0
```

---

### `dataSlice(hex, start, end?)`

Slice by byte offsets — like `Uint8Array.subarray` but for hex strings.

**Signature:**

```ts
function dataSlice(value: string, start: number, end?: number): string;
```

**Example:**

```ts
console.log(dataSlice("0xdeadbeef", 1)); // → "0xadbeef"
console.log(dataSlice("0xdeadbeef", 1, 3)); // → "0xadbe"
```

---

## Addresses (`Address`)

```ts
import { Address } from "pyde-ts-sdk";
```

Object namespace — every method is a pure function.

### `Address.zero()`

The 32-byte zero address.

**Signature:**

```ts
Address.zero(): string
```

**Returns:** `string` — `0x` + 64 zeros.

**Example:**

```ts
console.log(Address.zero());
// → "0x0000000000000000000000000000000000000000000000000000000000000000"
```

Useful as the `to` field for envelope-style txs (Deploy, RegisterPubkey, Stake\*, Multisig, etc.).

---

### `Address.isZero(addr)`

Check whether all bytes are zero.

**Signature:**

```ts
Address.isZero(addr: string): boolean
```

**Example:**

```ts
console.log(Address.isZero("0x" + "00".repeat(32))); // → true
console.log(Address.isZero("0x0000000000000000000000000000000000000000000000000000000000000001")); // → false
```

---

### `Address.isValid(addr)`

Validate the shape: 32 bytes, valid hex chars.

**Signature:**

```ts
Address.isValid(addr: string): boolean
```

**Example:**

```ts
console.log(Address.isValid("0x" + "ab".repeat(32))); // → true
console.log(Address.isValid("0xabc")); // → false (too short)
console.log(Address.isValid("0xZZ" + "ab".repeat(31))); // → false (non-hex)
```

---

### `Address.equals(a, b)`

Case-insensitive comparison.

**Signature:**

```ts
Address.equals(a: string, b: string): boolean
```

**Example:**

```ts
const a = "0xABCDEF" + "00".repeat(29);
const b = "0xabcdef" + "00".repeat(29);
console.log(Address.equals(a, b)); // → true
```

---

### `Address.isValidPrivateKey(hex)`

Check a combined FALCON-512 (pk + sk) hex blob — 2,178 bytes total (897 + 1281).

**Signature:**

```ts
Address.isValidPrivateKey(hex: string): boolean
```

**Example:**

```ts
console.log(Address.isValidPrivateKey("0x" + "00".repeat(2178))); // → true (right length)
console.log(Address.isValidPrivateKey("0x" + "00".repeat(1024))); // → false (wrong length)
```

---

## Encoding constants — handy reference

Useful when working at the wire level.

| Constant                        | Value                         | What it is                                       |
| ------------------------------- | ----------------------------- | ------------------------------------------------ |
| **Zero address**                | `0x` + `00` × 32              | Used as `to` for envelope-style txs.             |
| **Decimals per PYDE**           | `9`                           | 1 PYDE = 10⁹ quanta.                             |
| **FALCON-512 pubkey size**      | 897 bytes (1,794 hex chars)   | The on-chain public key length.                  |
| **FALCON-512 secret key size**  | 1,281 bytes (2,562 hex chars) | The full private key.                            |
| **FALCON-512 signature size**   | ~666 bytes (compact-encoded)  | Variable; 690 is the max.                        |
| **Poseidon2 hash output**       | 32 bytes                      | Address derivation + state root (Poseidon2 leg). |
| **Blake3 hash output**          | 32 bytes                      | State root (Blake3 leg) + general digests.       |
| **Commit bond floor**           | 1 PYDE (10⁹ quanta)           | `MIN_COMMIT_BOND` — commit-reveal private-tx bond floor. |
| **Address byte length**         | 32                            | All Pyde addresses.                              |
| **Nonce window size**           | 16                            | Concurrent unconfirmed txs per sender.           |
| **Min tx gas**                  | 21,000                        | Structural validator floor (`MIN_GAS_LIMIT`).    |
| **Max tx size**                 | 128 KB                        | Structural validator cap (`MAX_TX_SIZE`).        |
| **Max calldata size**           | 64 KB                         | Structural validator cap (`MAX_CALLDATA`).       |
| **Max logs span per `getLogs`** | 5,000 waves                   | HOST_FN_ABI §15.4 cap.                           |

### Why these matter

- **`MIN_GAS_LIMIT = 21,000`** — any tx with `gas_limit < 21000` is rejected pre-mempool with `structural invalid`.
- **Decimals per PYDE = 9** — don't reuse `ethers.formatEther` (18 decimals) for PYDE balances. Use `formatQuanta`.
- **Address byte length = 32** — Pyde addresses are full Poseidon2 hashes (no truncation, no checksum). Twice the byte width of Ethereum's 20-byte addresses.
- **Nonce window = 16** — up to 16 unconfirmed txs in flight from one sender. The 17th rejects.

---

## Gotchas

- **PYDE has 9 decimals, not 18.** Don't reuse `ethers.formatEther` — wrong decimal count.
- **`parseQuanta("1")` is 1 _PYDE_, not 1 _quanta_.** Use `1n` directly for one quanta.
- **`Number(quanta)` loses precision above 2⁵³.** Format via `formatQuanta` instead of pre-converting to `Number`.
- **Addresses are case-insensitive on chain** but display in lower-case by convention. `Address.equals` normalises both sides.
- **`isHexString(x, 32)` checks 32 bytes (64 hex chars).** Some other libraries take `length` as char count — different convention.
- **`hexlify(0)` returns `"0x"` not `"0x00"`.** Use `toBeHex(0, 1)` for the zero-padded form.
- **`getBytes` accepts both hex strings and `Uint8Array`** — useful for normalising input from mixed sources.
