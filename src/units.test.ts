import { describe, it, expect } from "vitest";
import { parseUnits, formatUnits, parseQuanta, formatQuanta } from "./units";

describe("parseUnits", () => {
  it("parses integers", () => {
    expect(parseUnits("100", 9)).toBe(100_000_000_000n);
  });
  it("parses decimals", () => {
    expect(parseUnits("1.5", 9)).toBe(1_500_000_000n);
    expect(parseUnits("0.001", 9)).toBe(1_000_000n);
  });
  it("parses negatives", () => {
    expect(parseUnits("-1", 9)).toBe(-1_000_000_000n);
  });
  it("rejects too many decimal places", () => {
    expect(() => parseUnits("1.0000000001", 9)).toThrow(/decimal places/);
  });
  it("rejects garbage", () => {
    expect(() => parseUnits("not a number", 9)).toThrow(/Invalid/);
  });
});

describe("formatUnits", () => {
  it("formats integers cleanly", () => {
    expect(formatUnits(1_500_000_000n, 9)).toBe("1.5");
    expect(formatUnits(1_000_000n, 9)).toBe("0.001");
  });
  it("formats zero", () => {
    expect(formatUnits(0n, 9)).toBe("0.0");
  });
  it("trims trailing zeros but keeps at least one decimal", () => {
    expect(formatUnits(10_000_000_000n, 9)).toBe("10.0");
  });
  it("formats negatives", () => {
    expect(formatUnits(-1_500_000_000n, 9)).toBe("-1.5");
  });
});

describe("PYDE / quanta aliases", () => {
  it("parseQuanta uses 9 decimals (Chapter 10)", () => {
    expect(parseQuanta("1")).toBe(1_000_000_000n);
  });
  it("formatQuanta round-trips parseQuanta", () => {
    expect(formatQuanta(parseQuanta("3.141592653"))).toBe("3.141592653");
  });
});
