import { computeSelector } from "./crypto";
import { Provider } from "./provider";

/** Build calldata for a contract function call. */
export class ContractCall {
  private selector: number;
  private args: Buffer;
  readonly methodName: string;

  constructor(method: string) {
    this.methodName = method;
    this.selector = computeSelector(method);
    this.args = Buffer.alloc(0);
  }

  /** Unsigned 8-bit. Range: 0 to 255. Encoded as 8 bytes LE.
   *  @example new ContractCall("set_level").argU8(100) */
  argU8(val: number): this { return this.argU64(val); }

  /** Unsigned 16-bit. Range: 0 to 65,535. Encoded as 8 bytes LE.
   *  @example new ContractCall("set_port").argU16(8080) */
  argU16(val: number): this { return this.argU64(val); }

  /** Unsigned 32-bit. Range: 0 to 4,294,967,295. Encoded as 8 bytes LE.
   *  @example new ContractCall("set_count").argU32(1_000_000) */
  argU32(val: number): this { return this.argU64(val); }

  /** Unsigned 64-bit. Range: 0 to 18,446,744,073,709,551,615. Encoded as 8 bytes LE.
   *  @example new ContractCall("deposit").argU64(500) */
  argU64(val: number | bigint): this {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(BigInt(val));
    this.args = Buffer.concat([this.args, buf]);
    return this;
  }

  /** Signed 8-bit. Range: -128 to 127. Sign-extended to 8 bytes LE.
   *  @example new ContractCall("set_offset").argI8(-1) */
  argI8(val: number): this { return this.argI64(BigInt(val)); }

  /** Signed 16-bit. Range: -32,768 to 32,767. Sign-extended to 8 bytes LE.
   *  @example new ContractCall("set_delta").argI16(-500) */
  argI16(val: number): this { return this.argI64(BigInt(val)); }

  /** Signed 32-bit. Range: -2,147,483,648 to 2,147,483,647. Sign-extended to 8 bytes LE.
   *  @example new ContractCall("set_balance").argI32(-1_000_000) */
  argI32(val: number): this { return this.argI64(BigInt(val)); }

  /** Signed 64-bit. Range: -9,223,372,036,854,775,808 to 9,223,372,036,854,775,807.
   *  Encoded as 8 bytes LE (two's complement).
   *  @example new ContractCall("set_reward").argI64(-42n) */
  argI64(val: number | bigint): this {
    const buf = Buffer.alloc(8);
    buf.writeBigInt64LE(BigInt(val));
    this.args = Buffer.concat([this.args, buf]);
    return this;
  }

  /** Boolean. true = 1, false = 0. Encoded as 8 bytes LE.
   *  @example new ContractCall("set_active").argBool(true) */
  argBool(val: boolean): this { return this.argU64(val ? 1 : 0); }

  /** Unsigned 128-bit. Range: 0 to 2^128 - 1. Encoded as 16 bytes LE.
   *  @example new ContractCall("set_supply").argU128(1_000_000_000_000n) */
  argU128(val: bigint): this {
    const buf = Buffer.alloc(16);
    buf.writeBigUInt64LE(val & 0xFFFFFFFFFFFFFFFFn, 0);
    buf.writeBigUInt64LE(val >> 64n, 8);
    this.args = Buffer.concat([this.args, buf]);
    return this;
  }

  /** Signed 128-bit. Range: -2^127 to 2^127 - 1. Encoded as 16 bytes LE.
   *  @example new ContractCall("set_delta").argI128(-500_000n) */
  argI128(val: bigint): this { return this.argU128(val); }

  /** Unsigned 256-bit. Range: 0 to 2^256 - 1. Encoded as 32 bytes LE.
   *  @example new ContractCall("set_amount").argU256(99n) */
  argU256(val: bigint): this {
    const buf = Buffer.alloc(32);
    buf.writeBigUInt64LE(val & 0xFFFFFFFFFFFFFFFFn, 0);
    buf.writeBigUInt64LE((val >> 64n) & 0xFFFFFFFFFFFFFFFFn, 8);
    buf.writeBigUInt64LE((val >> 128n) & 0xFFFFFFFFFFFFFFFFn, 16);
    buf.writeBigUInt64LE((val >> 192n) & 0xFFFFFFFFFFFFFFFFn, 24);
    this.args = Buffer.concat([this.args, buf]);
    return this;
  }

  /** Signed 256-bit. Range: -2^255 to 2^255 - 1. Encoded as 32 bytes LE.
   *  @example new ContractCall("set_price").argI256(-1n) */
  argI256(val: bigint): this { return this.argU256(val); }

  argAddress(hex: string): this {
    const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
    this.args = Buffer.concat([this.args, Buffer.from(clean, "hex")]);
    return this;
  }

  // Variable-length types
  argString(val: string): this {
    const bytes = Buffer.from(val, "utf-8");
    const lenBuf = Buffer.alloc(8);
    lenBuf.writeBigUInt64LE(BigInt(bytes.length));
    const padding = (8 - (bytes.length % 8)) % 8;
    this.args = Buffer.concat([this.args, lenBuf, bytes, Buffer.alloc(padding)]);
    return this;
  }

  argBytes(data: Buffer): this {
    this.args = Buffer.concat([this.args, data]);
    return this;
  }

  /** Encode Vec<u64>: [byte_len:8][count:8][cap:8][elements...] */
  argVecU64(vals: (number | bigint)[]): this {
    const dataLen = 16 + vals.length * 8;
    const buf = Buffer.alloc(8 + dataLen);
    buf.writeBigUInt64LE(BigInt(dataLen), 0);        // byte_len
    buf.writeBigUInt64LE(BigInt(vals.length), 8);    // count
    buf.writeBigUInt64LE(BigInt(vals.length), 16);   // cap
    for (let i = 0; i < vals.length; i++) {
      buf.writeBigUInt64LE(BigInt(vals[i]), 24 + i * 8);
    }
    this.args = Buffer.concat([this.args, buf]);
    return this;
  }

  /** Encode Vec<bool> */
  argVecBool(vals: boolean[]): this {
    return this.argVecU64(vals.map(v => v ? 1 : 0));
  }

  /** Encode Vec<Address>: [byte_len:8][count:8][cap:8][addr0:32]... */
  argVecAddress(vals: string[]): this {
    const dataLen = 16 + vals.length * 32;
    const header = Buffer.alloc(24);
    header.writeBigUInt64LE(BigInt(dataLen), 0);
    header.writeBigUInt64LE(BigInt(vals.length), 8);
    header.writeBigUInt64LE(BigInt(vals.length), 16);
    const addrs = vals.map(v => Buffer.from(v.replace("0x", ""), "hex"));
    this.args = Buffer.concat([this.args, header, ...addrs]);
    return this;
  }

  /** Encode a generic Vec: [byte_len:8][count:8][cap:8][elements...].
   *  Works with any element type — strings, structs, nested vecs.
   *
   *  @example
   *  // Vec of strings
   *  .argVecOf(2, b => b.argString("alice").argString("bob"))
   *
   *  // Vec of structs
   *  .argVecOf(2, b => b
   *    .argStruct(s => s.argString("alice").argU64(25))
   *    .argStruct(s => s.argString("bob").argU64(30)))
   *
   *  // Vec of vecs (nested)
   *  .argVecOf(2, b => b
   *    .argVecU64([1, 2, 3])
   *    .argVecU64([4, 5]))
   */
  argVecOf(count: number, buildFn: (b: ContractCall) => ContractCall): this {
    const inner = buildFn(new ContractCall("_vec_"));
    const elements = inner.args;
    const dataLen = 16 + elements.length;
    const header = Buffer.alloc(24);
    header.writeBigUInt64LE(BigInt(dataLen), 0);   // byte_len
    header.writeBigUInt64LE(BigInt(count), 8);     // count
    header.writeBigUInt64LE(BigInt(count), 16);    // cap
    this.args = Buffer.concat([this.args, header, elements]);
    return this;
  }

  /** Encode a struct: [byte_len:8][fields...]. Use a builder fn for fields. */
  argStruct(buildFn: (b: ContractCall) => ContractCall): this {
    const inner = buildFn(new ContractCall("_struct_"));
    const fields = inner.args;
    const lenBuf = Buffer.alloc(8);
    lenBuf.writeBigUInt64LE(BigInt(fields.length));
    this.args = Buffer.concat([this.args, lenBuf, fields]);
    return this;
  }

  /** Encode a tuple: sequential fields, no length prefix. */
  argTuple(buildFn: (b: ContractCall) => ContractCall): this {
    const inner = buildFn(new ContractCall("_tuple_"));
    this.args = Buffer.concat([this.args, inner.args]);
    return this;
  }

  /** Build final calldata: [selector:4 BE][args]. Returns hex with 0x prefix. */
  build(): string {
    const sel = Buffer.alloc(4);
    sel.writeUInt32BE(this.selector);
    const full = Buffer.concat([sel, this.args]);
    return "0x" + full.toString("hex");
  }
}

// ============================================================================
// Decode helpers
// ============================================================================

// Unsigned integers
export function decodeU64(hex: string): bigint {
  const buf = Buffer.from(stripHex(hex), "hex");
  if (buf.length < 8) return 0n;
  return buf.readBigUInt64LE();
}
export function decodeU128(hex: string): bigint {
  const buf = Buffer.from(stripHex(hex), "hex");
  if (buf.length < 16) return 0n;
  const lo = buf.readBigUInt64LE(0);
  const hi = buf.readBigUInt64LE(8);
  return lo | (hi << 64n);
}
export function decodeU256(hex: string): bigint {
  const buf = Buffer.from(stripHex(hex), "hex");
  if (buf.length < 32) return 0n;
  let val = 0n;
  for (let i = 0; i < 4; i++) {
    val |= buf.readBigUInt64LE(i * 8) << BigInt(i * 64);
  }
  return val;
}

// Signed integers
export function decodeI64(hex: string): bigint {
  const buf = Buffer.from(stripHex(hex), "hex");
  if (buf.length < 8) return 0n;
  return buf.readBigInt64LE();
}
export function decodeI128(hex: string): bigint {
  const raw = decodeU128(hex);
  const max = 1n << 127n;
  return raw >= max ? raw - (1n << 128n) : raw;
}

// Bool, Address, String
export function decodeBool(hex: string): boolean {
  return decodeU64(hex) !== 0n;
}
export function decodeAddress(hex: string): string {
  const buf = Buffer.from(stripHex(hex), "hex");
  if (buf.length < 32) return "0x" + "00".repeat(32);
  return "0x" + buf.subarray(0, 32).toString("hex");
}
export function decodeString(hex: string): string {
  const buf = Buffer.from(stripHex(hex), "hex");
  if (buf.length < 8) return "";
  const len = Number(buf.readBigUInt64LE());
  if (buf.length < 8 + len) return "";
  return buf.subarray(8, 8 + len).toString("utf-8");
}

// Bytes: [len:8][data]
export function decodeBytes(hex: string): Buffer {
  const buf = Buffer.from(stripHex(hex), "hex");
  if (buf.length < 8) return Buffer.alloc(0);
  const len = Number(buf.readBigUInt64LE());
  if (buf.length < 8 + len) return Buffer.alloc(0);
  return buf.subarray(8, 8 + len);
}

// Vec<u64>: [byte_len:8][count:8][cap:8][elements...]
export function decodeVecU64(hex: string): bigint[] {
  const buf = Buffer.from(stripHex(hex), "hex");
  if (buf.length < 24) return [];
  const count = Number(buf.readBigUInt64LE(8));
  const result: bigint[] = [];
  for (let i = 0; i < count; i++) {
    const off = 24 + i * 8;
    if (buf.length < off + 8) break;
    result.push(buf.readBigUInt64LE(off));
  }
  return result;
}

// Vec<bool>
export function decodeVecBool(hex: string): boolean[] {
  return decodeVecU64(hex).map(v => v !== 0n);
}

/** ABI-aware contract interface. */
export class Contract {
  readonly address: string;
  readonly provider: Provider;
  private functions: Map<string, { returnType: string }> = new Map();

  constructor(address: string, provider: Provider) {
    this.address = address;
    this.provider = provider;
  }

  /** Register a function for auto-decoding. */
  addFunction(name: string, returnType: string): this {
    this.functions.set(name, { returnType });
    return this;
  }

  /** Read-only call with auto-decoded return value. */
  async read(method: string, data?: string): Promise<any> {
    const calldata = data || new ContractCall(method).build();
    const result = await this.provider.call(this.address, calldata);
    const retType = this.functions.get(method)?.returnType || "u64";
    return decodeValue(result, retType);
  }
}

/** Decode raw hex return based on type string. */
/** Auto-decode raw hex return based on type string from ABI. */
export function decodeValue(hex: string, typeStr: string): any {
  switch (typeStr) {
    case "u8": case "u16": case "u32": case "u64":
      return decodeU64(hex);
    case "i8": case "i16": case "i32": case "i64":
      return decodeI64(hex);
    case "u128":
      return decodeU128(hex);
    case "i128":
      return decodeI128(hex);
    case "u256":
      return decodeU256(hex);
    case "bool":
      return decodeBool(hex);
    case "Address":
      return decodeAddress(hex);
    case "String":
      return decodeString(hex);
    case "Bytes":
      return decodeBytes(hex);
    case "Vec<u64>":
      return decodeVecU64(hex);
    case "Vec<bool>":
      return decodeVecBool(hex);
    default:
      return hex;
  }
}

function stripHex(s: string): string {
  return s.startsWith("0x") ? s.slice(2) : s;
}
