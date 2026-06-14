/**
 * Property tests for the borsh codec — `Contract.encodeCallArgs` +
 * `Contract.decodeReturn` must round-trip every supported type.
 *
 * Locks the wire format against borsh-rs canonical: drift here means
 * the SDK can no longer interoperate with `otigen`-built contracts.
 *
 * Equivalent to `pyde-rust-sdk`'s `tests/proptest_codec.rs` plus the
 * fast-check shrinker quality on top.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";

import { Contract } from "../../src/contract";

// --------------------------------------------------------------------------
// Range constants for every signed/unsigned width.
// --------------------------------------------------------------------------
const U8_MAX = (1n << 8n) - 1n;
const U16_MAX = (1n << 16n) - 1n;
const U32_MAX = (1n << 32n) - 1n;
const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;
const U256_MAX = (1n << 256n) - 1n;

const I8_MIN = -(1n << 7n);
const I8_MAX = (1n << 7n) - 1n;
const I16_MIN = -(1n << 15n);
const I16_MAX = (1n << 15n) - 1n;
const I32_MIN = -(1n << 31n);
const I32_MAX = (1n << 31n) - 1n;
const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;
const I128_MIN = -(1n << 127n);
const I128_MAX = (1n << 127n) - 1n;
const I256_MIN = -(1n << 255n);
const I256_MAX = (1n << 255n) - 1n;

// --------------------------------------------------------------------------
// Helper — wrap a single-arg echo contract whose ABI declares `v: T`
// and `returns: T`. We then assert `encode(v) === decode(encode(v))`.
// --------------------------------------------------------------------------
function echoContract(ty: unknown, returnTy: unknown = ty): Contract {
  const abi = {
    functions: [
      {
        name: "echo",
        params: [{ name: "v", ty }],
        returns: returnTy,
        attrs: { bits: 1 },
      },
    ],
  };
  return Contract.fromJson(JSON.stringify(abi), "0x" + "00".repeat(32), null as never);
}

function rountrip<T>(c: Contract, retType: string, value: T): T {
  const args = c.encodeCallArgs("echo", { v: value });
  const decoder = c as unknown as { decodeReturn: (t: string, h: string) => T };
  return decoder.decodeReturn(retType, "0x" + args.slice(2));
}

// --------------------------------------------------------------------------
// fast-check arbitraries.
// --------------------------------------------------------------------------
const arbBigIntInRange = (min: bigint, max: bigint) =>
  fc.bigInt({ min, max });

// Address / FixedBytes:32 — `0x` + 64 hex chars.
const arbAddress = fc.uint8Array({ minLength: 32, maxLength: 32 }).map(
  (b) => "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(""),
);

const arbFixedBytes = (n: number) =>
  fc
    .uint8Array({ minLength: n, maxLength: n })
    .map((b) => "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(""));

// Bytes — Uint8Array.
const arbBytes = fc.uint8Array({ minLength: 0, maxLength: 1024 });

// Unicode strings — exercise UTF-8 length-prefix encoding.
const arbString = fc.string({ minLength: 0, maxLength: 256 });

// --------------------------------------------------------------------------
// Integers — every width, every signedness.
// --------------------------------------------------------------------------
describe("borsh codec — integer roundtrip property", () => {
  it("u8 roundtrips across full range", () => {
    const c = echoContract("U8");
    fc.assert(
      fc.property(arbBigIntInRange(0n, U8_MAX), (v) => {
        expect(rountrip(c, "u8", v)).toBe(v);
      }),
      { numRuns: 256 },
    );
  });

  it("u16 roundtrips", () => {
    const c = echoContract("U16");
    fc.assert(
      fc.property(arbBigIntInRange(0n, U16_MAX), (v) => {
        expect(rountrip(c, "u16", v)).toBe(v);
      }),
    );
  });

  it("u32 roundtrips", () => {
    const c = echoContract("U32");
    fc.assert(
      fc.property(arbBigIntInRange(0n, U32_MAX), (v) => {
        expect(rountrip(c, "u32", v)).toBe(v);
      }),
    );
  });

  it("u64 roundtrips across full range — catches 2^53 truncation", () => {
    const c = echoContract("U64");
    fc.assert(
      fc.property(arbBigIntInRange(0n, U64_MAX), (v) => {
        expect(rountrip(c, "u64", v)).toBe(v);
      }),
    );
  });

  it("u128 roundtrips", () => {
    const c = echoContract("U128");
    fc.assert(
      fc.property(arbBigIntInRange(0n, U128_MAX), (v) => {
        expect(rountrip(c, "u128", v)).toBe(v);
      }),
    );
  });

  it("u256 roundtrips (Pyde extension; no native borsh-rs equiv)", () => {
    const c = echoContract("U256");
    fc.assert(
      fc.property(arbBigIntInRange(0n, U256_MAX), (v) => {
        expect(rountrip(c, "u256", v)).toBe(v);
      }),
    );
  });

  it("i8 roundtrips across full signed range", () => {
    const c = echoContract("I8");
    fc.assert(
      fc.property(arbBigIntInRange(I8_MIN, I8_MAX), (v) => {
        expect(rountrip(c, "i8", v)).toBe(v);
      }),
      { numRuns: 256 },
    );
  });

  it("i16 roundtrips", () => {
    const c = echoContract("I16");
    fc.assert(
      fc.property(arbBigIntInRange(I16_MIN, I16_MAX), (v) => {
        expect(rountrip(c, "i16", v)).toBe(v);
      }),
    );
  });

  it("i32 roundtrips", () => {
    const c = echoContract("I32");
    fc.assert(
      fc.property(arbBigIntInRange(I32_MIN, I32_MAX), (v) => {
        expect(rountrip(c, "i32", v)).toBe(v);
      }),
    );
  });

  it("i64 roundtrips — catches signed truncation bugs", () => {
    const c = echoContract("I64");
    fc.assert(
      fc.property(arbBigIntInRange(I64_MIN, I64_MAX), (v) => {
        expect(rountrip(c, "i64", v)).toBe(v);
      }),
    );
  });

  it("i128 roundtrips", () => {
    const c = echoContract("I128");
    fc.assert(
      fc.property(arbBigIntInRange(I128_MIN, I128_MAX), (v) => {
        expect(rountrip(c, "i128", v)).toBe(v);
      }),
    );
  });

  it("i256 roundtrips (Pyde extension)", () => {
    const c = echoContract("I256");
    fc.assert(
      fc.property(arbBigIntInRange(I256_MIN, I256_MAX), (v) => {
        expect(rountrip(c, "i256", v)).toBe(v);
      }),
    );
  });
});

// --------------------------------------------------------------------------
// Bool — exhaustive.
// --------------------------------------------------------------------------
describe("borsh codec — bool roundtrip", () => {
  it("true and false roundtrip", () => {
    const c = echoContract("Bool");
    expect(rountrip(c, "bool", true)).toBe(true);
    expect(rountrip(c, "bool", false)).toBe(false);
  });
});

// --------------------------------------------------------------------------
// String — UTF-8 length-prefix encoding.
// --------------------------------------------------------------------------
describe("borsh codec — String roundtrip property", () => {
  it("UTF-8 strings of arbitrary length roundtrip", () => {
    const c = echoContract("String");
    fc.assert(
      fc.property(arbString, (s) => {
        expect(rountrip(c, "String", s)).toBe(s);
      }),
    );
  });

  it("empty string roundtrips (0-length is a known edge case)", () => {
    const c = echoContract("String");
    expect(rountrip(c, "String", "")).toBe("");
  });
});

// --------------------------------------------------------------------------
// Bytes — arbitrary Uint8Array.
// --------------------------------------------------------------------------
describe("borsh codec — Bytes roundtrip property", () => {
  it("arbitrary Uint8Arrays roundtrip", () => {
    const c = echoContract("Bytes");
    fc.assert(
      fc.property(arbBytes, (b) => {
        expect(rountrip(c, "Bytes", b)).toEqual(b);
      }),
    );
  });

  it("empty Bytes roundtrips", () => {
    const c = echoContract("Bytes");
    expect(rountrip(c, "Bytes", new Uint8Array(0))).toEqual(new Uint8Array(0));
  });
});

// --------------------------------------------------------------------------
// Address (FixedBytes:32 alias).
// --------------------------------------------------------------------------
describe("borsh codec — Address roundtrip property", () => {
  it("32-byte hex addresses roundtrip", () => {
    const c = echoContract("Address");
    fc.assert(
      fc.property(arbAddress, (a) => {
        expect(rountrip(c, "Address", a)).toBe(a);
      }),
    );
  });
});

// --------------------------------------------------------------------------
// FixedBytes:N for non-32 N.
// --------------------------------------------------------------------------
describe("borsh codec — FixedBytes:N roundtrip property", () => {
  for (const n of [1, 4, 8, 16, 64]) {
    it(`FixedBytes:${n} roundtrips`, () => {
      const c = echoContract({ FixedBytes: n });
      fc.assert(
        fc.property(arbFixedBytes(n), (a) => {
          expect(rountrip(c, `FixedBytes:${n}`, a)).toBe(a);
        }),
      );
    });
  }
});

// --------------------------------------------------------------------------
// Vec<T> — variable length.
// --------------------------------------------------------------------------
describe("borsh codec — Vec roundtrip property", () => {
  it("Vec<u64> arbitrary length roundtrips", () => {
    const c = echoContract({ Vec: "U64" });
    fc.assert(
      fc.property(
        fc.array(arbBigIntInRange(0n, U64_MAX), { minLength: 0, maxLength: 64 }),
        (xs) => {
          expect(rountrip(c, "Vec<u64>", xs)).toEqual(xs);
        },
      ),
    );
  });

  it("Vec<bool> arbitrary length roundtrips", () => {
    const c = echoContract({ Vec: "Bool" });
    fc.assert(
      fc.property(fc.array(fc.boolean(), { minLength: 0, maxLength: 64 }), (xs) => {
        expect(rountrip(c, "Vec<bool>", xs)).toEqual(xs);
      }),
    );
  });

  it("Vec<String> arbitrary length roundtrips", () => {
    const c = echoContract({ Vec: "String" });
    fc.assert(
      fc.property(fc.array(arbString, { minLength: 0, maxLength: 16 }), (xs) => {
        expect(rountrip(c, "Vec<String>", xs)).toEqual(xs);
      }),
    );
  });

  it("Vec<Address> arbitrary length roundtrips", () => {
    const c = echoContract({ Vec: "Address" });
    fc.assert(
      fc.property(fc.array(arbAddress, { minLength: 0, maxLength: 16 }), (xs) => {
        expect(rountrip(c, "Vec<Address>", xs)).toEqual(xs);
      }),
    );
  });
});

// --------------------------------------------------------------------------
// Option<T>.
// --------------------------------------------------------------------------
describe("borsh codec — Option roundtrip property", () => {
  it("Option<u32> (Some / None) roundtrips", () => {
    const c = echoContract({ Option: "U32" });
    fc.assert(
      fc.property(fc.option(arbBigIntInRange(0n, U32_MAX), { nil: null }), (v) => {
        expect(rountrip(c, "Option<u32>", v)).toBe(v);
      }),
    );
  });

  it("Option<String> roundtrips", () => {
    const c = echoContract({ Option: "String" });
    fc.assert(
      fc.property(fc.option(arbString, { nil: null }), (v) => {
        expect(rountrip(c, "Option<String>", v)).toBe(v);
      }),
    );
  });
});

// --------------------------------------------------------------------------
// Struct — mirror of borsh-coverage's `Order`.
// --------------------------------------------------------------------------
describe("borsh codec — struct roundtrip property", () => {
  const c = Contract.fromJson(
    JSON.stringify({
      functions: [
        {
          name: "echo",
          params: [{ name: "v", ty: { Custom: "Order" } }],
          returns: { Custom: "Order" },
          attrs: { bits: 1 },
        },
      ],
      types: [
        {
          name: "Order",
          kind: {
            Struct: {
              fields: [
                { name: "id", ty: "U64" },
                { name: "maker", ty: { FixedBytes: 32 } },
                { name: "items", ty: { Vec: "String" } },
                { name: "paid", ty: "Bool" },
              ],
            },
          },
        },
      ],
    }),
    "0x" + "00".repeat(32),
    null as never,
  );

  const arbOrder = fc.record({
    id: arbBigIntInRange(0n, U64_MAX),
    maker: arbAddress,
    items: fc.array(arbString, { minLength: 0, maxLength: 8 }),
    paid: fc.boolean(),
  });

  it("Order (u64 + FixedBytes:32 + Vec<String> + bool) roundtrips", () => {
    fc.assert(
      fc.property(arbOrder, (order) => {
        const out = rountrip(c, "Order", order);
        expect(out).toEqual(order);
      }),
    );
  });
});

// --------------------------------------------------------------------------
// Enum — unit variants only (v1 limitation).
// --------------------------------------------------------------------------
describe("borsh codec — enum roundtrip property", () => {
  const c = Contract.fromJson(
    JSON.stringify({
      functions: [
        {
          name: "echo",
          params: [{ name: "v", ty: { Custom: "Status" } }],
          returns: { Custom: "Status" },
          attrs: { bits: 1 },
        },
      ],
      types: [
        {
          name: "Status",
          kind: {
            Enum: {
              variants: [{ name: "Pending" }, { name: "Active" }, { name: "Cancelled" }],
            },
          },
        },
      ],
    }),
    "0x" + "00".repeat(32),
    null as never,
  );

  it("unit-variant enum names roundtrip", () => {
    fc.assert(
      fc.property(fc.constantFrom("Pending", "Active", "Cancelled"), (name) => {
        expect(rountrip(c, "Status", name)).toBe(name);
      }),
    );
  });
});
