/** Default decimals for PYDE (1 PYDE = 10^9 quanta). */
const PYDE_DECIMALS = 9;

/**
 * Parse a human-readable token amount to raw integer units.
 *
 * ```ts
 * parseUnits("1.5", 9)   // 1500000000n
 * parseUnits("100", 18)  // 100000000000000000000n
 * parseUnits("0.001", 9) // 1000000n
 * ```
 */
export function parseUnits(value: string, decimals: number): bigint {
  if (decimals < 0 || !Number.isInteger(decimals)) {
    throw new Error(`Invalid decimals: ${decimals}`);
  }

  const trimmed = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`Invalid numeric string: "${value}"`);
  }

  const negative = trimmed.startsWith("-");
  const abs = negative ? trimmed.slice(1) : trimmed;
  const parts = abs.split(".");
  const whole = parts[0];
  const fraction = parts[1] || "";

  if (fraction.length > decimals) {
    throw new Error(
      `Too many decimal places: "${value}" has ${fraction.length} but only ${decimals} allowed`,
    );
  }

  const padded = fraction.padEnd(decimals, "0");
  const raw = BigInt(whole + padded);
  return negative ? -raw : raw;
}

/**
 * Format raw integer units to a human-readable token amount.
 *
 * ```ts
 * formatUnits(1500000000n, 9)   // "1.5"
 * formatUnits(1000000n, 9)      // "0.001"
 * formatUnits(0n, 9)            // "0.0"
 * ```
 */
export function formatUnits(
  value: bigint | number | string,
  decimals: number,
): string {
  if (decimals < 0 || !Number.isInteger(decimals)) {
    throw new Error(`Invalid decimals: ${decimals}`);
  }

  let raw = BigInt(value);
  const negative = raw < 0n;
  if (negative) raw = -raw;

  const divisor = 10n ** BigInt(decimals);
  const whole = raw / divisor;
  const remainder = raw % divisor;

  const fracStr = remainder.toString().padStart(decimals, "0");
  // Trim trailing zeros but keep at least one decimal
  const trimmed = fracStr.replace(/0+$/, "") || "0";

  const result = `${whole}.${trimmed}`;
  return negative ? `-${result}` : result;
}

/** Parse PYDE to quanta (9 decimals). `parseQuanta("1.5")` → `1500000000n` */
export function parseQuanta(value: string): bigint {
  return parseUnits(value, PYDE_DECIMALS);
}

/** Format quanta to PYDE (9 decimals). `formatQuanta(1500000000n)` → `"1.5"` */
export function formatQuanta(value: bigint | number | string): string {
  return formatUnits(value, PYDE_DECIMALS);
}
