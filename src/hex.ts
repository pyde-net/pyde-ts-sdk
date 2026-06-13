/**
 * Hex + byte utilities. Isomorphic: returns `Uint8Array` everywhere so
 * the same code path works in browsers (where `Buffer` doesn't exist
 * unless polyfilled) and Node (where `Buffer` extends `Uint8Array` so
 * any `Buffer` value is accepted on input transparently).
 */

const HEX_REGEX = /^[0-9a-fA-F]*$/;

/** Strip an optional `0x` / `0X` prefix. */
function strip(hex: string): string {
  return hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
}

/** Check if a value is a valid hex string (with or without 0x prefix).
 *  Optional `length` is in BYTES — pass 32 for a 32-byte address. */
export function isHexString(value: unknown, length?: number): boolean {
  if (typeof value !== "string") return false;
  const hex = strip(value);
  if (!HEX_REGEX.test(hex)) return false;
  if (length !== undefined && hex.length !== length * 2) return false;
  return true;
}

/** Convert bytes / number / bigint / hex string to a `0x`-prefixed lowercase hex string. */
export function hexlify(value: string | Uint8Array | bigint | number): string {
  if (typeof value === "string") {
    const hex = strip(value);
    if (!HEX_REGEX.test(hex)) throw new Error(`Invalid hex string: "${value}"`);
    return "0x" + hex.toLowerCase();
  }
  if (typeof value === "bigint") {
    if (value < 0n) throw new Error(`Cannot hexlify negative bigint: ${value}`);
    return "0x" + value.toString(16);
  }
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`Invalid number for hex: ${value}`);
    }
    return "0x" + value.toString(16);
  }
  return "0x" + bytesToHex(value);
}

/** Convert a hex string or `Uint8Array` to a `Uint8Array`.
 *  Accepts Node `Buffer` transparently since `Buffer extends Uint8Array`. */
export function getBytes(value: string | Uint8Array): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (typeof value === "string") {
    const hex = strip(value);
    if (hex.length % 2 !== 0) {
      throw new Error(`Hex string must have even length: "${value}"`);
    }
    if (!HEX_REGEX.test(hex)) throw new Error(`Invalid hex string: "${value}"`);
    return hexToBytes(hex);
  }
  throw new Error("Expected hex string or Uint8Array");
}

/** Convert a bigint or number to a `0x`-prefixed big-endian hex string,
 *  optionally zero-padded to `width` bytes. */
export function toBeHex(value: bigint | number, width?: number): string {
  let hex = BigInt(value).toString(16);
  if (width !== undefined) hex = hex.padStart(width * 2, "0");
  if (hex.length % 2 !== 0) hex = "0" + hex;
  return "0x" + hex;
}

/** Concatenate multiple hex strings or `Uint8Array`s into one hex string. */
export function concat(values: (string | Uint8Array)[]): string {
  const chunks = values.map((v) => getBytes(v));
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return "0x" + bytesToHex(out);
}

/** Left-pad bytes with zeroes to a specific byte length. */
export function zeroPadValue(value: string | Uint8Array, length: number): string {
  const bytes = getBytes(value);
  if (bytes.length > length) {
    throw new Error(`Value ${bytes.length} bytes exceeds pad length ${length}`);
  }
  const padded = new Uint8Array(length);
  padded.set(bytes, length - bytes.length);
  return "0x" + bytesToHex(padded);
}

/** Strip leading zero bytes from a hex value. */
export function stripZeros(value: string | Uint8Array): string {
  const bytes = getBytes(value);
  let i = 0;
  while (i < bytes.length && bytes[i] === 0) i++;
  return "0x" + bytesToHex(bytes.subarray(i));
}

/** Get the byte length of a hex string. */
export function dataLength(value: string): number {
  const hex = strip(value);
  if (hex.length % 2 !== 0) {
    throw new Error(`Hex string must have even length: "${value}"`);
  }
  return hex.length / 2;
}

/** Extract a slice (in bytes) from a hex string. */
export function dataSlice(value: string, start: number, end?: number): string {
  const bytes = getBytes(value);
  return "0x" + bytesToHex(bytes.subarray(start, end));
}

// ===========================================================================
// Internals (no Buffer dependency — uses standard string + Uint8Array APIs).
// ===========================================================================

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const v = bytes[i];
    if (v === undefined) continue;
    out += v.toString(16).padStart(2, "0");
  }
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
