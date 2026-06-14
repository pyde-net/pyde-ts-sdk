/**
 * Contract interaction — ABI-aware read/write/event surface.
 *
 * Spec sources:
 *   - HOST_FN_ABI_SPEC §3.7  — `pyde.abi` custom-section ContractAbi shape
 *   - SDK_AUTHOR_GUIDE       — Borsh-canonical calldata + return encoding
 *   - HOST_FN_ABI_SPEC §14   — event encoding (topics + data)
 *
 * Runtime: isomorphic. All byte handling uses `Uint8Array` with `DataView`
 * for the little-endian reads/writes Borsh requires. No Node `Buffer`
 * dependency on the hot path — the SDK runs unchanged in browsers,
 * Workers, Cloudflare Workers, Deno, and Bun.
 *
 * File-based factory methods (`Contract.fromArtifact`,
 * `Interface.fromArtifact`, `DeployData.fromArtifact`) are Node-only —
 * they dynamic-import `node:fs`. Browser callers should use
 * `Contract.fromJson` / `Interface.fromJson` / `DeployData.fromJson`
 * with their own file loading.
 */

import { computeSelector } from "./crypto";
import { Provider } from "./provider";
import { Wallet } from "./wallet";
import { TxType } from "./types";
import type { Receipt } from "./types";

// ============================================================================
// Byte helpers — isomorphic Uint8Array + DataView replacements for the
// Node `Buffer` API surfaces this module used pre-refactor. Internal —
// not re-exported.
// ============================================================================

const TEXT_ENC = new TextEncoder();
const TEXT_DEC = new TextDecoder("utf-8");

function bytesFromHex(hex: string): Uint8Array {
  const h = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (h.length % 2 !== 0) throw new Error(`hex string has odd length: ${hex.slice(0, 16)}…`);
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesFromUtf8(s: string): Uint8Array {
  return TEXT_ENC.encode(s);
}

function bytesToHex(b: Uint8Array): string {
  let out = "";
  for (let i = 0; i < b.length; i++) out += (b[i] ?? 0).toString(16).padStart(2, "0");
  return out;
}

function bytesToUtf8(b: Uint8Array): string {
  return TEXT_DEC.decode(b);
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function viewOf(b: Uint8Array): DataView {
  return new DataView(b.buffer, b.byteOffset, b.byteLength);
}

function writeU32LE(b: Uint8Array, offset: number, v: number): void {
  viewOf(b).setUint32(offset, v, true);
}

function writeU64LE(b: Uint8Array, offset: number, v: bigint): void {
  viewOf(b).setBigUint64(offset, v, true);
}

function writeI64LE(b: Uint8Array, offset: number, v: bigint): void {
  viewOf(b).setBigInt64(offset, v, true);
}

function readU64LE(b: Uint8Array, offset: number): bigint {
  return viewOf(b).getBigUint64(offset, true);
}

function readI64LE(b: Uint8Array, offset: number): bigint {
  return viewOf(b).getBigInt64(offset, true);
}

/** Receipt from a Contract.write() call — extends Receipt with ABI-aware decoding. */
export interface ContractReceipt extends Receipt {
  /** Decode returnData using the ABI return type. Returns null if returnData is absent.
   * Note: returnData is ephemeral — only available right after tx execution. */
  decodeReturnData(): any;
}

// ============================================================================
// ABI types (parsed from artifact JSON)
// ============================================================================

interface AbiFunction {
  name: string;
  selector: string;
  params: AbiParam[];
  returns: string;
  view: boolean;
  payable: boolean;
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

interface AbiEvent {
  name: string;
  fields: AbiEventField[];
}

interface AbiEventField {
  name: string;
  type: string;
  indexed: boolean;
}

/** Decoded event log with named args. */
export interface EventLog {
  /** Event name (e.g., "Transfer"). */
  name: string;
  /** Decoded event arguments as named fields. */
  args: Record<string, any>;
  /** Raw log data. */
  log: import("./types").Log;
}

// ============================================================================
// Range constants (allocated once, not per-call)
// ============================================================================

const INT_RANGES: Record<string, [bigint, bigint]> = {
  u8: [0n, 255n], u16: [0n, 65535n], u32: [0n, 4294967295n], u64: [0n, 18446744073709551615n],
  i8: [-128n, 127n], i16: [-32768n, 32767n], i32: [-2147483648n, 2147483647n], i64: [-9223372036854775808n, 9223372036854775807n],
};

const WIDE_RANGES: Record<string, [bigint, bigint]> = {
  u128: [0n, (1n << 128n) - 1n], i128: [-(1n << 127n), (1n << 127n) - 1n],
  u256: [0n, (1n << 256n) - 1n], i256: [-(1n << 255n), (1n << 255n) - 1n],
};

// ============================================================================
// Contract — ABI-aware interface
// ============================================================================

/** ABI-aware contract interface with validation and auto-encoding. */
export class Contract {
  readonly address: string;
  readonly provider: Provider;
  private wallet: Wallet | null = null;
  private functions: Map<string, AbiFunction> = new Map();
  private events: Map<string, AbiEvent> = new Map();
  private eventsByTopic: Map<string, AbiEvent> = new Map();
  private structs: Map<string, AbiStructDef> = new Map();
  private enums: Map<string, AbiEnumDef> = new Map();

  private constructor(address: string, provider: Provider) {
    this.address = address;
    this.provider = provider;
  }

  /** Load contract from a build artifact JSON file (Node-only). */
  static async fromArtifact(artifactPath: string, address: string, provider: Provider): Promise<Contract> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = await loadNodeFs("fromArtifact");
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

    // Parse event definitions
    for (const ev of abi.events || []) {
      contract.events.set(ev.name, ev);
      // topic[0] = FNV-1a selector of event name, stored as LE u32 zero-padded to 32 bytes
      const sel = computeSelector(ev.name);
      const selBuf = new Uint8Array(4);
      writeU32LE(selBuf, 0, sel);
      const topic0 = "0x" + bytesToHex(selBuf) + "0".repeat(56);
      contract.eventsByTopic.set(topic0, ev);
    }

    return contract;
  }

  /** Create a minimal contract (no ABI, manual function registration). */
  static create(address: string, provider: Provider): Contract {
    return new Contract(address, provider);
  }

  /** Register a function manually (when no artifact is available). */
  addFunction(name: string, params: AbiParam[], returns: string, view = false, payable = false): this {
    this.functions.set(name, {
      name,
      selector: "0x" + computeSelector(name).toString(16).padStart(8, "0"),
      params,
      returns,
      view,
      payable,
      constructor: false,
    });
    return this;
  }

  /** Bind a wallet for write operations. Returns a new Contract instance. */
  connect(wallet: Wallet): Contract {
    const c = new Contract(this.address, this.provider);
    c.wallet = wallet;
    c.functions = this.functions;
    c.events = this.events;
    c.eventsByTopic = this.eventsByTopic;
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

  /** Static-call ANY function (view or setter) without sending a tx.
   * Simulates execution and returns the decoded return value. */
  async simulate(method: string, args: Record<string, any> = {}): Promise<any> {
    return this.read(method, args);
  }

  /** Estimate gas for a contract call using the ABI. */
  async estimateGas(method: string, args: Record<string, any> = {}): Promise<number> {
    const calldata = this.encodeCall(method, args);
    return this.provider.estimateGas(this.address, calldata);
  }

  // ========================================================================
  // Write (state-changing — wallet required)
  // ========================================================================

  /** Send a state-changing transaction. Auto-encodes args, signs, sends, waits.
   * Pass options.value to send native tokens (validates payable from ABI).
   * Returns a ContractReceipt with a decodeReturnData() method. */
  async write(
    method: string,
    args: Record<string, any> = {},
    options: { gasLimit?: number; value?: bigint | number | string } = {},
  ): Promise<ContractReceipt> {
    if (!this.wallet) {
      throw new Error("No wallet connected. Use contract.connect(wallet) first.");
    }
    const value = options.value ?? 0;
    const gasLimit = options.gasLimit ?? 100_000_000;
    // Validate payable
    if (BigInt(value) > 0n) {
      const fn = this.functions.get(method);
      if (fn && !fn.payable) {
        throw new Error(`${method}() is not payable — cannot send value`);
      }
    }
    const calldata = this.encodeCall(method, args);
    const receipt = await this.wallet.sendCall(this.address, calldata, {
      provider: this.provider,
      gasLimit,
      value,
    });

    // Wrap with ABI-aware decode
    const fn = this.functions.get(method);
    const retType = fn?.returns;
    const contract = this;
    return Object.assign(receipt, {
      decodeReturnData(): any {
        const rd = receipt.returnData;
        if (!rd || rd === "0x" || rd === "") return null;
        if (!retType || retType === "()" || retType === "unit") return null;
        return contract.decodeReturn(retType, rd);
      },
    });
  }

  // ========================================================================
  // Populate (build unsigned tx without sending)
  // ========================================================================

  /**
   * Build an unsigned transaction for a contract call. Useful for multisig,
   * offline signing, or transaction review.
   *
   * ```ts
   * const tx = await contract.populateTransaction("deposit", { amount: 500 });
   * console.log(tx.to, tx.data, tx.nonce); // review before signing
   * ```
   */
  async populateTransaction(
    method: string,
    args: Record<string, any> = {},
    options: { gasLimit?: number; value?: bigint | number | string } = {},
  ): Promise<import("./types").TxFields> {
    if (!this.wallet) throw new Error("No wallet connected. Use contract.connect(wallet) first.");
    const calldata = this.encodeCall(method, args);
    const [nonce, chainId] = await this.provider.getNonceAndChainId(this.wallet.address);
    return {
      from: this.wallet.address,
      to: this.address,
      value: (options.value ?? 0).toString(),
      data: calldata,
      gasLimit: options.gasLimit ?? 100_000_000,
      nonce,
      chainId,
      txType: TxType.Standard,
    };
  }

  // ========================================================================
  // Events
  // ========================================================================

  /**
   * Query historical event logs, decoded into typed EventLog objects.
   *
   * ```ts
   * const transfers = await contract.queryFilter("Transfer", 0, 1000);
   * for (const e of transfers) {
   * console.log(e.name, e.args.from, e.args.to, e.args.amount);
   * }
   * ```
   */
  async queryFilter(eventName: string, fromWave?: number, toWave?: number): Promise<EventLog[]> {
    const ev = this.events.get(eventName);
    if (!ev) throw new Error(`Unknown event '${eventName}'. Load ABI with events.`);

    const topic0 = this.getEventTopic(eventName);

    // Phase 8 will resolve omitted bounds via Provider.getWave() ("latest");
    // for now the caller passes explicit bounds per HOST_FN_ABI §15.4
    // (5,000-wave cap per request).
    const response = await this.provider.getLogs({
      contract: this.address,
      fromWave: fromWave ?? 0,
      toWave: toWave ?? 0,
      topics: [[topic0]],
    });

    return response.events.map((log) => this.decodeEventLog(ev, log));
  }

  /**
   * Parse a raw Log into a decoded EventLog. Returns null if the event is unknown.
   *
   * ```ts
   * const decoded = contract.parseLog(rawLog);
   * if (decoded) console.log(decoded.name, decoded.args);
   * ```
   */
  parseLog(log: import("./types").Log): EventLog | null {
    if (!log.topics || log.topics.length === 0) return null;
    const ev = this.eventsByTopic.get(log.topics[0]!);
    if (!ev) return null;
    return this.decodeEventLog(ev, log);
  }

  /** Get the topic0 hash for an event name (for building custom filters). */
  getEventTopic(eventName: string): string {
    const sel = computeSelector(eventName);
    const buf = new Uint8Array(4);
    writeU32LE(buf, 0, sel);
    return "0x" + bytesToHex(buf) + "0".repeat(56);
  }

  private decodeEventLog(ev: AbiEvent, log: import("./types").Log): EventLog {
    const args: Record<string, any> = {};
    const data = log.data ? bytesFromHex(log.data) : new Uint8Array(0);

    // Non-indexed fields are in data, 8 bytes each (GP register width)
    let dataOffset = 0;
    for (const field of ev.fields) {
      if (!field.indexed) {
        if (dataOffset + 8 <= data.length) {
          const { value, bytesRead } = this.decodeValue(data, field.type, dataOffset);
          args[field.name] = value;
          dataOffset += bytesRead;
        }
      }
    }

    // Indexed fields are in topics[1], topics[2], etc.
    let topicIdx = 1;
    for (const field of ev.fields) {
      if (field.indexed && topicIdx < log.topics.length) {
        const topicBuf = bytesFromHex(log.topics[topicIdx]!);
        if (field.type === "Address") {
          args[field.name] = "0x" + bytesToHex(topicBuf.subarray(0, 32));
        } else {
          const { value } = this.decodeValue(topicBuf, field.type, 0);
          args[field.name] = value;
        }
        topicIdx++;
      }
    }

    return { name: ev.name, args, log };
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

    return "0x" + bytesToHex(new Uint8Array(buf));
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
      const b = new Uint8Array(8);
      if (type.startsWith("i")) {
        writeI64LE(b, 0, n);
      } else {
        writeU64LE(b, 0, n);
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
      this.validateWideRange(n, type, path);
      // Two's complement: mask to 128 bits so negative values encode correctly
      const unsigned = n & ((1n << 128n) - 1n);
      const b = new Uint8Array(16);
      writeU64LE(b, 0, unsigned & 0xFFFFFFFFFFFFFFFFn);
      writeU64LE(b, 8, (unsigned >> 64n) & 0xFFFFFFFFFFFFFFFFn);
      buf.push(...b);
      return;
    }

    // u256/i256 (32 bytes LE)
    if (type === "u256" || type === "i256") {
      if (typeof value !== "bigint" && typeof value !== "number") {
        throw new Error(`${path}: expected ${type}, got ${typeof value}`);
      }
      const n = BigInt(value);
      this.validateWideRange(n, type, path);
      // Two's complement: mask to 256 bits so negative values encode correctly
      const unsigned = n & ((1n << 256n) - 1n);
      const b = new Uint8Array(32);
      for (let i = 0; i < 4; i++) {
        writeU64LE(b, i * 8, (unsigned >> BigInt(i * 64)) & 0xFFFFFFFFFFFFFFFFn);
      }
      buf.push(...b);
      return;
    }

    // bool
    if (type === "bool") {
      if (typeof value !== "boolean") {
        throw new Error(`${path}: expected bool, got ${typeof value}`);
      }
      const b = new Uint8Array(8);
      writeU64LE(b, 0, value ? 1n : 0n);
      buf.push(...b);
      return;
    }

    // Address (32 bytes)
    if (type === "Address") {
      if (typeof value !== "string") {
        throw new Error(`${path}: expected Address (hex string), got ${typeof value}`);
      }
      const hex = value.startsWith("0x") ? value.slice(2) : value;
      if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
        throw new Error(`${path}: Address must be 64 hex chars (0-9, a-f), got "${hex.length > 20 ? hex.slice(0, 20) + "..." : hex}"`);
      }
      buf.push(...bytesFromHex(hex));
      return;
    }

    // String
    if (type === "String") {
      if (typeof value !== "string") {
        throw new Error(`${path}: expected String, got ${typeof value}`);
      }
      const bytes = bytesFromUtf8(value);
      const lenBuf = new Uint8Array(8);
      writeU64LE(lenBuf, 0, BigInt(bytes.length));
      buf.push(...lenBuf, ...bytes);
      const pad = (8 - (bytes.length % 8)) % 8;
      for (let i = 0; i < pad; i++) buf.push(0);
      return;
    }

    // Bytes (length-prefixed, 8-byte aligned)
    if (type === "Bytes" || type === "bytes") {
      if (!(value instanceof Uint8Array)) {
        throw new Error(`${path}: expected Uint8Array for ${type}, got ${typeof value}`);
      }
      const bytes = value;
      const lenBuf = new Uint8Array(8);
      writeU64LE(lenBuf, 0, BigInt(bytes.length));
      buf.push(...lenBuf, ...bytes);
      const pad = (8 - (bytes.length % 8)) % 8;
      for (let i = 0; i < pad; i++) buf.push(0);
      return;
    }

    // Tuple "(T1, T2, ...)" — sequential fields, no length prefix
    if (type.startsWith("(") && type.endsWith(")")) {
      const inner = type.slice(1, -1);
      if (inner && inner !== "()") {
        const types = parseTupleTypes(inner);
        if (!Array.isArray(value)) {
          throw new Error(`${path}: expected array for tuple ${type}, got ${typeof value}`);
        }
        if (value.length !== types.length) {
          throw new Error(`${path}: tuple ${type} expects ${types.length} elements, got ${value.length}`);
        }
        for (let i = 0; i < types.length; i++) {
          this.encodeValue(buf, value[i], types[i]!, `${path}.${i}`);
        }
      }
      return;
    }

    // Array "[T; N]" — N sequential elements, no length prefix
    if (type.startsWith("[") && type.endsWith("]")) {
      const parsed = parseArrayType(type.slice(1, -1));
      if (!parsed) throw new Error(`${path}: bad array type '${type}'`);
      const [elemType, count] = parsed;
      if (!Array.isArray(value)) {
        throw new Error(`${path}: expected array for ${type}, got ${typeof value}`);
      }
      if (value.length !== count) {
        throw new Error(`${path}: array ${type} expects ${count} elements, got ${value.length}`);
      }
      for (let i = 0; i < count; i++) {
        this.encodeValue(buf, value[i], elemType, `${path}[${i}]`);
      }
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
      const header = new Uint8Array(24);
      writeU64LE(header, 0, BigInt(dataLen));
      writeU64LE(header, 8, BigInt(value.length));
      writeU64LE(header, 16, BigInt(value.length));
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
      const lenBuf = new Uint8Array(8);
      writeU64LE(lenBuf, 0, BigInt(fieldBuf.length));
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
      const b = new Uint8Array(8);
      writeU64LE(b, 0, BigInt(disc));
      buf.push(...b);
      return;
    }

    // Unknown type (Contract/Interface) → treat as Address
    if (typeof value === "string") {
      const hex = value.startsWith("0x") ? value.slice(2) : value;
      if (/^[0-9a-fA-F]{64}$/.test(hex)) {
        buf.push(...bytesFromHex(hex));
        return;
      }
    }

    throw new Error(`${path}: unsupported type '${type}'`);
  }

  private validateIntRange(n: bigint, type: string, path: string): void {
    const range = INT_RANGES[type];
    if (range && (n < range[0] || n > range[1])) {
      throw new Error(`${path}: value ${n} out of range for ${type} (${range[0]} to ${range[1]})`);
    }
  }

  private validateWideRange(n: bigint, type: string, path: string): void {
    const range = WIDE_RANGES[type];
    if (range && (n < range[0] || n > range[1])) {
      throw new Error(`${path}: value out of range for ${type}`);
    }
  }

  // ========================================================================
  // Decoding — return hex to values
  // ========================================================================

  private decodeReturn(type: string, hex: string): any {
    const data = bytesFromHex(hex);
    return this.decodeValue(data, type, 0).value;
  }

  private decodeValue(data: Uint8Array, type: string, offset: number): { value: any; bytesRead: number } {
    if (["u8", "u16", "u32", "u64"].includes(type)) {
      if (data.length < offset + 8) return { value: 0n, bytesRead: 8 };
      return { value: readU64LE(data,offset), bytesRead: 8 };
    }
    if (["i8", "i16", "i32", "i64"].includes(type)) {
      if (data.length < offset + 8) return { value: 0n, bytesRead: 8 };
      return { value: readI64LE(data,offset), bytesRead: 8 };
    }
    if (type === "u128") {
      if (data.length < offset + 16) return { value: 0n, bytesRead: 16 };
      const lo = readU64LE(data,offset);
      const hi = readU64LE(data,offset + 8);
      return { value: lo | (hi << 64n), bytesRead: 16 };
    }
    if (type === "i128") {
      if (data.length < offset + 16) return { value: 0n, bytesRead: 16 };
      const lo = readU64LE(data,offset);
      const hi = readU64LE(data,offset + 8);
      let val = lo | (hi << 64n);
      if (val >= (1n << 127n)) val -= (1n << 128n);
      return { value: val, bytesRead: 16 };
    }
    if (type === "u256") {
      if (data.length < offset + 32) return { value: 0n, bytesRead: 32 };
      let val = 0n;
      for (let i = 0; i < 4; i++) {
        val |= readU64LE(data,offset + i * 8) << BigInt(i * 64);
      }
      return { value: val, bytesRead: 32 };
    }
    if (type === "i256") {
      if (data.length < offset + 32) return { value: 0n, bytesRead: 32 };
      let val = 0n;
      for (let i = 0; i < 4; i++) {
        val |= readU64LE(data,offset + i * 8) << BigInt(i * 64);
      }
      if (val >= (1n << 255n)) val -= (1n << 256n);
      return { value: val, bytesRead: 32 };
    }
    if (type === "bool") {
      if (data.length < offset + 8) return { value: false, bytesRead: 8 };
      return { value: readU64LE(data,offset) !== 0n, bytesRead: 8 };
    }
    if (type === "Address") {
      // Full 32-byte address if available; otherwise read what's available
      // (PVM event data may use 8-byte GP register format for Address fields)
      if (data.length >= offset + 32) {
        return { value: "0x" + bytesToHex(data.subarray(offset, offset + 32)), bytesRead: 32 };
      }
      if (data.length >= offset + 8) {
        // Compact GP format: 8 bytes (truncated address or pointer)
        const partial = bytesToHex(data.subarray(offset, offset + 8));
        return { value: "0x" + partial.padEnd(64, "0"), bytesRead: 8 };
      }
      return { value: "0x" + "00".repeat(32), bytesRead: 8 };
    }
    if (type === "String") {
      if (data.length < offset + 8) return { value: "", bytesRead: 8 };
      const len = Number(readU64LE(data,offset));
      if (data.length < offset + 8 + len) return { value: "", bytesRead: 8 };
      const str = bytesToUtf8(data.subarray(offset + 8, offset + 8 + len));
      const aligned = 8 + len + ((8 - (len % 8)) % 8);
      return { value: str, bytesRead: aligned };
    }
    if (type === "Bytes" || type === "bytes") {
      if (data.length < offset + 8) return { value: new Uint8Array(0), bytesRead: 8 };
      const len = Number(readU64LE(data,offset));
      if (data.length < offset + 8 + len) return { value: new Uint8Array(0), bytesRead: 8 };
      const bytes = data.subarray(offset + 8, offset + 8 + len);
      const aligned = 8 + len + ((8 - (len % 8)) % 8);
      return { value: bytes, bytesRead: aligned };
    }
    // Tuple "(T1, T2, ...)" — sequential decode
    if (type.startsWith("(") && type.endsWith(")")) {
      const inner = type.slice(1, -1);
      if (!inner || inner === "()") return { value: null, bytesRead: 0 };
      const types = parseTupleTypes(inner);
      let cursor = offset;
      const items: any[] = [];
      for (const t of types) {
        const { value, bytesRead } = this.decodeValue(data, t, cursor);
        items.push(value);
        cursor += bytesRead;
      }
      return { value: items, bytesRead: cursor - offset };
    }
    // Array "[T; N]" — N sequential elements
    if (type.startsWith("[") && type.endsWith("]")) {
      const parsed = parseArrayType(type.slice(1, -1));
      if (parsed) {
        const [elemType, count] = parsed;
        let cursor = offset;
        const items: any[] = [];
        for (let i = 0; i < count; i++) {
          if (cursor >= data.length) break;
          const { value, bytesRead } = this.decodeValue(data, elemType, cursor);
          items.push(value);
          cursor += bytesRead;
        }
        return { value: items, bytesRead: cursor - offset };
      }
    }
    if (type.startsWith("Vec<") && type.endsWith(">")) {
      const elemType = type.slice(4, -1);
      if (data.length < offset + 24) return { value: [], bytesRead: 24 };
      const byteLen = Number(readU64LE(data,offset));
      const count = Number(readU64LE(data,offset + 8));
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
      const byteLen = Number(readU64LE(data,offset));
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
      const disc = Number(readU64LE(data,offset));
      const variant = enumDef.variants.find(v => v.discriminant === disc);
      return { value: variant?.name || disc, bytesRead: 8 };
    }

    if (type === "()" || type === "unit") {
      return { value: null, bytesRead: 0 };
    }

    // Unknown type (Contract/Interface) → decode as Address (32 bytes)
    if (data.length >= offset + 32) {
      return { value: "0x" + bytesToHex(data.subarray(offset, offset + 32)), bytesRead: 32 };
    }

    return { value: "0x" + bytesToHex(data.subarray(offset)), bytesRead: data.length - offset };
  }
}

// ============================================================================
// ContractCall — low-level builder (still available for manual use)
// ============================================================================

/** Low-level calldata builder. For most cases, use Contract.read/write instead. */
// ============================================================================
// Interface — standalone ABI encoder/decoder (no contract instance needed)
// ============================================================================

/**
 * Standalone ABI encoder/decoder. Use when you need to encode/decode without
 * a contract address or provider.
 *
 * ```ts
 * const iface = Interface.fromArtifact("out/Counter.json");
 * const calldata = iface.encodeFunctionData("deposit", { amount: 500 });
 * const result = iface.decodeFunctionResult("get_count", "0x2a00000000000000");
 * ```
 */
export class Interface {
  private contract: Contract;

  private constructor(contract: Contract) {
    this.contract = contract;
  }

  /** Load from a build artifact JSON file (Node-only). */
  static async fromArtifact(artifactPath: string): Promise<Interface> {
    const fs = await loadNodeFs("fromArtifact");
    const json = fs.readFileSync(artifactPath, "utf-8");
    return Interface.fromJson(json);
  }

  /** Load from ABI JSON string. */
  static fromJson(json: string): Interface {
    const contract = Contract.fromJson(json, "0x" + "00".repeat(32), null as any);
    return new Interface(contract);
  }

  /** Encode a function call to calldata hex. */
  encodeFunctionData(method: string, args: Record<string, any> = {}): string {
    return this.contract.encodeCall(method, args);
  }

  /** Decode function return data using the ABI return type. */
  decodeFunctionResult(method: string, data: string): any {
    const fn = (this.contract as any).functions.get(method);
    if (!fn) throw new Error(`Unknown function '${method}'.`);
    return (this.contract as any).decodeReturn(fn.returns, data);
  }

  /** Parse a raw Log into a decoded EventLog. */
  parseLog(log: import("./types").Log): EventLog | null {
    return this.contract.parseLog(log);
  }

  /** Get the topic0 hash for an event name. */
  getEventTopic(eventName: string): string {
    return this.contract.getEventTopic(eventName);
  }
}

export class ContractCall {
  private selector: number;
  private _parts: Uint8Array[] = [];
  readonly methodName: string;

  constructor(method: string) {
    this.methodName = method;
    this.selector = computeSelector(method);
  }

  get _args(): Uint8Array { return concatBytes(this._parts); }
  get args(): Uint8Array { return this._args; }

  private push(buf: Uint8Array): void { this._parts.push(buf); }

  /** Unsigned 8-bit integer. Range: 0 to 255. Encoded as 8 bytes LE (zero-extended). */
  argU8(val: number): this {
    if (val < 0 || val > 255) throw new RangeError(`argU8: ${val} out of range (0 to 255)`);
    return this.argU64(val);
  }
  /** Unsigned 16-bit integer. Range: 0 to 65,535. Encoded as 8 bytes LE. */
  argU16(val: number): this {
    if (val < 0 || val > 65535) throw new RangeError(`argU16: ${val} out of range (0 to 65535)`);
    return this.argU64(val);
  }
  /** Unsigned 32-bit integer. Range: 0 to 4,294,967,295. Encoded as 8 bytes LE. */
  argU32(val: number): this {
    if (val < 0 || val > 4294967295) throw new RangeError(`argU32: ${val} out of range (0 to 4294967295)`);
    return this.argU64(val);
  }
  /** Unsigned 64-bit integer. Range: 0 to 18,446,744,073,709,551,615. Encoded as 8 bytes LE. */
  argU64(val: number | bigint): this {
    const buf = new Uint8Array(8);
    writeU64LE(buf, 0, BigInt(val));
    this.push(buf);
    return this;
  }
  /** Signed 8-bit integer. Range: -128 to 127. Sign-extended to 8 bytes LE. */
  argI8(val: number): this {
    if (val < -128 || val > 127) throw new RangeError(`argI8: ${val} out of range (-128 to 127)`);
    return this.argI64(BigInt(val));
  }
  /** Signed 16-bit integer. Range: -32,768 to 32,767. Sign-extended to 8 bytes LE. */
  argI16(val: number): this {
    if (val < -32768 || val > 32767) throw new RangeError(`argI16: ${val} out of range (-32768 to 32767)`);
    return this.argI64(BigInt(val));
  }
  /** Signed 32-bit integer. Range: -2,147,483,648 to 2,147,483,647. Sign-extended to 8 bytes LE. */
  argI32(val: number): this {
    if (val < -2147483648 || val > 2147483647) throw new RangeError(`argI32: ${val} out of range (-2147483648 to 2147483647)`);
    return this.argI64(BigInt(val));
  }
  /** Signed 64-bit integer. Range: -9,223,372,036,854,775,808 to 9,223,372,036,854,775,807. Encoded as 8 bytes LE (two's complement). */
  argI64(val: number | bigint): this {
    const buf = new Uint8Array(8);
    writeI64LE(buf, 0, BigInt(val));
    this.push(buf);
    return this;
  }
  /** Boolean. Encoded as u64: true = 1, false = 0. */
  argBool(val: boolean): this { return this.argU64(val ? 1 : 0); }
  /** Unsigned 128-bit integer. Range: 0 to 2^128 - 1. Encoded as 16 bytes LE. */
  argU128(val: bigint): this {
    if (val < 0n || val >= (1n << 128n)) throw new RangeError("argU128: value out of range");
    const buf = new Uint8Array(16);
    writeU64LE(buf, 0, val & 0xFFFFFFFFFFFFFFFFn);
    writeU64LE(buf, 8, (val >> 64n) & 0xFFFFFFFFFFFFFFFFn);
    this.push(buf);
    return this;
  }
  /** Signed 128-bit integer. Range: -2^127 to 2^127 - 1. Encoded as 16 bytes LE (two's complement). */
  argI128(val: bigint): this {
    if (val < -(1n << 127n) || val >= (1n << 127n)) throw new RangeError("argI128: value out of range");
    const unsigned = val & ((1n << 128n) - 1n);
    const buf = new Uint8Array(16);
    writeU64LE(buf, 0, unsigned & 0xFFFFFFFFFFFFFFFFn);
    writeU64LE(buf, 8, (unsigned >> 64n) & 0xFFFFFFFFFFFFFFFFn);
    this.push(buf);
    return this;
  }
  /** Unsigned 256-bit integer. Range: 0 to 2^256 - 1. Encoded as 32 bytes LE. */
  argU256(val: bigint): this {
    if (val < 0n || val >= (1n << 256n)) throw new RangeError("argU256: value out of range");
    const buf = new Uint8Array(32);
    for (let i = 0; i < 4; i++) {
      writeU64LE(buf, i * 8, (val >> BigInt(i * 64)) & 0xFFFFFFFFFFFFFFFFn);
    }
    this.push(buf);
    return this;
  }
  /** Signed 256-bit integer. Range: -2^255 to 2^255 - 1. Encoded as 32 bytes LE (two's complement). */
  argI256(val: bigint): this {
    if (val < -(1n << 255n) || val >= (1n << 255n)) throw new RangeError("argI256: value out of range");
    const unsigned = val & ((1n << 256n) - 1n);
    const buf = new Uint8Array(32);
    for (let i = 0; i < 4; i++) {
      writeU64LE(buf, i * 8, (unsigned >> BigInt(i * 64)) & 0xFFFFFFFFFFFFFFFFn);
    }
    this.push(buf);
    return this;
  }
  /** 32-byte address. Validates hex length. */
  argAddress(hex: string): this {
    const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
    if (!/^[0-9a-fA-F]{64}$/.test(clean)) {
      throw new Error(`argAddress: expected 64 hex chars, got "${clean.length > 20 ? clean.slice(0, 20) + "..." : clean}"`);
    }
    this.push(bytesFromHex(clean));
    return this;
  }
  /** Length-prefixed string (8-byte aligned). */
  argString(val: string): this {
    const bytes = bytesFromUtf8(val);
    const lenBuf = new Uint8Array(8);
    writeU64LE(lenBuf, 0, BigInt(bytes.length));
    const padding = (8 - (bytes.length % 8)) % 8;
    this.push(lenBuf); this.push(bytes); if (padding > 0) this.push(new Uint8Array(padding));
    return this;
  }
  /** Raw bytes appended directly (no length prefix). */
  argBytes(data: Uint8Array): this {
    this.push(data);
    return this;
  }

  // ========================================================================
  // Vec builders
  // ========================================================================

  /** Vec<u64>: [byte_len:8][count:8][cap:8][elements...] */
  argVecU64(vals: (number | bigint)[]): this {
    const dataLen = 16 + vals.length * 8;
    const header = new Uint8Array(24);
    writeU64LE(header, 0, BigInt(dataLen));
    writeU64LE(header, 8, BigInt(vals.length));
    writeU64LE(header, 16, BigInt(vals.length));
    const elems = new Uint8Array(vals.length * 8);
    for (let i = 0; i < vals.length; i++) writeU64LE(elems, i * 8, BigInt(vals[i]!));
    this.push(header); this.push(elems);
    return this;
  }
  /** Vec<bool>: encoded as Vec<u64>. */
  argVecBool(vals: boolean[]): this {
    return this.argVecU64(vals.map(b => b ? 1 : 0));
  }
  /** Vec<Address>: [byte_len:8][count:8][cap:8][addr0:32][addr1:32]... */
  argVecAddress(vals: string[]): this {
    const dataLen = 16 + vals.length * 32;
    const header = new Uint8Array(24);
    writeU64LE(header, 0, BigInt(dataLen));
    writeU64LE(header, 8, BigInt(vals.length));
    writeU64LE(header, 16, BigInt(vals.length));
    const elems: Uint8Array[] = vals.map(hex => {
      const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
      if (clean.length !== 64) throw new Error(`argVecAddress: expected 64 hex chars per address`);
      return bytesFromHex(clean);
    });
    this.push(header); for (const e of elems) this.push(e);
    return this;
  }
  /**
   * Generic Vec: [byte_len:8][count:8][cap:8][elements...].
   * Build elements using a callback that receives a fresh ContractCall.
   *
   * ```ts
   * // Vec<String>
   * .argVecOf(2, b => b.argString("alice").argString("bob"))
   * // Vec<Struct>
   * .argVecOf(2, b => b
   * .argStruct(s => s.argString("alice").argU64(25))
   * .argStruct(s => s.argString("bob").argU64(30)))
   * ```
   */
  argVecOf(count: number, buildFn: (b: ContractCall) => ContractCall): this {
    const inner = buildFn(new ContractCall("_vec_"));
    const elements = inner._args;
    const dataLen = 16 + elements.length;
    const header = new Uint8Array(24);
    writeU64LE(header, 0, BigInt(dataLen));
    writeU64LE(header, 8, BigInt(count));
    writeU64LE(header, 16, BigInt(count));
    this.push(header); this.push(elements);
    return this;
  }

  // ========================================================================
  // Struct / Tuple builders
  // ========================================================================

  /**
   * Struct: [byte_len:8][field0][field1]...
   * Build fields using a callback.
   *
   * ```ts
   * .argStruct(s => s.argString("alice").argU64(25).argBool(true))
   * ```
   */
  argStruct(buildFn: (b: ContractCall) => ContractCall): this {
    const inner = buildFn(new ContractCall("_struct_"));
    const fields = inner._args;
    const lenBuf = new Uint8Array(8);
    writeU64LE(lenBuf, 0, BigInt(fields.length));
    this.push(lenBuf); this.push(fields);
    return this;
  }
  /**
   * Tuple: sequential fields, no length prefix.
   *
   * ```ts
   * .argTuple(t => t.argU64(1).argString("one"))
   * ```
   */
  argTuple(buildFn: (b: ContractCall) => ContractCall): this {
    const inner = buildFn(new ContractCall("_tuple_"));
    this.push(inner._args);
    return this;
  }

  build(): string {
    const sel = new Uint8Array(4);
    new DataView(sel.buffer, sel.byteOffset, sel.byteLength).setUint32(0, this.selector, false);
    const full = concatBytes([sel, this._args]);
    return "0x" + bytesToHex(full);
  }
}

// ============================================================================
// Standalone decoders (for manual use)
// ============================================================================

export function decodeU64(hex: string): bigint {
  const buf = bytesFromHex(hex);
  return buf.length >= 8 ? readU64LE(buf, 0) : 0n;
}
export function decodeI64(hex: string): bigint {
  const buf = bytesFromHex(hex);
  return buf.length >= 8 ? readI64LE(buf, 0) : 0n;
}
export function decodeU128(hex: string): bigint {
  const buf = bytesFromHex(hex);
  if (buf.length < 16) return 0n;
  return readU64LE(buf,0) | (readU64LE(buf,8) << 64n);
}
export function decodeI128(hex: string): bigint {
  const buf = bytesFromHex(hex);
  if (buf.length < 16) return 0n;
  let val = readU64LE(buf,0) | (readU64LE(buf,8) << 64n);
  if (val >= (1n << 127n)) val -= (1n << 128n);
  return val;
}
export function decodeU256(hex: string): bigint {
  const buf = bytesFromHex(hex);
  if (buf.length < 32) return 0n;
  let val = 0n;
  for (let i = 0; i < 4; i++) val |= readU64LE(buf,i * 8) << BigInt(i * 64);
  return val;
}
export function decodeI256(hex: string): bigint {
  const buf = bytesFromHex(hex);
  if (buf.length < 32) return 0n;
  let val = 0n;
  for (let i = 0; i < 4; i++) val |= readU64LE(buf,i * 8) << BigInt(i * 64);
  if (val >= (1n << 255n)) val -= (1n << 256n);
  return val;
}
export function decodeBool(hex: string): boolean { return decodeU64(hex) !== 0n; }
export function decodeAddress(hex: string): string {
  const buf = bytesFromHex(hex);
  return buf.length >= 32 ? "0x" + bytesToHex(buf.subarray(0, 32)) : "0x" + "00".repeat(32);
}
export function decodeString(hex: string): string {
  const buf = bytesFromHex(hex);
  if (buf.length < 8) return "";
  const len = Number(readU64LE(buf, 0));
  if (buf.length < 8 + len) throw new Error(`decodeString: expected ${len} bytes, buffer has ${buf.length - 8}`);
  return bytesToUtf8(buf.subarray(8, 8 + len));
}
export function decodeBytes(hex: string): Uint8Array {
  const buf = bytesFromHex(hex);
  if (buf.length < 8) throw new Error("decodeBytes: buffer too short for length prefix");
  const len = Number(readU64LE(buf, 0));
  if (buf.length < 8 + len) throw new Error(`decodeBytes: expected ${len} bytes, buffer has ${buf.length - 8}`);
  return buf.subarray(8, 8 + len);
}

function stripHex(s: string): string {
  return s.startsWith("0x") ? s.slice(2) : s;
}

/** Parse comma-separated tuple types, handling nested generics. */
function parseTupleTypes(s: string): string[] {
  const types: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "<" || c === "(" || c === "[") depth++;
    else if (c === ">" || c === ")" || c === "]") depth--;
    else if (c === "," && depth === 0) {
      const t = s.slice(start, i).trim();
      if (t) types.push(t);
      start = i + 1;
    }
  }
  const t = s.slice(start).trim();
  if (t) types.push(t);
  return types;
}

/** Parse "[T; N]" inner string → [elementType, count]. */
function parseArrayType(s: string): [string, number] | null {
  const semi = s.lastIndexOf(";");
  if (semi < 0) return null;
  const elem = s.slice(0, semi).trim();
  const count = parseInt(s.slice(semi + 1).trim(), 10);
  if (isNaN(count)) return null;
  return [elem, count];
}

// ============================================================================
// Standalone Vec decoders
// ============================================================================

export function decodeVecU64(hex: string): bigint[] {
  const buf = bytesFromHex(hex);
  if (buf.length < 24) return [];
  const count = Number(readU64LE(buf,8));
  const maxCount = Math.floor((buf.length - 24) / 8);
  const safe = Math.min(count, maxCount);
  const result: bigint[] = [];
  for (let i = 0; i < safe; i++) result.push(readU64LE(buf,24 + i * 8));
  return result;
}

export function decodeVecBool(hex: string): boolean[] {
  return decodeVecU64(hex).map(v => v !== 0n);
}

export function decodeVecAddress(hex: string): string[] {
  const buf = bytesFromHex(hex);
  if (buf.length < 24) return [];
  const count = Number(readU64LE(buf,8));
  const maxCount = Math.floor((buf.length - 24) / 32);
  const safe = Math.min(count, maxCount);
  const result: string[] = [];
  for (let i = 0; i < safe; i++) {
    result.push("0x" + bytesToHex(buf.subarray(24 + i * 32, 24 + (i + 1) * 32)));
  }
  return result;
}

// ============================================================================
// DeployData — build deploy transaction payloads
// ============================================================================

/**
 * Build deploy transaction data: [clen:4 LE][rlen:4 LE][constructor][runtime][args].
 *
 * ```ts
 * // From artifact with named constructor args (recommended)
 * const data = DeployData.fromArtifact("out/Counter.json", {
 * initial_supply: 1000,
 * name: "MyToken",
 * }).build();
 *
 * // From raw bytecodes with manual args
 * const data = new DeployData(constructorHex, runtimeHex)
 * .argU64(1000).build();
 * ```
 */
export class DeployData {
  private constructor_: Uint8Array;
  private runtime: Uint8Array;
  private argsBuf: Uint8Array = new Uint8Array(0);

  constructor(constructorHex: string, runtimeHex: string) {
    this.constructor_ = bytesFromHex(constructorHex);
    this.runtime = bytesFromHex(runtimeHex);
  }

  /** Load from artifact JSON file (Node-only) with ABI-validated
   *  constructor args. Pass `{}` if the constructor takes no args. */
  static async fromArtifact(artifactPath: string, args: Record<string, any> = {}): Promise<DeployData> {
    const fs = await loadNodeFs("fromArtifact");
    const json = fs.readFileSync(artifactPath, "utf-8");
    return DeployData.fromJson(json, args);
  }

  /** Load from artifact JSON string with ABI-validated constructor args. */
  static fromJson(json: string, args: Record<string, any> = {}): DeployData {
    const artifact = JSON.parse(json);
    const constructorHex = artifact.constructorBytecode;
    const runtimeHex = artifact.deployedBytecode;
    if (!constructorHex || !runtimeHex) {
      throw new Error("Artifact missing 'constructorBytecode' or 'deployedBytecode'");
    }
    const deploy = new DeployData(constructorHex, runtimeHex);

    // Encode constructor args from ABI
    const abi = artifact.abi || artifact;
    const fns = abi.functions || [];
    const ctor = fns.find((f: any) => f.constructor === true);
    if (ctor && ctor.params && ctor.params.length > 0) {
      // Use a temporary Contract to leverage encodeValue
      const tempContract = Contract.fromJson(json, "0x" + "00".repeat(32), null as any);
      const buf: number[] = [];
      for (const param of ctor.params) {
        const val = args[param.name];
        if (val === undefined) {
          throw new Error(`constructor: missing arg '${param.name}' (${param.type})`);
        }
        (tempContract as any).encodeValue(buf, val, param.type, `constructor.${param.name}`);
      }
      deploy.argsBuf = concatBytes([deploy.argsBuf, new Uint8Array(buf)]);
    }

    return deploy;
  }

  // GP integers (8 bytes LE)
  argU8(val: number): this { return this.argU64(val); }
  argU16(val: number): this { return this.argU64(val); }
  argU32(val: number): this { return this.argU64(val); }
  argU64(val: number | bigint): this {
    const buf = new Uint8Array(8);
    writeU64LE(buf, 0, BigInt(val));
    this.argsBuf = concatBytes([this.argsBuf, buf]);
    return this;
  }
  argI8(val: number): this { return this.argI64(BigInt(val)); }
  argI16(val: number): this { return this.argI64(BigInt(val)); }
  argI32(val: number): this { return this.argI64(BigInt(val)); }
  argI64(val: number | bigint): this {
    const buf = new Uint8Array(8);
    writeI64LE(buf, 0, BigInt(val));
    this.argsBuf = concatBytes([this.argsBuf, buf]);
    return this;
  }
  argBool(val: boolean): this { return this.argU64(val ? 1 : 0); }
  // Wide integers
  argU128(val: bigint): this {
    const buf = new Uint8Array(16);
    writeU64LE(buf, 0, val & 0xFFFFFFFFFFFFFFFFn);
    writeU64LE(buf, 8, (val >> 64n) & 0xFFFFFFFFFFFFFFFFn);
    this.argsBuf = concatBytes([this.argsBuf, buf]);
    return this;
  }
  argI128(val: bigint): this {
    const unsigned = val & ((1n << 128n) - 1n);
    const buf = new Uint8Array(16);
    writeU64LE(buf, 0, unsigned & 0xFFFFFFFFFFFFFFFFn);
    writeU64LE(buf, 8, (unsigned >> 64n) & 0xFFFFFFFFFFFFFFFFn);
    this.argsBuf = concatBytes([this.argsBuf, buf]);
    return this;
  }
  argU256(val: bigint): this {
    const buf = new Uint8Array(32);
    for (let i = 0; i < 4; i++) writeU64LE(buf, i * 8, (val >> BigInt(i * 64)) & 0xFFFFFFFFFFFFFFFFn);
    this.argsBuf = concatBytes([this.argsBuf, buf]);
    return this;
  }
  argI256(val: bigint): this {
    const unsigned = val & ((1n << 256n) - 1n);
    const buf = new Uint8Array(32);
    for (let i = 0; i < 4; i++) writeU64LE(buf, i * 8, (unsigned >> BigInt(i * 64)) & 0xFFFFFFFFFFFFFFFFn);
    this.argsBuf = concatBytes([this.argsBuf, buf]);
    return this;
  }
  argAddress(hex: string): this {
    const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
    if (!/^[0-9a-fA-F]{64}$/.test(clean)) throw new Error("argAddress: expected 64 hex chars");
    this.argsBuf = concatBytes([this.argsBuf, bytesFromHex(clean)]);
    return this;
  }
  argString(val: string): this {
    const bytes = bytesFromUtf8(val);
    const lenBuf = new Uint8Array(8);
    writeU64LE(lenBuf, 0, BigInt(bytes.length));
    const padding = (8 - (bytes.length % 8)) % 8;
    this.argsBuf = concatBytes([this.argsBuf, lenBuf, bytes, new Uint8Array(padding)]);
    return this;
  }
  argBytes(data: Uint8Array): this {
    this.argsBuf = concatBytes([this.argsBuf, data]);
    return this;
  }

  /** Build: [clen:4 LE][rlen:4 LE][constructor][runtime][args]. Returns hex string. */
  build(): string {
    const header = new Uint8Array(8);
    writeU32LE(header, 0, this.constructor_.length);
    writeU32LE(header, 4, this.runtime.length);
    const full = concatBytes([header, this.constructor_, this.runtime, this.argsBuf]);
    return "0x" + bytesToHex(full);
  }
}

// ============================================================================
// Node-only file I/O (used by `*.fromArtifact` factories)
// ============================================================================

interface NodeFsModule {
  readFileSync(path: string, encoding: "utf-8"): string;
}

async function loadNodeFs(method: string): Promise<NodeFsModule> {
  if (typeof process === "undefined" || !process.versions?.node) {
    throw new Error(
      `Contract.${method} / Interface.${method} / DeployData.${method} are Node-only. ` +
        `In a browser, use fromJson() with your own file loading.`,
    );
  }
  return (await import("node:fs")) as unknown as NodeFsModule;
}
