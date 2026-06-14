/**
 * Borsh codec roundtrip tests for Contract.encodeCall / decodeReturn.
 *
 * Locks the SDK's wire format against the borsh-rs canonical spec —
 * matches what the chain's `#[pyde::entry]` macro decodes via
 * `borsh::BorshDeserialize::try_from_slice`. If these tests break, the
 * SDK can no longer interoperate with `otigen`-built contracts.
 */
import { describe, it, expect } from "vitest";
import { Contract } from "./contract";

// Helper — build a Contract whose ABI registers structs/enums for the
// codec to consult. No provider is needed for encode/decode roundtrips.
function makeContract(abi: object): Contract {
  return Contract.fromJson(JSON.stringify(abi), "0x" + "00".repeat(32), null as never);
}

describe("borsh codec — primitives roundtrip", () => {
  const abi = {
    functions: [
      { name: "echo_u8", params: [{ name: "v", ty: "U8" }], returns: "U8", attrs: { bits: 1 } },
      { name: "echo_u16", params: [{ name: "v", ty: "U16" }], returns: "U16", attrs: { bits: 1 } },
      { name: "echo_u32", params: [{ name: "v", ty: "U32" }], returns: "U32", attrs: { bits: 1 } },
      { name: "echo_u64", params: [{ name: "v", ty: "U64" }], returns: "U64", attrs: { bits: 1 } },
      {
        name: "echo_u128",
        params: [{ name: "v", ty: "U128" }],
        returns: "U128",
        attrs: { bits: 1 },
      },
      {
        name: "echo_u256",
        params: [{ name: "v", ty: "U256" }],
        returns: "U256",
        attrs: { bits: 1 },
      },
      { name: "echo_i8", params: [{ name: "v", ty: "I8" }], returns: "I8", attrs: { bits: 1 } },
      { name: "echo_i64", params: [{ name: "v", ty: "I64" }], returns: "I64", attrs: { bits: 1 } },
      {
        name: "echo_bool",
        params: [{ name: "v", ty: "Bool" }],
        returns: "Bool",
        attrs: { bits: 1 },
      },
    ],
  };
  const c = makeContract(abi);

  // The encoder pushes selector(4) + value bytes. Strip the selector
  // before re-running through decodeReturn.
  function roundtrip(method: string, retType: string, value: unknown): unknown {
    const calldataHex = c.encodeCallArgs(method, { v: value });
    const valueHex = "0x" + calldataHex.slice(2);
    return (c as unknown as { decodeReturn: (t: string, h: string) => unknown }).decodeReturn(
      retType,
      valueHex,
    );
  }

  it("u8 → 1 byte", () => {
    expect(c.encodeCallArgs("echo_u8", { v: 42 }).slice(2)).toBe("2a");
    expect(roundtrip("echo_u8", "u8", 42)).toBe(42n);
  });

  it("u16 → 2 bytes LE", () => {
    expect(c.encodeCallArgs("echo_u16", { v: 0x1234 }).slice(2)).toBe("3412");
    expect(roundtrip("echo_u16", "u16", 0x1234)).toBe(0x1234n);
  });

  it("u32 → 4 bytes LE", () => {
    expect(c.encodeCallArgs("echo_u32", { v: 0xdeadbeef }).slice(2)).toBe("efbeadde");
    expect(roundtrip("echo_u32", "u32", 0xdeadbeef)).toBe(0xdeadbeefn);
  });

  it("u64 → 8 bytes LE", () => {
    expect(c.encodeCallArgs("echo_u64", { v: 1n }).slice(2)).toBe("0100000000000000");
    expect(roundtrip("echo_u64", "u64", 42n)).toBe(42n);
  });

  it("u128 → 16 bytes LE", () => {
    expect(roundtrip("echo_u128", "u128", 1n << 100n)).toBe(1n << 100n);
  });

  it("u256 → 32 bytes LE", () => {
    expect(roundtrip("echo_u256", "u256", 1n << 200n)).toBe(1n << 200n);
  });

  it("i8 negative → two's complement 1 byte", () => {
    expect(c.encodeCallArgs("echo_i8", { v: -1 }).slice(2)).toBe("ff");
    expect(roundtrip("echo_i8", "i8", -1)).toBe(-1n);
    expect(roundtrip("echo_i8", "i8", -128)).toBe(-128n);
  });

  it("i64 negative → two's complement 8 bytes", () => {
    expect(roundtrip("echo_i64", "i64", -1n)).toBe(-1n);
  });

  it("bool → 1 byte 0/1", () => {
    expect(c.encodeCallArgs("echo_bool", { v: true }).slice(2)).toBe("01");
    expect(c.encodeCallArgs("echo_bool", { v: false }).slice(2)).toBe("00");
    expect(roundtrip("echo_bool", "bool", true)).toBe(true);
    expect(roundtrip("echo_bool", "bool", false)).toBe(false);
  });
});

describe("borsh codec — String / Bytes / Vec / Option", () => {
  const abi = {
    functions: [
      {
        name: "echo_string",
        params: [{ name: "s", ty: "String" }],
        returns: "String",
        attrs: { bits: 1 },
      },
      {
        name: "echo_bytes",
        params: [{ name: "b", ty: "Bytes" }],
        returns: "Bytes",
        attrs: { bits: 1 },
      },
      {
        name: "echo_vec_u64",
        params: [{ name: "v", ty: { Vec: "U64" } }],
        returns: { Vec: "U64" },
        attrs: { bits: 1 },
      },
      {
        name: "echo_opt_u32",
        params: [{ name: "v", ty: { Option: "U32" } }],
        returns: { Option: "U32" },
        attrs: { bits: 1 },
      },
    ],
  };
  const c = makeContract(abi);

  function roundtrip(method: string, paramName: string, retType: string, value: unknown): unknown {
    const calldataHex = c.encodeCallArgs(method, { [paramName]: value });
    const valueHex = "0x" + calldataHex.slice(2);
    return (c as unknown as { decodeReturn: (t: string, h: string) => unknown }).decodeReturn(
      retType,
      valueHex,
    );
  }

  it("String: 4-byte LE length + UTF-8 bytes (no padding)", () => {
    // "hi" = 0x68 0x69. Length = 2. Borsh: 02 00 00 00 68 69.
    expect(c.encodeCallArgs("echo_string", { s: "hi" }).slice(2)).toBe("020000006869");
    expect(roundtrip("echo_string", "s", "String", "hello")).toBe("hello");
  });

  it("String: UTF-8 multi-byte chars", () => {
    expect(roundtrip("echo_string", "s", "String", "héllo")).toBe("héllo");
  });

  it("Bytes: 4-byte LE length + raw bytes", () => {
    const b = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    expect(c.encodeCallArgs("echo_bytes", { b }).slice(2)).toBe("04000000deadbeef");
    expect(roundtrip("echo_bytes", "b", "Bytes", b)).toEqual(b);
  });

  it("Bytes: empty", () => {
    expect(c.encodeCallArgs("echo_bytes", { b: new Uint8Array(0) }).slice(2)).toBe("00000000");
  });

  it("Vec<u64>: 4-byte LE count + items", () => {
    // [1, 2, 3]: count=3 (03 00 00 00), then 3x u64 LE.
    const expected = "03000000" + "0100000000000000" + "0200000000000000" + "0300000000000000";
    expect(c.encodeCallArgs("echo_vec_u64", { v: [1n, 2n, 3n] }).slice(2)).toBe(expected);
    expect(roundtrip("echo_vec_u64", "v", "Vec<u64>", [1n, 2n, 3n])).toEqual([1n, 2n, 3n]);
  });

  it("Option<u32>: None = 1 byte (00)", () => {
    expect(c.encodeCallArgs("echo_opt_u32", { v: null }).slice(2)).toBe("00");
    expect(roundtrip("echo_opt_u32", "v", "Option<u32>", null)).toBe(null);
  });

  it("Option<u32>: Some(42) = 01 + 4-byte u32 LE", () => {
    expect(c.encodeCallArgs("echo_opt_u32", { v: 42 }).slice(2)).toBe("01" + "2a000000");
    expect(roundtrip("echo_opt_u32", "v", "Option<u32>", 42)).toBe(42n);
  });
});

describe("borsh codec — struct + enum + nested", () => {
  // Mirror of the borsh-coverage contract's `Order` struct + `Status`
  // enum, which is the canonical otigen example for complex types.
  const abi = {
    functions: [
      {
        name: "echo_order",
        params: [{ name: "o", ty: { Custom: "Order" } }],
        returns: { Custom: "Order" },
        attrs: { bits: 1 },
      },
      {
        name: "echo_status",
        params: [{ name: "s", ty: { Custom: "Status" } }],
        returns: { Custom: "Status" },
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
      {
        name: "Status",
        kind: {
          Enum: {
            variants: [{ name: "Pending" }, { name: "Active" }, { name: "Cancelled" }],
          },
        },
      },
    ],
  };
  const c = makeContract(abi);

  function roundtrip<T>(method: string, paramName: string, retType: string, value: T): T {
    const calldataHex = c.encodeCallArgs(method, { [paramName]: value });
    const valueHex = "0x" + calldataHex.slice(2);
    return (c as unknown as { decodeReturn: (t: string, h: string) => T }).decodeReturn(
      retType,
      valueHex,
    );
  }

  it("Struct: fields concatenated in declaration order, no header", () => {
    const order = {
      id: 42n,
      maker: "0x" + "ab".repeat(32),
      items: ["foo", "bar"],
      paid: true,
    };
    const result = roundtrip("echo_order", "o", "Order", order);
    expect(result).toEqual(order);
  });

  it("Struct: empty Vec field", () => {
    const order = {
      id: 0n,
      maker: "0x" + "00".repeat(32),
      items: [],
      paid: false,
    };
    expect(roundtrip("echo_order", "o", "Order", order)).toEqual(order);
  });

  it("Struct: Vec with many strings", () => {
    const order = {
      id: 0xdeadbeefn,
      maker: "0x" + "ff".repeat(32),
      items: ["one", "two", "three", "four", "five"],
      paid: true,
    };
    expect(roundtrip("echo_order", "o", "Order", order)).toEqual(order);
  });

  it("Enum: 1-byte variant index for unit variants", () => {
    expect(c.encodeCallArgs("echo_status", { s: "Pending" }).slice(2)).toBe("00");
    expect(c.encodeCallArgs("echo_status", { s: "Active" }).slice(2)).toBe("01");
    expect(c.encodeCallArgs("echo_status", { s: "Cancelled" }).slice(2)).toBe("02");
    expect(roundtrip("echo_status", "s", "Status", "Active")).toBe("Active");
  });

  it("Enum: unknown variant name throws", () => {
    expect(() => c.encodeCallArgs("echo_status", { s: "Unknown" })).toThrow(/unknown variant/);
  });
});

describe("borsh codec — multi-arg + CallPayload wrapping", () => {
  const abi = {
    functions: [
      {
        name: "two_args",
        params: [
          { name: "a", ty: "U64" },
          { name: "b", ty: "String" },
        ],
        returns: "Bytes",
        attrs: { bits: 1 },
      },
    ],
  };
  const c = makeContract(abi);

  it("multi-arg = concat of borsh-encoded args (no tuple header, no selector)", () => {
    const hex = c.encodeCallArgs("two_args", { a: 7n, b: "hi" });
    // u64(7) + String("hi") = 0700000000000000 02000000 6869
    expect(hex.slice(2)).toBe("0700000000000000" + "02000000" + "6869");
  });

  it("encodeCall wraps the args in a borsh CallPayload {function, calldata}", () => {
    const hex = c.encodeCall("two_args", { a: 7n, b: "hi" });
    // function: String("two_args") = 4-byte LE len + UTF-8
    const fnPart = "08000000" + "74776f5f6172677300".slice(0, 16); // 'two_args'
    const fnHex = Buffer.from("two_args", "utf-8").toString("hex");
    const argsHex = "0700000000000000" + "02000000" + "6869"; // 8+4+2 = 14 bytes
    const argsLen = (argsHex.length / 2).toString(16).padStart(2, "0").padStart(8, "0"); // u32 LE — only LSB nonzero here
    const cdLenLE = "0e000000"; // 14 in LE
    void fnPart;
    void argsLen;
    expect(hex).toBe(
      "0x" +
        "08000000" + // function name length = 8
        fnHex +
        cdLenLE +
        argsHex,
    );
  });
});
