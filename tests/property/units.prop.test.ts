/**
 * Property tests for src/units.ts — parse/format round-trips and
 * invariants across the supported decimal range.
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";

import { parseUnits, formatUnits, parseQuanta, formatQuanta } from "../../src/units";

// Arbitrary supporting decimals 0..30 (covers PYDE's 9 + far beyond).
const decimals = fc.integer({ min: 0, max: 30 });
const nonNegBigint = fc.bigInt({ min: 0n, max: 2n ** 128n - 1n });

describe("units — property tests", () => {
  it("formatUnits(parseUnits(s, d), d) round-trips for any well-formed numeric string", () => {
    fc.assert(
      fc.property(
        decimals,
        fc.tuple(fc.integer({ min: 0, max: 1_000_000_000 }), fc.integer({ min: 0, max: 9 })),
        (d, [whole, fracLenRaw]) => {
          // Build a string like "123.456" with up to min(fracLen, d) decimal
          // places. When d is 0, no fractional part is permitted.
          const fracLen = Math.min(fracLenRaw, d);
          const fracPart =
            fracLen > 0
              ? "." + Array.from({ length: fracLen }, (_, i) => ((i * 3) % 9).toString()).join("")
              : "";
          const s = `${whole}${fracPart}`;
          const parsed = parseUnits(s, d);
          const formatted = formatUnits(parsed, d);
          // d=0 path: formatUnits emits "N.0" but parseUnits with d=0 rejects
          // any "." — accept the integer prefix as the round-trip target.
          if (d === 0) {
            expect(parseUnits(formatted.split(".")[0]!, d)).toBe(parsed);
          } else {
            expect(parseUnits(formatted, d)).toBe(parsed);
          }
        },
      ),
    );
  });

  it("parseUnits(formatUnits(v, d), d) === v for any non-negative bigint (d ≥ 1)", () => {
    fc.assert(
      fc.property(
        nonNegBigint,
        // d = 0 means parseUnits rejects any "." — formatUnits always emits
        // ".0" so the round-trip needs at least 1 decimal of headroom.
        fc.integer({ min: 1, max: 30 }),
        (v, d) => {
          const formatted = formatUnits(v, d);
          expect(parseUnits(formatted, d)).toBe(v);
        },
      ),
    );
  });

  it("formatUnits is monotone — a > b implies parsed a > parsed b at same decimals", () => {
    fc.assert(
      fc.property(nonNegBigint, nonNegBigint, fc.integer({ min: 1, max: 30 }), (a, b, d) => {
        if (a === b) return;
        const fa = formatUnits(a, d);
        const fb = formatUnits(b, d);
        const pa = parseUnits(fa, d);
        const pb = parseUnits(fb, d);
        if (a > b) expect(pa > pb).toBe(true);
        else expect(pa < pb).toBe(true);
      }),
    );
  });

  it("parseUnits('0', d) === 0n for all d", () => {
    fc.assert(
      fc.property(decimals, (d) => {
        expect(parseUnits("0", d)).toBe(0n);
        // "0.0" requires at least 1 decimal place — gate the assertion.
        if (d >= 1) expect(parseUnits("0.0", d)).toBe(0n);
      }),
    );
  });

  it("parseQuanta delegates to parseUnits with PYDE_DECIMALS = 9", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1_000_000 }), (whole) => {
        const s = whole.toString();
        expect(parseQuanta(s)).toBe(parseUnits(s, 9));
      }),
    );
  });

  it("formatQuanta delegates to formatUnits with 9 decimals", () => {
    fc.assert(
      fc.property(nonNegBigint, (v) => {
        expect(formatQuanta(v)).toBe(formatUnits(v, 9));
      }),
    );
  });

  it("multiplying a quanta value by 10 shifts the formatted decimal point", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 2n ** 60n }), (v) => {
        // formatQuanta(v * 10) === formatQuanta(v) with implicit shift —
        // we verify via re-parse rather than string equality (formatting
        // trims trailing zeros).
        const a = parseQuanta(formatQuanta(v));
        const b = parseQuanta(formatQuanta(v * 10n));
        expect(b).toBe(a * 10n);
      }),
    );
  });
});
