import { describe, it, expect } from "vitest";
import { Address } from "./address";

const ZERO = "0x" + "00".repeat(32);
const ALICE = "0x" + "ab".repeat(32);
const ALICE_UPPER = "0x" + "AB".repeat(32);

describe("Address namespace", () => {
  it("zero() returns 32 zero bytes hex", () => {
    expect(Address.zero()).toBe(ZERO);
  });
  it("isZero detects the zero address", () => {
    expect(Address.isZero(ZERO)).toBe(true);
    expect(Address.isZero(ALICE)).toBe(false);
  });
  it("isValid checks length + hex chars", () => {
    expect(Address.isValid(ALICE)).toBe(true);
    expect(Address.isValid(ALICE_UPPER)).toBe(true);
    expect(Address.isValid("0xtoo-short")).toBe(false);
    expect(Address.isValid("0x" + "zz".repeat(32))).toBe(false);
  });
  it("validate returns 0x-prefixed on success", () => {
    expect(Address.validate(ALICE)).toBe(ALICE);
    expect(Address.validate(ALICE.slice(2))).toBe(ALICE);
  });
  it("validate throws on invalid input", () => {
    expect(() => Address.validate("0xtoo-short")).toThrow(/Invalid address/);
  });
  it("equals compares case-insensitively", () => {
    expect(Address.equals(ALICE, ALICE_UPPER)).toBe(true);
    expect(Address.equals(ALICE, ZERO)).toBe(false);
  });
});
