import { describe, it, expect } from "vitest";
import { generateTypes } from "./codegen";

describe("generateTypes", () => {
  it("emits a Contract interface with typed methods", () => {
    const abi = JSON.stringify({
      name: "Counter",
      abi: {
        functions: [
          {
            name: "get_count",
            params: [],
            returns: "u64",
            view: true,
            payable: false,
          },
          {
            name: "deposit",
            params: [{ name: "amount", type: "u128" }],
            returns: "()",
            view: false,
            payable: true,
          },
        ],
      },
    });
    const out = generateTypes(abi);
    expect(out).toContain("export interface CounterContract");
    expect(out).toContain("get_count(): Promise<bigint>;");
    expect(out).toContain("deposit(amount: bigint): Promise<void>;");
    expect(out).toContain("/** view */");
    expect(out).toContain("/** payable */");
  });

  it("emits per-event interfaces with indexed-field tagging", () => {
    const abi = JSON.stringify({
      abi: {
        functions: [],
        events: [
          {
            name: "Transfer",
            fields: [
              { name: "from", type: "Address", indexed: true },
              { name: "to", type: "Address", indexed: true },
              { name: "amount", type: "u128", indexed: false },
            ],
          },
        ],
      },
    });
    const out = generateTypes(abi, "Token");
    expect(out).toContain("export interface TokenTransferEvent");
    expect(out).toContain("/** indexed · Address */");
    expect(out).toContain("from: string;");
    expect(out).toContain("amount: bigint;");
  });

  it("maps Vec<T> to T[]", () => {
    const abi = JSON.stringify({
      abi: {
        functions: [
          {
            name: "list",
            params: [],
            returns: "Vec<u64>",
            view: true,
            payable: false,
          },
        ],
      },
    });
    expect(generateTypes(abi)).toContain("list(): Promise<bigint[]>;");
  });

  it("falls back to unknown for unmapped types", () => {
    const abi = JSON.stringify({
      abi: {
        functions: [
          {
            name: "exotic",
            params: [{ name: "weird", type: "WeirdStruct" }],
            returns: "u64",
            view: true,
            payable: false,
          },
        ],
      },
    });
    expect(generateTypes(abi)).toContain("exotic(weird: unknown): Promise<bigint>;");
  });

  it("emits an AbiShape suitable for Contract<TAbi> narrowing", () => {
    const abi = JSON.stringify({
      name: "Counter",
      abi: {
        functions: [
          { name: "get_count", params: [], returns: "u64", view: true, payable: false },
          {
            name: "deposit",
            params: [{ name: "amount", type: "u128" }],
            returns: "()",
            view: false,
            payable: true,
          },
        ],
        events: [
          {
            name: "Increment",
            fields: [{ name: "by", type: "u64", indexed: false }],
          },
        ],
      },
    });
    const out = generateTypes(abi);
    // Has the AbiShape entry that Contract<TAbi> consumes.
    expect(out).toContain("export interface CounterAbi");
    expect(out).toMatch(
      /"get_count":\s*\{\s*args:\s*\{\}\s*;\s*returns:\s*bigint\s*;\s*view:\s*true/,
    );
    expect(out).toMatch(
      /"deposit":\s*\{\s*args:\s*\{\s*amount:\s*bigint\s*\}\s*;\s*returns:\s*void\s*;\s*view:\s*false\s*;\s*payable:\s*true/,
    );
    expect(out).toMatch(/"Increment":\s*\{\s*args:\s*\{\s*by:\s*bigint\s*\}\s*\}/);
  });

  it("quotes non-identifier names", () => {
    const abi = JSON.stringify({
      abi: {
        functions: [
          {
            name: "foo-bar",
            params: [],
            returns: "()",
            view: true,
            payable: false,
          },
        ],
      },
    });
    expect(generateTypes(abi)).toContain('"foo-bar"(): Promise<void>;');
  });
});
