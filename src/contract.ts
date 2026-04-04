import { computeSelector } from "./crypto";
import { Provider } from "./provider";
import { Wallet } from "./wallet";
import { Receipt } from "./types";

// ============================================================================
// ABI types (parsed from artifact JSON)
// ============================================================================

interface AbiFunction {
  name: string;
  selector: string;
  params: AbiParam[];
  returns: string;
  view: boolean;
  constructor: boolean;
}

interface AbiParam {
  name: string;
  type: string;
}

interface AbiStructDef {
  name: string;
  fields: AbiParam[];
}

interface AbiEnumDef {
  name: string;
  variants: { name: string; discriminant: number }[];
}

// ============================================================================
// Contract — ABI-aware interface
// ============================================================================

/** ABI-aware contract interface with validation and auto-encoding. */
export class Contract {
  readonly address: string;
  readonly provider: Provider;
  private wallet: Wallet | null = null;
  private functions: Map<string, AbiFunction> = new Map();
  private structs: Map<string, AbiStructDef> = new Map();
  private enums: Map<string, AbiEnumDef> = new Map();

  private constructor(address: string, provider: Provider) {
    this.address = address;
    this.provider = provider;
  }

  /** Load contract from a build artifact JSON file (Node.js). */
  static fromArtifact(artifactPath: string, address: string, provider: Provider): Contract {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require("fs");
    const json = fs.readFileSync(artifactPath, "utf-8");
    return Contract.fromJson(json, address, provider);
  }

  /** Load contract from ABI JSON string. */
  static fromJson(json: string, address: string, provider: Provider): Contract {
    const artifact = JSON.parse(json);
    const contract = new Contract(address, provider);
    const abi = artifact.abi || artifact;

    // Parse functions
    for (const f of abi.functions || []) {
      contract.functions.set(f.name, f);
    }

    // Parse struct definitions
    for (const s of abi.structs || []) {
      contract.structs.set(s.name, s);
    }

    // Parse enum definitions
    for (const e of abi.enums || []) {
      contract.enums.set(e.name, e);
    }

    return contract;
  }

  /** Create a minimal contract (no ABI, manual function registration). */
  static create(address: string, provider: Provider): Contract {
    return new Contract(address, provider);
  }

  /** Register a function manually (when no artifact is available). */
  addFunction(name: string, params: AbiParam[], returns: string, view = false): this {
    this.functions.set(name, {
      name,
      selector: "0x" + computeSelector(name).toString(16).padStart(8, "0"),
      params,
      returns,
      view,
      constructor: false,
    });
    return this;
  }

  /** Bind a wallet for write operations. Returns a new Contract instance. */
  connect(wallet: Wallet): Contract {
    const c = new Contract(this.address, this.provider);
    c.wallet = wallet;
    c.functions = this.functions;
    c.structs = this.structs;
    c.enums = this.enums;
    return c;
  }

  // ========================================================================
  // Read (static call — no wallet needed)
  // ========================================================================

  /** Call a view function. Auto-encodes args and decodes return value. */
  async read(method: string, args: Record<string, any> = {}): Promise<any> {
    const fn = this.functions.get(method);
    if (!fn) throw new Error(`Unknown function '${method}'. Load ABI or call addFunction().`);

    const calldata = this.encodeCall(method, args);
    const resultHex = await this.provider.call(this.address, calldata);
    return this.decodeReturn(fn.returns, resultHex);
  }

  // ========================================================================
  // Write (state-changing — wallet required)
  // ========================================================================

  /** Send a state-changing transaction. Auto-encodes args, signs, sends, waits. */
  async write(method: string, args: Record<string, any> = {}, gasLimit = 100_000_000): Promise<Receipt> {
    if (!this.wallet) {
      throw new Error("No wallet connected. Use contract.connect(wallet) first.");
    }

    const calldata = this.encodeCall(method, args);
    return this.wallet.sendCall(this.provider, this.address, calldata, gasLimit);
  }

  // ========================================================================
  // Encoding — args to calldata
  // ========================================================================

  /** Encode a function call with named args. Validates types against ABI. */
  encodeCall(method: string, args: Record<string, any> = {}): string {
    const fn = this.functions.get(method);
    if (!fn) throw new Error(`Unknown function '${method}'.`);

    const selector = computeSelector(method);
    const buf: number[] = [];

    // Selector (4 bytes BE)
    buf.push((selector >> 24) & 0xff);
    buf.push((selector >> 16) & 0xff);
    buf.push((selector >> 8) & 0xff);
    buf.push(selector & 0xff);

    // Encode each param
    for (const param of fn.params) {
      const value = args[param.name];
      if (value === undefined) {
        throw new Error(`${method}(): missing required param '${param.name}' (${param.type})`);
      }
      this.encodeValue(buf, value, param.type, `${method}().${param.name}`);
    }

    return "0x" + Buffer.from(buf).toString("hex");
  }

  /** Encode a single value based on its ABI type. Validates type match. */
  private encodeValue(buf: number[], value: any, type: string, path: string): void {
    // GP integers (8 bytes LE)
    if (["u8", "u16", "u32", "u64", "i8", "i16", "i32", "i64"].includes(type)) {
      if (typeof value !== "number" && typeof value !== "bigint") {
        throw new Error(`${path}: expected ${type}, got ${typeof value}`);
      }
      const n = BigInt(value);
      this.validateIntRange(n, type, path);
      const b = Buffer.alloc(8);
      if (type.startsWith("i")) {
        b.writeBigInt64LE(n);
      } else {
        b.writeBigUInt64LE(n);
      }
      buf.push(...b);
      return;
    }

    // u128/i128 (16 bytes LE)
    if (type === "u128" || type === "i128") {
      if (typeof value !== "bigint" && typeof value !== "number") {
        throw new Error(`${path}: expected ${type}, got ${typeof value}`);
      }
      const n = BigInt(value);
      const b = Buffer.alloc(16);
      b.writeBigUInt64LE(n & 0xFFFFFFFFFFFFFFFFn, 0);
      b.writeBigUInt64LE((n >> 64n) & 0xFFFFFFFFFFFFFFFFn, 8);
      buf.push(...b);
      return;
    }

    // u256/i256 (32 bytes LE)
    if (type === "u256" || type === "i256") {
      if (typeof value !== "bigint" && typeof value !== "number") {
        throw new Error(`${path}: expected ${type}, got ${typeof value}`);
      }
      const n = BigInt(value);
      const b = Buffer.alloc(32);
      for (let i = 0; i < 4; i++) {
        b.writeBigUInt64LE((n >> BigInt(i * 64)) & 0xFFFFFFFFFFFFFFFFn, i * 8);
      }
      buf.push(...b);
      return;
    }

    // bool
    if (type === "bool") {
      if (typeof value !== "boolean") {
        throw new Error(`${path}: expected bool, got ${typeof value}`);
      }
      const b = Buffer.alloc(8);
      b.writeBigUInt64LE(value ? 1n : 0n);
      buf.push(...b);
      return;
    }

    // Address (32 bytes)
    if (type === "Address") {
      if (typeof value !== "string") {
        throw new Error(`${path}: expected Address (hex string), got ${typeof value}`);
      }
      const hex = value.startsWith("0x") ? value.slice(2) : value;
      if (hex.length !== 64) {
        throw new Error(`${path}: Address must be 64 hex chars, got ${hex.length}`);
      }
      buf.push(...Buffer.from(hex, "hex"));
      return;
    }

    // String
    if (type === "String") {
      if (typeof value !== "string") {
        throw new Error(`${path}: expected String, got ${typeof value}`);
      }
      const bytes = Buffer.from(value, "utf-8");
      const lenBuf = Buffer.alloc(8);
      lenBuf.writeBigUInt64LE(BigInt(bytes.length));
      buf.push(...lenBuf, ...bytes);
      const pad = (8 - (bytes.length % 8)) % 8;
      for (let i = 0; i < pad; i++) buf.push(0);
      return;
    }

    // Vec<T>
    if (type.startsWith("Vec<") && type.endsWith(">")) {
      if (!Array.isArray(value)) {
        throw new Error(`${path}: expected array for ${type}, got ${typeof value}`);
      }
      const elemType = type.slice(4, -1);
      const elemBuf: number[] = [];
      for (let i = 0; i < value.length; i++) {
        this.encodeValue(elemBuf, value[i], elemType, `${path}[${i}]`);
      }
      const dataLen = 16 + elemBuf.length;
      const header = Buffer.alloc(24);
      header.writeBigUInt64LE(BigInt(dataLen), 0);
      header.writeBigUInt64LE(BigInt(value.length), 8);
      header.writeBigUInt64LE(BigInt(value.length), 16);
      buf.push(...header, ...elemBuf);
      return;
    }

    // Struct (by name — look up in ABI)
    const structDef = this.structs.get(type);
    if (structDef) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`${path}: expected object for struct ${type}, got ${typeof value}`);
      }
      const fieldBuf: number[] = [];
      for (const field of structDef.fields) {
        const fieldVal = value[field.name];
        if (fieldVal === undefined) {
          throw new Error(`${path}: missing field '${field.name}' for struct ${type}`);
        }
        this.encodeValue(fieldBuf, fieldVal, field.type, `${path}.${field.name}`);
      }
      // [byte_len:8][fields...]
      const lenBuf = Buffer.alloc(8);
      lenBuf.writeBigUInt64LE(BigInt(fieldBuf.length));
      buf.push(...lenBuf, ...fieldBuf);
      return;
    }

    // Enum (by name)
    const enumDef = this.enums.get(type);
    if (enumDef) {
      if (typeof value !== "string" && typeof value !== "number") {
        throw new Error(`${path}: expected variant name or discriminant for enum ${type}`);
      }
      let disc: number;
      if (typeof value === "string") {
        const variant = enumDef.variants.find(v => v.name === value);
        if (!variant) {
          throw new Error(`${path}: unknown variant '${value}' for enum ${type}. Valid: ${enumDef.variants.map(v => v.name).join(", ")}`);
        }
        disc = variant.discriminant;
      } else {
        disc = value;
      }
      const b = Buffer.alloc(8);
      b.writeBigUInt64LE(BigInt(disc));
      buf.push(...b);
      return;
    }

    throw new Error(`${path}: unsupported type '${type}'`);
  }

  private validateIntRange(n: bigint, type: string, path: string): void {
    const ranges: Record<string, [bigint, bigint]> = {
      u8: [0n, 255n],
      u16: [0n, 65535n],
      u32: [0n, 4294967295n],
      u64: [0n, 18446744073709551615n],
      i8: [-128n, 127n],
      i16: [-32768n, 32767n],
      i32: [-2147483648n, 2147483647n],
      i64: [-9223372036854775808n, 9223372036854775807n],
    };
    const range = ranges[type];
    if (range && (n < range[0] || n > range[1])) {
      throw new Error(`${path}: value ${n} out of range for ${type} (${range[0]} to ${range[1]})`);
    }
  }

  // ========================================================================
  // Decoding — return hex to values
  // ========================================================================

  private decodeReturn(type: string, hex: string): any {
    const data = Buffer.from(hex.startsWith("0x") ? hex.slice(2) : hex, "hex");
    return this.decodeValue(data, type, 0).value;
  }

  private decodeValue(data: Buffer, type: string, offset: number): { value: any; bytesRead: number } {
    if (["u8", "u16", "u32", "u64"].includes(type)) {
      if (data.length < offset + 8) return { value: 0n, bytesRead: 8 };
      return { value: data.readBigUInt64LE(offset), bytesRead: 8 };
    }
    if (["i8", "i16", "i32", "i64"].includes(type)) {
      if (data.length < offset + 8) return { value: 0n, bytesRead: 8 };
      return { value: data.readBigInt64LE(offset), bytesRead: 8 };
    }
    if (type === "u128") {
      if (data.length < offset + 16) return { value: 0n, bytesRead: 16 };
      const lo = data.readBigUInt64LE(offset);
      const hi = data.readBigUInt64LE(offset + 8);
      return { value: lo | (hi << 64n), bytesRead: 16 };
    }
    if (type === "u256" || type === "i256") {
      if (data.length < offset + 32) return { value: 0n, bytesRead: 32 };
      let val = 0n;
      for (let i = 0; i < 4; i++) {
        val |= data.readBigUInt64LE(offset + i * 8) << BigInt(i * 64);
      }
      return { value: val, bytesRead: 32 };
    }
    if (type === "bool") {
      if (data.length < offset + 8) return { value: false, bytesRead: 8 };
      return { value: data.readBigUInt64LE(offset) !== 0n, bytesRead: 8 };
    }
    if (type === "Address") {
      if (data.length < offset + 32) return { value: "0x" + "00".repeat(32), bytesRead: 32 };
      return { value: "0x" + data.subarray(offset, offset + 32).toString("hex"), bytesRead: 32 };
    }
    if (type === "String") {
      if (data.length < offset + 8) return { value: "", bytesRead: 8 };
      const len = Number(data.readBigUInt64LE(offset));
      const str = data.subarray(offset + 8, offset + 8 + len).toString("utf-8");
      const aligned = 8 + len + ((8 - (len % 8)) % 8);
      return { value: str, bytesRead: aligned };
    }
    if (type.startsWith("Vec<") && type.endsWith(">")) {
      const elemType = type.slice(4, -1);
      if (data.length < offset + 24) return { value: [], bytesRead: 24 };
      const byteLen = Number(data.readBigUInt64LE(offset));
      const count = Number(data.readBigUInt64LE(offset + 8));
      let cursor = offset + 24;
      const items: any[] = [];
      for (let i = 0; i < count; i++) {
        const { value, bytesRead } = this.decodeValue(data, elemType, cursor);
        items.push(value);
        cursor += bytesRead;
      }
      return { value: items, bytesRead: 8 + byteLen };
    }

    // Struct
    const structDef = this.structs.get(type);
    if (structDef) {
      if (data.length < offset + 8) return { value: {}, bytesRead: 8 };
      const byteLen = Number(data.readBigUInt64LE(offset));
      let cursor = offset + 8;
      const obj: Record<string, any> = {};
      for (const field of structDef.fields) {
        const { value, bytesRead } = this.decodeValue(data, field.type, cursor);
        obj[field.name] = value;
        cursor += bytesRead;
      }
      return { value: obj, bytesRead: 8 + byteLen };
    }

    // Enum
    const enumDef = this.enums.get(type);
    if (enumDef) {
      if (data.length < offset + 8) return { value: null, bytesRead: 8 };
      const disc = Number(data.readBigUInt64LE(offset));
      const variant = enumDef.variants.find(v => v.discriminant === disc);
      return { value: variant?.name || disc, bytesRead: 8 };
    }

    if (type === "()" || type === "unit") {
      return { value: null, bytesRead: 0 };
    }

    return { value: "0x" + data.subarray(offset).toString("hex"), bytesRead: data.length - offset };
  }
}

// ============================================================================
// ContractCall — low-level builder (still available for manual use)
// ============================================================================

/** Low-level calldata builder. For most cases, use Contract.read/write instead. */
export class ContractCall {
  private selector: number;
  private _args: Buffer;
  readonly methodName: string;

  constructor(method: string) {
    this.methodName = method;
    this.selector = computeSelector(method);
    this._args = Buffer.alloc(0);
  }

  get args(): Buffer { return this._args; }

  /** @see u8: 0 to 255 */
  argU8(val: number): this { return this.argU64(val); }
  /** @see u16: 0 to 65,535 */
  argU16(val: number): this { return this.argU64(val); }
  /** @see u32: 0 to 4,294,967,295 */
  argU32(val: number): this { return this.argU64(val); }
  /** @see u64: 0 to 18,446,744,073,709,551,615 */
  argU64(val: number | bigint): this {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(BigInt(val));
    this._args = Buffer.concat([this._args, buf]);
    return this;
  }
  /** @see i8: -128 to 127 */
  argI8(val: number): this { return this.argI64(BigInt(val)); }
  /** @see i16: -32,768 to 32,767 */
  argI16(val: number): this { return this.argI64(BigInt(val)); }
  /** @see i32: -2,147,483,648 to 2,147,483,647 */
  argI32(val: number): this { return this.argI64(BigInt(val)); }
  /** @see i64: -9.2e18 to 9.2e18 */
  argI64(val: number | bigint): this {
    const buf = Buffer.alloc(8);
    buf.writeBigInt64LE(BigInt(val));
    this._args = Buffer.concat([this._args, buf]);
    return this;
  }
  argBool(val: boolean): this { return this.argU64(val ? 1 : 0); }
  argU128(val: bigint): this {
    const buf = Buffer.alloc(16);
    buf.writeBigUInt64LE(val & 0xFFFFFFFFFFFFFFFFn, 0);
    buf.writeBigUInt64LE(val >> 64n, 8);
    this._args = Buffer.concat([this._args, buf]);
    return this;
  }
  argU256(val: bigint): this {
    const buf = Buffer.alloc(32);
    for (let i = 0; i < 4; i++) {
      buf.writeBigUInt64LE((val >> BigInt(i * 64)) & 0xFFFFFFFFFFFFFFFFn, i * 8);
    }
    this._args = Buffer.concat([this._args, buf]);
    return this;
  }
  argAddress(hex: string): this {
    const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
    this._args = Buffer.concat([this._args, Buffer.from(clean, "hex")]);
    return this;
  }
  argString(val: string): this {
    const bytes = Buffer.from(val, "utf-8");
    const lenBuf = Buffer.alloc(8);
    lenBuf.writeBigUInt64LE(BigInt(bytes.length));
    const padding = (8 - (bytes.length % 8)) % 8;
    this._args = Buffer.concat([this._args, lenBuf, bytes, Buffer.alloc(padding)]);
    return this;
  }
  argBytes(data: Buffer): this {
    this._args = Buffer.concat([this._args, data]);
    return this;
  }

  build(): string {
    const sel = Buffer.alloc(4);
    sel.writeUInt32BE(this.selector);
    const full = Buffer.concat([sel, this._args]);
    return "0x" + full.toString("hex");
  }
}

// ============================================================================
// Standalone decoders (for manual use)
// ============================================================================

export function decodeU64(hex: string): bigint {
  const buf = Buffer.from(stripHex(hex), "hex");
  return buf.length >= 8 ? buf.readBigUInt64LE() : 0n;
}
export function decodeI64(hex: string): bigint {
  const buf = Buffer.from(stripHex(hex), "hex");
  return buf.length >= 8 ? buf.readBigInt64LE() : 0n;
}
export function decodeU128(hex: string): bigint {
  const buf = Buffer.from(stripHex(hex), "hex");
  if (buf.length < 16) return 0n;
  return buf.readBigUInt64LE(0) | (buf.readBigUInt64LE(8) << 64n);
}
export function decodeU256(hex: string): bigint {
  const buf = Buffer.from(stripHex(hex), "hex");
  if (buf.length < 32) return 0n;
  let val = 0n;
  for (let i = 0; i < 4; i++) val |= buf.readBigUInt64LE(i * 8) << BigInt(i * 64);
  return val;
}
export function decodeBool(hex: string): boolean { return decodeU64(hex) !== 0n; }
export function decodeAddress(hex: string): string {
  const buf = Buffer.from(stripHex(hex), "hex");
  return buf.length >= 32 ? "0x" + buf.subarray(0, 32).toString("hex") : "0x" + "00".repeat(32);
}
export function decodeString(hex: string): string {
  const buf = Buffer.from(stripHex(hex), "hex");
  if (buf.length < 8) return "";
  const len = Number(buf.readBigUInt64LE());
  return buf.length >= 8 + len ? buf.subarray(8, 8 + len).toString("utf-8") : "";
}

function stripHex(s: string): string {
  return s.startsWith("0x") ? s.slice(2) : s;
}
