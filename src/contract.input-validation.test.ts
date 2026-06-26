/**
 * Input-validation regression tests — guard the wasm string boundary
 * so misuse produces a clear `InvalidArgumentError` instead of
 * `RuntimeError: memory access out of bounds` from wasm-bindgen's
 * release-mode `passStringToWasm0` (which doesn't validate its arg
 * is a string and traps when the buffer-length math goes NaN).
 */
import { describe, it, expect } from "vitest";

import { computeSelector } from "./crypto";
import { Contract } from "./contract";
import { Provider } from "./provider";

describe("Contract.addFunction input validation", () => {
  it("throws InvalidArgumentError when called with an options object instead of positional args", () => {
    const p = new Provider("https://rpc.example.com");
    const c = Contract.create("0x" + "00".repeat(32), p);
    expect(() =>
      // @ts-expect-error — intentionally wrong shape to verify the runtime guard
      c.addFunction({ name: "get", params: [], returns: "u64", view: true }),
    ).toThrow(/name must be a string/);
  });

  it("throws when params is not an array", () => {
    const p = new Provider("https://rpc.example.com");
    const c = Contract.create("0x" + "00".repeat(32), p);
    expect(() =>
      // @ts-expect-error — intentionally wrong shape
      c.addFunction("get", "not-an-array", "u64"),
    ).toThrow(/params must be an AbiParam\[\]/);
  });

  it("throws when returns is not a string", () => {
    const p = new Provider("https://rpc.example.com");
    const c = Contract.create("0x" + "00".repeat(32), p);
    expect(() =>
      // @ts-expect-error — intentionally wrong shape
      c.addFunction("get", [], { type: "u64" }),
    ).toThrow(/returns must be a type string/);
  });

  it("accepts the documented positional signature without crashing", () => {
    const p = new Provider("https://rpc.example.com");
    const c = Contract.create("0x" + "00".repeat(32), p);
    expect(() => c.addFunction("get", [], "u64", true)).not.toThrow();
  });
});

describe("computeSelector input validation", () => {
  it("throws InvalidArgumentError on non-string input instead of wasm OOB", () => {
    expect(() =>
      // @ts-expect-error — intentionally wrong shape to verify the wasm-boundary guard
      computeSelector({ name: "get" }),
    ).toThrow(/methodName must be a string/);
  });

  it("still computes FNV-1a for valid string input", () => {
    expect(computeSelector("get")).toBe(0x540ca757);
  });
});
