/**
 * Property tests for src/address.ts — validation invariants over
 * random hex strings.
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";

import { Address } from "../../src/address";

const hexChar = fc.constantFrom(
  "0",
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "a",
  "b",
  "c",
  "d",
  "e",
  "f",
);
const valid32ByteHex = fc
  .array(hexChar, { minLength: 64, maxLength: 64 })
  .map((cs) => "0x" + cs.join(""));
const valid32ByteHexNoPrefix = fc
  .array(hexChar, { minLength: 64, maxLength: 64 })
  .map((cs) => cs.join(""));

describe("Address — property tests", () => {
  it("isValid accepts any 32-byte hex string (with or without 0x prefix)", () => {
    fc.assert(
      fc.property(valid32ByteHex, (addr) => {
        expect(Address.isValid(addr)).toBe(true);
      }),
    );
    fc.assert(
      fc.property(valid32ByteHexNoPrefix, (addr) => {
        expect(Address.isValid(addr)).toBe(true);
      }),
    );
  });

  it("isValid rejects hex strings of any length other than 64 chars", () => {
    fc.assert(
      fc.property(
        fc.array(hexChar, { minLength: 1, maxLength: 256 }).filter((cs) => cs.length !== 64),
        (cs) => {
          expect(Address.isValid("0x" + cs.join(""))).toBe(false);
        },
      ),
    );
  });

  it("validate normalises to 0x-prefixed form", () => {
    fc.assert(
      fc.property(valid32ByteHexNoPrefix, (raw) => {
        const normalised = Address.validate(raw);
        expect(normalised.startsWith("0x")).toBe(true);
        expect(normalised.slice(2)).toBe(raw);
      }),
    );
  });

  it("validate is idempotent", () => {
    fc.assert(
      fc.property(valid32ByteHex, (addr) => {
        expect(Address.validate(Address.validate(addr))).toBe(addr);
      }),
    );
  });

  it("equals is case-insensitive and reflexive", () => {
    fc.assert(
      fc.property(valid32ByteHex, (addr) => {
        const upper = addr.slice(0, 2) + addr.slice(2).toUpperCase();
        expect(Address.equals(addr, addr)).toBe(true);
        expect(Address.equals(addr, upper)).toBe(true);
      }),
    );
  });

  it("equals is symmetric", () => {
    fc.assert(
      fc.property(valid32ByteHex, valid32ByteHex, (a, b) => {
        expect(Address.equals(a, b)).toBe(Address.equals(b, a));
      }),
    );
  });

  it("isZero is exactly equal to comparing against Address.zero()", () => {
    fc.assert(
      fc.property(valid32ByteHex, (addr) => {
        expect(Address.isZero(addr)).toBe(Address.equals(addr, Address.zero()));
      }),
    );
  });
});
