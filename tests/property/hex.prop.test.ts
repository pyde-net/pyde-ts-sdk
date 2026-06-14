/**
 * Property + fuzz tests for src/hex.ts.
 *
 * Runs round-trip invariants across random Uint8Arrays, hex strings,
 * bigints, and integers. fast-check generates the test inputs and
 * automatically shrinks failures to a minimal repro.
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";

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
} from "../../src/hex";

// fast-check arbitraries we reuse across properties.
const byteArr = fc.uint8Array({ minLength: 0, maxLength: 256 });
const nonNegBigint = fc.bigInt({ min: 0n, max: 2n ** 256n - 1n });
const nonNegInt = fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER });

describe("hex — property tests", () => {
  it("getBytes(hexlify(b)) round-trips any Uint8Array", () => {
    fc.assert(
      fc.property(byteArr, (bytes) => {
        const hex = hexlify(bytes);
        const back = getBytes(hex);
        expect(Array.from(back)).toEqual(Array.from(bytes));
      }),
    );
  });

  it("hexlify is idempotent — hexlify(hexlify(x)) === hexlify(x)", () => {
    fc.assert(
      fc.property(byteArr, (bytes) => {
        const once = hexlify(bytes);
        const twice = hexlify(once);
        expect(twice).toBe(once);
      }),
    );
  });

  it("hexlify always produces a 0x-prefixed lowercase hex string", () => {
    fc.assert(
      fc.property(byteArr, (bytes) => {
        const hex = hexlify(bytes);
        expect(hex.startsWith("0x")).toBe(true);
        expect(hex.slice(2)).toMatch(/^[0-9a-f]*$/);
      }),
    );
  });

  it("isHexString accepts everything hexlify emits", () => {
    fc.assert(
      fc.property(byteArr, (bytes) => {
        expect(isHexString(hexlify(bytes))).toBe(true);
      }),
    );
  });

  it("dataLength(hexlify(b)) equals b.length", () => {
    fc.assert(
      fc.property(byteArr, (bytes) => {
        expect(dataLength(hexlify(bytes))).toBe(bytes.length);
      }),
    );
  });

  it("concat([a, b]) === concat([hexlify(a), hexlify(b)])", () => {
    fc.assert(
      fc.property(byteArr, byteArr, (a, b) => {
        const fromBytes = concat([a, b]);
        const fromHex = concat([hexlify(a), hexlify(b)]);
        expect(fromBytes).toBe(fromHex);
      }),
    );
  });

  it("concat distributes over getBytes", () => {
    fc.assert(
      fc.property(byteArr, byteArr, (a, b) => {
        const joined = concat([a, b]);
        const back = getBytes(joined);
        const expected = new Uint8Array([...a, ...b]);
        expect(Array.from(back)).toEqual(Array.from(expected));
      }),
    );
  });

  it("zeroPadValue produces the requested length", () => {
    fc.assert(
      fc.property(
        byteArr.filter((b) => b.length <= 64),
        fc.integer({ min: 0, max: 64 }),
        (bytes, target) => {
          if (bytes.length > target) return; // pre-condition the helper checks itself
          const padded = zeroPadValue(bytes, target);
          expect(dataLength(padded)).toBe(target);
          // tail should equal original bytes
          const tail = getBytes(padded).subarray(target - bytes.length);
          expect(Array.from(tail)).toEqual(Array.from(bytes));
        },
      ),
    );
  });

  it("stripZeros + zeroPadValue round-trip preserves any non-zero-tail bytes", () => {
    fc.assert(
      fc.property(
        byteArr.filter((b) => b.length > 0 && b[b.length - 1] !== 0),
        (bytes) => {
          const stripped = stripZeros(bytes);
          // strip + pad to original length restores the original bytes
          const padded = zeroPadValue(stripped, bytes.length);
          // First non-zero byte index in the original should equal the
          // offset where the stripped version starts.
          const firstNonZero = bytes.findIndex((b) => b !== 0);
          const restored = getBytes(padded);
          expect(Array.from(restored)).toEqual(
            Array.from(
              new Uint8Array([...new Uint8Array(firstNonZero), ...bytes.subarray(firstNonZero)]),
            ),
          );
        },
      ),
    );
  });

  it("toBeHex(n, w) for w > byte length of n is left-zero-padded", () => {
    fc.assert(
      fc.property(nonNegBigint, fc.integer({ min: 32, max: 64 }), (n, width) => {
        const hex = toBeHex(n, width);
        expect(dataLength(hex)).toBe(width);
        expect(BigInt(hex)).toBe(n);
      }),
    );
  });

  it("hexlify(number) === hexlify(BigInt(number)) for safe integers", () => {
    fc.assert(
      fc.property(nonNegInt, (n) => {
        expect(hexlify(n)).toBe(hexlify(BigInt(n)));
      }),
    );
  });

  it("dataSlice respects byte boundaries", () => {
    fc.assert(
      fc.property(
        byteArr.filter((b) => b.length >= 4),
        (bytes) => {
          const hex = hexlify(bytes);
          const sliced = dataSlice(hex, 1, 3);
          const expected = "0x" + hexlify(bytes.subarray(1, 3)).slice(2);
          expect(sliced).toBe(expected);
        },
      ),
    );
  });
});
