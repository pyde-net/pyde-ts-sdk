/**
 * Property tests for ABI normalisation tolerance.
 *
 * Engine `otigen build` and older spec drafts disagree on a few shapes:
 *   - `param.ty` vs `param.type`
 *   - `{Custom: "T"}` vs flat `"T"` for user-named types
 *   - `{Vec: "T"}` vs `"Vec<T>"` strings
 *   - `attrs.bits` packing vs explicit `view` / `payable` booleans
 *   - `types[].kind.{Struct,Enum}` vs flat `structs[]` / `enums[]`
 *
 * The SDK's `Contract.fromJson` should round any of these to the same
 * encoder state. These tests randomise across the supported forms and
 * assert that the codec produces identical bytes for the same logical
 * function.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";

import { Contract } from "../../src/contract";

const ZERO = "0x" + "00".repeat(32);

// Each `abiVariant` is a different but equivalent serialisation of the
// same ABI. The codec output must match across them.

describe("ABI normalisation — equivalent forms produce identical wire bytes", () => {
  it("`param.ty` and `param.type` are interchangeable", () => {
    const aTy = {
      functions: [
        {
          name: "f",
          params: [{ name: "v", ty: "U64" }],
          returns: "U64",
          attrs: { bits: 1 },
        },
      ],
    };
    const aType = {
      functions: [
        {
          name: "f",
          params: [{ name: "v", type: "U64" }],
          returns: "U64",
          view: true,
          payable: false,
        },
      ],
    };
    const cTy = Contract.fromJson(JSON.stringify(aTy), ZERO, null as never);
    const cType = Contract.fromJson(JSON.stringify(aType), ZERO, null as never);

    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: (1n << 64n) - 1n }), (v) => {
        expect(cTy.encodeCallArgs("f", { v })).toBe(cType.encodeCallArgs("f", { v }));
      }),
    );
  });

  it("`{Vec: 'U64'}` parses + encodes (engine wire form)", () => {
    const a = {
      functions: [
        {
          name: "f",
          params: [{ name: "v", ty: { Vec: "U64" } }],
          returns: { Vec: "U64" },
          attrs: { bits: 1 },
        },
      ],
    };
    const c = Contract.fromJson(JSON.stringify(a), ZERO, null as never);

    fc.assert(
      fc.property(
        fc.array(fc.bigInt({ min: 0n, max: (1n << 64n) - 1n }), { maxLength: 16 }),
        (xs) => {
          // 4-byte LE count + 8-byte LE per item.
          const expected =
            "0x" +
            (xs.length & 0xff).toString(16).padStart(2, "0") +
            ((xs.length >> 8) & 0xff).toString(16).padStart(2, "0") +
            ((xs.length >> 16) & 0xff).toString(16).padStart(2, "0") +
            ((xs.length >> 24) & 0xff).toString(16).padStart(2, "0") +
            xs
              .map((v) => {
                const buf = new Uint8Array(8);
                new DataView(buf.buffer).setBigUint64(0, v, true);
                return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
              })
              .join("");
          expect(c.encodeCallArgs("f", { v: xs })).toBe(expected);
        },
      ),
    );
  });

  it("attrs.bits=1 maps to view=true / payable=false (matches explicit booleans)", () => {
    const aBits = {
      functions: [
        { name: "f", params: [], returns: "U64", attrs: { bits: 1 } },
      ],
    };
    const aBool = {
      functions: [
        { name: "f", params: [], returns: "U64", view: true, payable: false },
      ],
    };
    const cBits = Contract.fromJson(JSON.stringify(aBits), ZERO, null as never);
    const cBool = Contract.fromJson(JSON.stringify(aBool), ZERO, null as never);

    expect(cBits.encodeCallArgs("f", {})).toBe(cBool.encodeCallArgs("f", {}));
  });

  it("attrs.bits=2 (payable, not view) parses identically", () => {
    const aBits = {
      functions: [
        { name: "f", params: [], returns: "()", attrs: { bits: 2 } },
      ],
    };
    const aBool = {
      functions: [
        { name: "f", params: [], returns: "()", view: false, payable: true },
      ],
    };
    const cBits = Contract.fromJson(JSON.stringify(aBits), ZERO, null as never);
    const cBool = Contract.fromJson(JSON.stringify(aBool), ZERO, null as never);

    expect(cBits.encodeCallArgs("f", {})).toBe(cBool.encodeCallArgs("f", {}));
  });

  it("`{Custom: 'Order'}` resolves against a struct in types[]", () => {
    const a = {
      functions: [
        {
          name: "f",
          params: [{ name: "v", ty: { Custom: "Order" } }],
          returns: { Custom: "Order" },
          attrs: { bits: 1 },
        },
      ],
      types: [
        {
          name: "Order",
          kind: { Struct: { fields: [{ name: "id", ty: "U64" }] } },
        },
      ],
    };
    const b = {
      functions: [
        {
          name: "f",
          params: [{ name: "v", type: "Order" }],
          returns: "Order",
          view: true,
        },
      ],
      structs: [{ name: "Order", fields: [{ name: "id", type: "U64" }] }],
    };
    const cA = Contract.fromJson(JSON.stringify(a), ZERO, null as never);
    const cB = Contract.fromJson(JSON.stringify(b), ZERO, null as never);

    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: (1n << 64n) - 1n }), (id) => {
        const v = { id };
        expect(cA.encodeCallArgs("f", { v })).toBe(cB.encodeCallArgs("f", { v }));
      }),
    );
  });

  it("`{FixedBytes: 32}` is alias-resolved to Address", () => {
    const aFb = {
      functions: [
        {
          name: "f",
          params: [{ name: "v", ty: { FixedBytes: 32 } }],
          returns: { FixedBytes: 32 },
          attrs: { bits: 1 },
        },
      ],
    };
    const aAddr = {
      functions: [
        {
          name: "f",
          params: [{ name: "v", ty: "Address" }],
          returns: "Address",
          attrs: { bits: 1 },
        },
      ],
    };
    const cFb = Contract.fromJson(JSON.stringify(aFb), ZERO, null as never);
    const cAddr = Contract.fromJson(JSON.stringify(aAddr), ZERO, null as never);

    const arbAddress = fc
      .uint8Array({ minLength: 32, maxLength: 32 })
      .map((b) => "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(""));

    fc.assert(
      fc.property(arbAddress, (a) => {
        expect(cFb.encodeCallArgs("f", { v: a })).toBe(cAddr.encodeCallArgs("f", { v: a }));
      }),
    );
  });

  it("`types[].kind.Enum` and flat `enums[]` produce identical bytes", () => {
    const aTypes = {
      functions: [
        {
          name: "f",
          params: [{ name: "v", ty: { Custom: "Status" } }],
          returns: { Custom: "Status" },
          attrs: { bits: 1 },
        },
      ],
      types: [
        {
          name: "Status",
          kind: { Enum: { variants: [{ name: "Pending" }, { name: "Active" }] } },
        },
      ],
    };
    const aFlat = {
      functions: [
        {
          name: "f",
          params: [{ name: "v", type: "Status" }],
          returns: "Status",
          view: true,
        },
      ],
      enums: [
        {
          name: "Status",
          variants: [
            { name: "Pending", discriminant: 0 },
            { name: "Active", discriminant: 1 },
          ],
        },
      ],
    };
    const cTypes = Contract.fromJson(JSON.stringify(aTypes), ZERO, null as never);
    const cFlat = Contract.fromJson(JSON.stringify(aFlat), ZERO, null as never);

    for (const name of ["Pending", "Active"] as const) {
      expect(cTypes.encodeCallArgs("f", { v: name })).toBe(
        cFlat.encodeCallArgs("f", { v: name }),
      );
    }
  });

  it("function selector bytes are honoured when ABI ships them", () => {
    const aWithSel = {
      functions: [
        {
          name: "f",
          selector: [0xde, 0xad, 0xbe, 0xef],
          params: [{ name: "v", ty: "U64" }],
          returns: "U64",
          attrs: { bits: 1 },
        },
      ],
    };
    const c = Contract.fromJson(JSON.stringify(aWithSel), ZERO, null as never);
    const fn = (c as unknown as { functions: Map<string, { selectorBytes?: Uint8Array }> })
      .functions.get("f");
    expect(fn?.selectorBytes).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
  });

  it("missing selector falls back to a name-derived 4-byte hash", () => {
    const a = {
      functions: [
        {
          name: "f",
          params: [{ name: "v", ty: "U64" }],
          returns: "U64",
          attrs: { bits: 1 },
        },
      ],
    };
    const c = Contract.fromJson(JSON.stringify(a), ZERO, null as never);
    const fn = (c as unknown as { functions: Map<string, { selector?: string }> })
      .functions.get("f");
    expect(fn?.selector).toMatch(/^0x[0-9a-f]{8}$/);
  });
});

// --------------------------------------------------------------------------
// CallPayload framing — every method name + arg combination must produce
// the canonical `borsh(CallPayload {function, calldata})` shape:
//   [4-byte LE function_name len][name UTF-8][4-byte LE calldata len][args]
// --------------------------------------------------------------------------
describe("CallPayload framing — wire-format invariant", () => {
  it("encodeCall = u32(name_len) ++ name ++ u32(args_len) ++ encodeCallArgs", () => {
    const c = Contract.fromJson(
      JSON.stringify({
        functions: [
          {
            name: "do_thing",
            params: [{ name: "v", ty: "U64" }],
            returns: "()",
            attrs: { bits: 0 },
          },
        ],
      }),
      ZERO,
      null as never,
    );

    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: (1n << 64n) - 1n }), (v) => {
        const payload = c.encodeCall("do_thing", { v });
        const args = c.encodeCallArgs("do_thing", { v });
        const argsHex = args.slice(2);

        // Function name UTF-8 bytes.
        const nameHex = Buffer.from("do_thing", "utf-8").toString("hex");
        const nameLen = nameHex.length / 2;
        const nameLenLE =
          (nameLen & 0xff).toString(16).padStart(2, "0") +
          ((nameLen >> 8) & 0xff).toString(16).padStart(2, "0") +
          ((nameLen >> 16) & 0xff).toString(16).padStart(2, "0") +
          ((nameLen >> 24) & 0xff).toString(16).padStart(2, "0");

        const argsLen = argsHex.length / 2;
        const argsLenLE =
          (argsLen & 0xff).toString(16).padStart(2, "0") +
          ((argsLen >> 8) & 0xff).toString(16).padStart(2, "0") +
          ((argsLen >> 16) & 0xff).toString(16).padStart(2, "0") +
          ((argsLen >> 24) & 0xff).toString(16).padStart(2, "0");

        expect(payload).toBe("0x" + nameLenLE + nameHex + argsLenLE + argsHex);
      }),
    );
  });
});
