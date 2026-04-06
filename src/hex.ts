/** Check if a value is a valid hex string (with or without 0x prefix). */
export function isHexString(value: unknown, length?: number): boolean {
  if (typeof value !== "string") return false;
  const hex = value.startsWith("0x") ? value.slice(2) : value;
  if (!/^[0-9a-fA-F]*$/.test(hex)) return false;
  if (length !== undefined && hex.length !== length * 2) return false;
  return true;
}

/** Convert bytes (Buffer, Uint8Array, or hex string) to a 0x-prefixed hex string. */
export function hexlify(value: string | Buffer | Uint8Array | bigint | number): string {
  if (typeof value === "string") {
    const hex = value.startsWith("0x") ? value.slice(2) : value;
    if (!/^[0-9a-fA-F]*$/.test(hex)) throw new Error(`Invalid hex string: "${value}"`);
    return "0x" + hex.toLowerCase();
  }
  if (typeof value === "bigint") {
    if (value < 0n) throw new Error(`Cannot hexlify negative bigint: ${value}`);
    return "0x" + value.toString(16);
  }
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0) throw new Error(`Invalid number for hex: ${value}`);
    return "0x" + value.toString(16);
  }
  return "0x" + Buffer.from(value).toString("hex");
}

/** Convert a hex string to a Buffer. */
export function getBytes(value: string | Buffer | Uint8Array): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "string") {
    const hex = value.startsWith("0x") ? value.slice(2) : value;
    if (hex.length % 2 !== 0) throw new Error(`Hex string must have even length: "${value}"`);
    if (!/^[0-9a-fA-F]*$/.test(hex)) throw new Error(`Invalid hex string: "${value}"`);
    return Buffer.from(hex, "hex");
  }
  throw new Error("Expected hex string, Buffer, or Uint8Array");
}

/** Convert a bigint or number to a 0x-prefixed big-endian hex string. */
export function toBeHex(value: bigint | number, width?: number): string {
  let hex = BigInt(value).toString(16);
  if (width !== undefined) hex = hex.padStart(width * 2, "0");
  if (hex.length % 2 !== 0) hex = "0" + hex;
  return "0x" + hex;
}

/** Concatenate multiple hex strings or Buffers into one hex string. */
export function concat(values: (string | Buffer | Uint8Array)[]): string {
  const bufs = values.map(v => getBytes(v));
  return "0x" + Buffer.concat(bufs).toString("hex");
}

/** Zero-pad a value to a specific byte length (left-pad). */
export function zeroPadValue(value: string | Buffer | Uint8Array, length: number): string {
  const buf = getBytes(value);
  if (buf.length > length) throw new Error(`Value ${buf.length} bytes exceeds pad length ${length}`);
  const padded = Buffer.alloc(length);
  buf.copy(padded, length - buf.length);
  return "0x" + padded.toString("hex");
}

/** Strip leading zero bytes from a hex value. */
export function stripZeros(value: string | Buffer | Uint8Array): string {
  const buf = getBytes(value);
  let i = 0;
  while (i < buf.length && buf[i] === 0) i++;
  return "0x" + buf.subarray(i).toString("hex");
}

/** Get the byte length of a hex string. */
export function dataLength(value: string): number {
  const hex = value.startsWith("0x") ? value.slice(2) : value;
  if (hex.length % 2 !== 0) throw new Error(`Hex string must have even length: "${value}"`);
  return hex.length / 2;
}

/** Extract a slice from a hex string. */
export function dataSlice(value: string, start: number, end?: number): string {
  const buf = getBytes(value);
  return "0x" + buf.subarray(start, end).toString("hex");
}
