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
import { InvalidArgumentError } from "./errors";
import { Provider } from "./provider";
import { Wallet } from "./wallet";
import { TxType } from "./types";
import type { Receipt } from "./types";

// ============================================================================
// Byte helpers — isomorphic Uint8Array + DataView. Internal, not re-exported.
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

function readU32LE(b: Uint8Array, offset: number): number {
  return viewOf(b).getUint32(offset, true);
}

function readU16LE(b: Uint8Array, offset: number): number {
  return viewOf(b).getUint16(offset, true);
}

function readI16LE(b: Uint8Array, offset: number): number {
  return viewOf(b).getInt16(offset, true);
}

function readI32LE(b: Uint8Array, offset: number): number {
  return viewOf(b).getInt32(offset, true);
}

function readWideLE(b: Uint8Array, offset: number, bytes: 16 | 32): bigint {
  let result = 0n;
  for (let i = bytes - 1; i >= 0; i--) {
    result = (result << 8n) | BigInt(b[offset + i] ?? 0);
  }
  return result;
}

function writeWideLE(out: number[], v: bigint, bytes: 16 | 32): void {
  const mask = 0xffn;
  let cur = v & ((1n << BigInt(bytes * 8)) - 1n);
  for (let i = 0; i < bytes; i++) {
    out.push(Number(cur & mask));
    cur >>= 8n;
  }
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
  /** Pre-computed 4-byte selector from the artifact (engine ships this
   *  directly as `selector: [b0, b1, b2, b3]`). When present, the
   *  encoder uses it verbatim instead of re-hashing the name — keeps
   *  the SDK forward-compatible with future selector schemes. */
  selectorBytes?: Uint8Array;
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

/** Decoded event log with named args. The generic parameter is set by
 *  `pyde-tsgen`-emitted ABI shapes and gives `queryFilter` / `parseLog`
 *  per-event arg typing; defaults to `Record<string, any>` so untyped
 *  call-sites keep working. */
export interface EventLog<TArgs = Record<string, any>> {
  /** Event name (e.g., "Transfer"). */
  name: string;
  /** Decoded event arguments as named fields. */
  args: TArgs;
  /** Raw log data. */
  log: import("./types").Log;
}

// ============================================================================
// Type-level ABI shape used by Contract<TAbi> for method/event narrowing
// ============================================================================

/** Per-function spec consumed at the type level. `args` is the
 *  named-param object (`{ amount: bigint }`); `returns` is the TS type
 *  the method resolves to. */
export interface AbiFnSpec {
  args: Record<string, unknown>;
  returns: unknown;
  view: boolean;
  payable?: boolean;
}

/** Per-event spec consumed at the type level. */
export interface AbiEventSpec {
  args: Record<string, unknown>;
}

/** ABI shape `Contract<TAbi>` keys on. `pyde-tsgen` emits a concrete
 *  shape; raw `Contract` instances fall back to {@link DefaultAbi}. */
export interface AbiShape {
  functions: Record<string, AbiFnSpec>;
  events: Record<string, AbiEventSpec>;
}

/** Default ABI shape — no narrowing. Used when callers don't bind a
 *  concrete TAbi. The `view` / `payable` fields are `any` so the
 *  conditional `view extends true` resolves to "either branch", and
 *  ViewName / WriteName fall back to the full `string` keyspace. */
export interface DefaultAbi extends AbiShape {
  functions: Record<string, { args: Record<string, any>; returns: any; view: any; payable?: any }>;
  events: Record<string, { args: Record<string, any> }>;
}

type ViewName<A extends AbiShape> = {
  [K in keyof A["functions"]]: A["functions"][K]["view"] extends true ? K : never;
}[keyof A["functions"]] &
  string;

type WriteName<A extends AbiShape> = {
  [K in keyof A["functions"]]: A["functions"][K]["view"] extends false ? K : never;
}[keyof A["functions"]] &
  string;

type FnName<A extends AbiShape> = keyof A["functions"] & string;
type EventName<A extends AbiShape> = keyof A["events"] & string;

type FnArgs<A extends AbiShape, K extends FnName<A>> = A["functions"][K]["args"];
type FnReturns<A extends AbiShape, K extends FnName<A>> = A["functions"][K]["returns"];
type EvtArgs<A extends AbiShape, K extends EventName<A>> = A["events"][K]["args"];

// ============================================================================
// Range constants (allocated once, not per-call)
// ============================================================================

const INT_RANGES: Record<string, [bigint, bigint]> = {
  u8: [0n, 255n],
  u16: [0n, 65535n],
  u32: [0n, 4294967295n],
  u64: [0n, 18446744073709551615n],
  i8: [-128n, 127n],
  i16: [-32768n, 32767n],
  i32: [-2147483648n, 2147483647n],
  i64: [-9223372036854775808n, 9223372036854775807n],
};

const WIDE_RANGES: Record<string, [bigint, bigint]> = {
  u128: [0n, (1n << 128n) - 1n],
  i128: [-(1n << 127n), (1n << 127n) - 1n],
  u256: [0n, (1n << 256n) - 1n],
  i256: [-(1n << 255n), (1n << 255n) - 1n],
};

// ============================================================================
// Contract — ABI-aware interface
// ============================================================================

/** ABI-aware contract interface with validation and auto-encoding.
 *  `TAbi` narrows `read` / `write` / `queryFilter` / `parseLog` / etc.
 *  to the function and event names declared in the artifact. The
 *  default `AbiShape` keeps untyped call sites working as before; bind
 *  a concrete `TAbi` (typically a `pyde-tsgen`-emitted shape) to opt
 *  into method-name + arg + return narrowing. */
export class Contract<TAbi extends AbiShape = DefaultAbi> {
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
  static async fromArtifact<T extends AbiShape = DefaultAbi>(
    artifactPath: string,
    address: string,
    provider: Provider,
  ): Promise<Contract<T>> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = await loadNodeFs("fromArtifact");
    const json = fs.readFileSync(artifactPath, "utf-8");
    return Contract.fromJson<T>(json, address, provider);
  }

  /** Load contract from ABI JSON string. */
  static fromJson<T extends AbiShape = DefaultAbi>(
    json: string,
    address: string,
    provider: Provider,
  ): Contract<T> {
    const artifact = JSON.parse(json);
    const contract = new Contract(address, provider);
    const abi = artifact.abi || artifact;

    // Functions — normalise the engine's native shape
    // (`{ty: {Custom: "Order"}}`, `attrs: {bits}`, `selector: number[]`)
    // into the encoder's expected flat strings + boolean flags.
    for (const raw of abi.functions || []) {
      const fn = normaliseAbiFunction(raw);
      contract.functions.set(fn.name, fn);
    }

    // Structs + enums — accept either:
    //   - flat `structs: [...]` / `enums: [...]` (older spec drafts)
    //   - engine's discriminated `types: [{name, kind: {Struct|Enum}}]`
    for (const s of abi.structs || []) {
      contract.structs.set(s.name, normaliseStructDef(s));
    }
    for (const e of abi.enums || []) {
      contract.enums.set(e.name, normaliseEnumDef(e));
    }
    for (const t of abi.types || []) {
      const kind = t.kind ?? {};
      if (kind.Struct) {
        contract.structs.set(t.name, normaliseStructDef({ name: t.name, ...kind.Struct }));
      } else if (kind.Enum) {
        contract.enums.set(t.name, normaliseEnumDef({ name: t.name, ...kind.Enum }));
      }
    }

    // Events
    for (const raw of abi.events || []) {
      const ev = normaliseAbiEvent(raw);
      contract.events.set(ev.name, ev);
      // topic[0] = FNV-1a selector of event name, stored as LE u32 zero-padded to 32 bytes
      const sel = computeSelector(ev.name);
      const selBuf = new Uint8Array(4);
      writeU32LE(selBuf, 0, sel);
      const topic0 = "0x" + bytesToHex(selBuf) + "0".repeat(56);
      contract.eventsByTopic.set(topic0, ev);
    }

    return contract as unknown as Contract<T>;
  }

  /** Create a minimal contract (no ABI, manual function registration). */
  static create<T extends AbiShape = DefaultAbi>(address: string, provider: Provider): Contract<T> {
    return new Contract<T>(address, provider);
  }

  /** Register a function manually (when no artifact is available).
   *
   *  Positional signature — not an options object. Calling
   *  `addFunction({...})` will throw an `InvalidArgumentError` rather
   *  than silently destroying the wasm-bindgen string boundary in
   *  `computeSelector`.
   */
  addFunction(
    name: string,
    params: AbiParam[],
    returns: string,
    view = false,
    payable = false,
  ): this {
    if (typeof name !== "string") {
      throw new InvalidArgumentError(
        `Contract.addFunction: name must be a string, got ${typeof name}. ` +
          `Did you pass an options object? The signature is positional: ` +
          `addFunction(name, params, returns, view?, payable?)`,
        "name",
        name,
      );
    }
    if (!Array.isArray(params)) {
      throw new InvalidArgumentError(
        `Contract.addFunction: params must be an AbiParam[], got ${typeof params}`,
        "params",
        params,
      );
    }
    if (typeof returns !== "string") {
      throw new InvalidArgumentError(
        `Contract.addFunction: returns must be a type string (e.g. "u64", "()"), got ${typeof returns}`,
        "returns",
        returns,
      );
    }
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
  connect(wallet: Wallet): Contract<TAbi> {
    const c = new Contract<TAbi>(this.address, this.provider);
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
  async read<M extends ViewName<TAbi>>(
    method: M,
    args?: FnArgs<TAbi, M>,
  ): Promise<FnReturns<TAbi, M>>;
  async read(method: string, args: Record<string, any> = {}): Promise<any> {
    const fn = this.functions.get(method);
    if (!fn) throw new Error(`Unknown function '${method}'. Load ABI or call addFunction().`);

    const calldata = this.encodeCall(method, args);
    const resultHex = await this.provider.call(this.address, calldata);
    return this.decodeReturn(fn.returns, resultHex);
  }

  /** Static-call ANY function (view or setter) without sending a tx.
   * Simulates execution and returns the decoded return value. */
  async simulate<M extends FnName<TAbi>>(
    method: M,
    args?: FnArgs<TAbi, M>,
  ): Promise<FnReturns<TAbi, M>>;
  async simulate(method: string, args: Record<string, any> = {}): Promise<any> {
    // Cast through the loose default-shape signature — internal call
    // doesn't carry a static method-name guarantee.
    return (this as Contract).read(method, args);
  }

  /** Conservative gas estimate for a contract call. v1 engine has no
   *  dedicated `pyde_estimateGas`; this returns a fixed 5,000,000
   *  default suitable for non-trivial calls. Override at the call
   *  site (`write({ gasLimit: ... })`) when you have a tighter bound. */
  async estimateGas<M extends FnName<TAbi>>(method: M, args?: FnArgs<TAbi, M>): Promise<number>;
  async estimateGas(method: string, args: Record<string, any> = {}): Promise<number> {
    // Encode to validate the call shape before returning; the chain
    // doesn't actually run anything in the v1 stub.
    void this.encodeCall(method, args);
    return 5_000_000;
  }

  // ========================================================================
  // Write (state-changing — wallet required)
  // ========================================================================

  /** Send a state-changing transaction. Auto-encodes args, signs, sends, waits.
   * Pass options.value to send native tokens (validates payable from ABI).
   * Returns a ContractReceipt with a decodeReturnData() method. */
  async write<M extends WriteName<TAbi>>(
    method: M,
    args?: FnArgs<TAbi, M>,
    options?: { gasLimit?: number; value?: bigint | number | string },
  ): Promise<ContractReceipt>;
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
    return Object.assign(receipt, {
      decodeReturnData: (): any => {
        const rd = receipt.returnData;
        if (!rd || rd === "0x" || rd === "") return null;
        if (!retType || retType === "()" || retType === "unit") return null;
        return this.decodeReturn(retType, rd);
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
  async populateTransaction<M extends FnName<TAbi>>(
    method: M,
    args?: FnArgs<TAbi, M>,
    options?: { gasLimit?: number; value?: bigint | number | string },
  ): Promise<import("./types").TxFields>;
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
   * const transfers = await contract.queryFilter("Transfer", 0n, 1000n);
   * for (const e of transfers) {
   * console.log(e.name, e.args.from, e.args.to, e.args.amount);
   * }
   * ```
   */
  async queryFilter<E extends EventName<TAbi>>(
    eventName: E,
    fromWave?: bigint,
    toWave?: bigint,
  ): Promise<EventLog<EvtArgs<TAbi, E>>[]>;
  async queryFilter(eventName: string, fromWave?: bigint, toWave?: bigint): Promise<EventLog[]> {
    const ev = this.events.get(eventName);
    if (!ev) throw new Error(`Unknown event '${eventName}'. Load ABI with events.`);

    const topic0 = this.getEventTopic(eventName);

    // Phase 8 will resolve omitted bounds via Provider.getWave() ("latest");
    // for now the caller passes explicit bounds per HOST_FN_ABI §15.4
    // (5,000-wave cap per request).
    const response = await this.provider.getLogs({
      contract: this.address,
      fromWave: fromWave ?? 0n,
      toWave: toWave ?? 0n,
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

  /** Encode a function call into the borsh-encoded `CallPayload` bytes
   *  the chain's RPC + tx surface expects. Wire shape per
   *  `pyde_engine_types::CallPayload`:
   *
   *  ```rust
   *  struct CallPayload {
   *      function: String,   // 4-byte LE len + UTF-8 bytes
   *      calldata: Vec<u8>,  // 4-byte LE len + borsh-encoded args
   *  }
   *  ```
   *
   *  The returned hex goes verbatim into `provider.call({data})` for
   *  read-side calls and `Tx.data` for state-mutating txs. */
  encodeCall(method: string, args: Record<string, any> = {}): string {
    const fn = this.functions.get(method);
    if (!fn) throw new Error(`Unknown function '${method}'.`);

    // Step 1 — borsh-encode each arg into the calldata payload. Multi-
    // arg = concat (`#[pyde::entry]` decodes the args tuple via
    // `<(T1, T2, ...)>::try_from_slice`).
    const argsBuf: number[] = [];
    for (const param of fn.params) {
      const value = args[param.name];
      if (value === undefined) {
        throw new Error(`${method}(): missing required param '${param.name}' (${param.type})`);
      }
      this.encodeValue(argsBuf, value, param.type, `${method}().${param.name}`);
    }

    // Step 2 — wrap in `CallPayload { function, calldata }` and borsh-
    // encode the whole struct. String + Vec<u8> are 4-byte LE len-
    // prefixed.
    const out: number[] = [];
    const fnNameBytes = bytesFromUtf8(fn.name);
    const fnLen = fnNameBytes.length;
    out.push(fnLen & 0xff, (fnLen >> 8) & 0xff, (fnLen >> 16) & 0xff, (fnLen >> 24) & 0xff);
    for (let i = 0; i < fnNameBytes.length; i++) out.push(fnNameBytes[i]!);
    const cdLen = argsBuf.length;
    out.push(cdLen & 0xff, (cdLen >> 8) & 0xff, (cdLen >> 16) & 0xff, (cdLen >> 24) & 0xff);
    for (let i = 0; i < argsBuf.length; i++) out.push(argsBuf[i]!);

    return "0x" + bytesToHex(new Uint8Array(out));
  }

  /** Encode just the raw borsh-encoded args (no `CallPayload` wrapper,
   *  no selector). Useful for tests that compare wire bytes against a
   *  borsh-rs encoder. */
  encodeCallArgs(method: string, args: Record<string, any> = {}): string {
    const fn = this.functions.get(method);
    if (!fn) throw new Error(`Unknown function '${method}'.`);
    const buf: number[] = [];
    for (const param of fn.params) {
      const value = args[param.name];
      if (value === undefined) {
        throw new Error(`${method}(): missing required param '${param.name}' (${param.type})`);
      }
      this.encodeValue(buf, value, param.type, `${method}().${param.name}`);
    }
    return "0x" + bytesToHex(new Uint8Array(buf));
  }

  /** Borsh-encode a single value into `buf`. Validates type + range.
   *  Wire format follows the borsh-rs canonical spec — matches what the
   *  chain's `#[pyde::entry]` macro decodes via
   *  `borsh::BorshDeserialize::try_from_slice`. */
  private encodeValue(buf: number[], value: any, type: string, path: string): void {
    // ----- 1-byte ints -----
    if (type === "u8") {
      const n = this.toBigInt(value, type, path);
      this.validateIntRange(n, type, path);
      buf.push(Number(n) & 0xff);
      return;
    }
    if (type === "i8") {
      const n = this.toBigInt(value, type, path);
      this.validateIntRange(n, type, path);
      buf.push(Number(n) & 0xff);
      return;
    }

    // ----- 2-byte ints -----
    if (type === "u16" || type === "i16") {
      const n = this.toBigInt(value, type, path);
      this.validateIntRange(n, type, path);
      const v = Number(n) & 0xffff;
      buf.push(v & 0xff, (v >> 8) & 0xff);
      return;
    }

    // ----- 4-byte ints -----
    if (type === "u32" || type === "i32") {
      const n = this.toBigInt(value, type, path);
      this.validateIntRange(n, type, path);
      // Mask to 32 bits for two's-complement signed encoding.
      const v = Number(n & 0xffffffffn);
      buf.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff);
      return;
    }

    // ----- 8-byte ints -----
    if (type === "u64" || type === "i64") {
      const n = this.toBigInt(value, type, path);
      this.validateIntRange(n, type, path);
      const b = new Uint8Array(8);
      if (type === "i64") writeI64LE(b, 0, n);
      else writeU64LE(b, 0, n);
      buf.push(...b);
      return;
    }

    // ----- 16-byte ints -----
    if (type === "u128" || type === "i128") {
      const n = this.toBigInt(value, type, path);
      this.validateWideRange(n, type, path);
      writeWideLE(buf, n, 16);
      return;
    }

    // ----- 32-byte ints (Pyde extension; borsh-rs has no native u256) -----
    if (type === "u256" || type === "i256") {
      const n = this.toBigInt(value, type, path);
      this.validateWideRange(n, type, path);
      writeWideLE(buf, n, 32);
      return;
    }

    // ----- bool: 1 byte (0 / 1) -----
    if (type === "bool") {
      if (typeof value !== "boolean") {
        throw new Error(`${path}: expected bool, got ${typeof value}`);
      }
      buf.push(value ? 1 : 0);
      return;
    }

    // ----- Address: 32 raw bytes (borsh `[u8; 32]`) -----
    if (type === "Address") {
      const hex = this.requireFixedHex(value, 32, type, path);
      buf.push(...bytesFromHex(hex));
      return;
    }

    // ----- FixedBytes:N: N raw bytes -----
    if (type.startsWith("FixedBytes:")) {
      const n = parseInt(type.slice("FixedBytes:".length), 10);
      const hex = this.requireFixedHex(value, n, type, path);
      buf.push(...bytesFromHex(hex));
      return;
    }

    // ----- String: 4-byte u32 LE length + UTF-8 bytes -----
    if (type === "String") {
      if (typeof value !== "string") {
        throw new Error(`${path}: expected String, got ${typeof value}`);
      }
      const bytes = bytesFromUtf8(value);
      const len = bytes.length;
      buf.push(len & 0xff, (len >> 8) & 0xff, (len >> 16) & 0xff, (len >> 24) & 0xff);
      for (const b of bytes) buf.push(b);
      return;
    }

    // ----- Bytes (Vec<u8>): 4-byte u32 LE length + raw bytes -----
    if (type === "Bytes" || type === "bytes") {
      const bytes =
        value instanceof Uint8Array
          ? value
          : typeof value === "string"
            ? bytesFromHex(value.startsWith("0x") ? value.slice(2) : value)
            : null;
      if (!bytes) {
        throw new Error(
          `${path}: expected Uint8Array or hex string for Bytes, got ${typeof value}`,
        );
      }
      const len = bytes.length;
      buf.push(len & 0xff, (len >> 8) & 0xff, (len >> 16) & 0xff, (len >> 24) & 0xff);
      for (let i = 0; i < bytes.length; i++) buf.push(bytes[i]!);
      return;
    }

    // ----- Option<T>: 1-byte tag + T if Some -----
    if (type.startsWith("Option<") && type.endsWith(">")) {
      const innerType = type.slice(7, -1);
      if (value === null || value === undefined) {
        buf.push(0);
      } else {
        buf.push(1);
        this.encodeValue(buf, value, innerType, `${path}.Some`);
      }
      return;
    }

    // ----- Tuple "(T1, T2, ...)": fields concatenated, no header -----
    if (type.startsWith("(") && type.endsWith(")")) {
      const inner = type.slice(1, -1);
      if (inner && inner !== "()") {
        const types = parseTupleTypes(inner);
        if (!Array.isArray(value)) {
          throw new Error(`${path}: expected array for tuple ${type}, got ${typeof value}`);
        }
        if (value.length !== types.length) {
          throw new Error(
            `${path}: tuple ${type} expects ${types.length} elements, got ${value.length}`,
          );
        }
        for (let i = 0; i < types.length; i++) {
          this.encodeValue(buf, value[i], types[i]!, `${path}.${i}`);
        }
      }
      return;
    }

    // ----- Array "[T; N]": N items concatenated, no header -----
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

    // ----- Vec<T>: 4-byte u32 LE count + T items -----
    if (type.startsWith("Vec<") && type.endsWith(">")) {
      if (!Array.isArray(value)) {
        throw new Error(`${path}: expected array for ${type}, got ${typeof value}`);
      }
      const elemType = type.slice(4, -1);
      const len = value.length;
      buf.push(len & 0xff, (len >> 8) & 0xff, (len >> 16) & 0xff, (len >> 24) & 0xff);
      for (let i = 0; i < len; i++) {
        this.encodeValue(buf, value[i], elemType, `${path}[${i}]`);
      }
      return;
    }

    // ----- Struct: fields concatenated in declaration order, no header -----
    const structDef = this.structs.get(type);
    if (structDef) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`${path}: expected object for struct ${type}, got ${typeof value}`);
      }
      for (const field of structDef.fields) {
        const fieldVal = (value as Record<string, unknown>)[field.name];
        if (fieldVal === undefined) {
          throw new Error(`${path}: missing field '${field.name}' for struct ${type}`);
        }
        this.encodeValue(buf, fieldVal, field.type, `${path}.${field.name}`);
      }
      return;
    }

    // ----- Enum (unit variants only): 1-byte variant index -----
    const enumDef = this.enums.get(type);
    if (enumDef) {
      if (typeof value !== "string" && typeof value !== "number") {
        throw new Error(`${path}: expected variant name or discriminant for enum ${type}`);
      }
      let disc: number;
      if (typeof value === "string") {
        const variant = enumDef.variants.find((v) => v.name === value);
        if (!variant) {
          throw new Error(
            `${path}: unknown variant '${value}' for enum ${type}. Valid: ${enumDef.variants.map((v) => v.name).join(", ")}`,
          );
        }
        disc = variant.discriminant;
      } else {
        disc = value;
      }
      if (disc < 0 || disc > 255) {
        throw new Error(
          `${path}: variant discriminant ${disc} out of range 0..255 for enum ${type}`,
        );
      }
      buf.push(disc);
      return;
    }

    throw new Error(`${path}: unsupported type '${type}'`);
  }

  /** Convert a number / bigint / decimal-string into a bigint. */
  private toBigInt(value: unknown, type: string, path: string): bigint {
    if (typeof value === "bigint") return value;
    if (typeof value === "number") {
      if (!Number.isInteger(value)) {
        throw new Error(`${path}: expected integer for ${type}, got ${value}`);
      }
      return BigInt(value);
    }
    if (typeof value === "string") {
      try {
        return BigInt(value);
      } catch {
        // fall through
      }
    }
    throw new Error(`${path}: expected ${type}, got ${typeof value}`);
  }

  /** Validate + canonicalise a fixed-byte-size hex input. */
  private requireFixedHex(value: unknown, byteCount: number, type: string, path: string): string {
    if (typeof value !== "string") {
      throw new Error(`${path}: expected hex string for ${type}, got ${typeof value}`);
    }
    const hex = value.startsWith("0x") || value.startsWith("0X") ? value.slice(2) : value;
    if (hex.length !== byteCount * 2) {
      throw new Error(`${path}: ${type} expects ${byteCount * 2} hex chars, got ${hex.length}`);
    }
    if (!/^[0-9a-fA-F]+$/.test(hex)) {
      throw new Error(`${path}: ${type} has non-hex characters`);
    }
    return hex;
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

  /** Borsh-decode the return type from a hex-string payload. */
  private decodeReturn(type: string, hex: string): any {
    if (type === "()" || type === "unit" || type === "void") return null;
    const data = bytesFromHex(hex);
    return this.decodeValue(data, type, 0).value;
  }

  /** Borsh-decode a single value at `offset` in `data`. */
  private decodeValue(
    data: Uint8Array,
    type: string,
    offset: number,
  ): { value: any; bytesRead: number } {
    // ----- 1-byte ints -----
    if (type === "u8") {
      return { value: BigInt(data[offset] ?? 0), bytesRead: 1 };
    }
    if (type === "i8") {
      const b = data[offset] ?? 0;
      return { value: BigInt(b < 128 ? b : b - 256), bytesRead: 1 };
    }

    // ----- 2-byte ints -----
    if (type === "u16") {
      return { value: BigInt(readU16LE(data, offset)), bytesRead: 2 };
    }
    if (type === "i16") {
      return { value: BigInt(readI16LE(data, offset)), bytesRead: 2 };
    }

    // ----- 4-byte ints -----
    if (type === "u32") {
      return { value: BigInt(readU32LE(data, offset)), bytesRead: 4 };
    }
    if (type === "i32") {
      return { value: BigInt(readI32LE(data, offset)), bytesRead: 4 };
    }

    // ----- 8-byte ints -----
    if (type === "u64") {
      return { value: readU64LE(data, offset), bytesRead: 8 };
    }
    if (type === "i64") {
      return { value: readI64LE(data, offset), bytesRead: 8 };
    }

    // ----- 16-byte ints -----
    if (type === "u128") {
      return { value: readWideLE(data, offset, 16), bytesRead: 16 };
    }
    if (type === "i128") {
      let val = readWideLE(data, offset, 16);
      if (val >= 1n << 127n) val -= 1n << 128n;
      return { value: val, bytesRead: 16 };
    }

    // ----- 32-byte ints (Pyde extension) -----
    if (type === "u256") {
      return { value: readWideLE(data, offset, 32), bytesRead: 32 };
    }
    if (type === "i256") {
      let val = readWideLE(data, offset, 32);
      if (val >= 1n << 255n) val -= 1n << 256n;
      return { value: val, bytesRead: 32 };
    }

    // ----- bool: 1 byte -----
    if (type === "bool") {
      return { value: (data[offset] ?? 0) !== 0, bytesRead: 1 };
    }

    // ----- Address: 32 raw bytes -----
    if (type === "Address") {
      const end = Math.min(offset + 32, data.length);
      return { value: "0x" + bytesToHex(data.subarray(offset, end)), bytesRead: 32 };
    }

    // ----- FixedBytes:N -----
    if (type.startsWith("FixedBytes:")) {
      const n = parseInt(type.slice("FixedBytes:".length), 10);
      const end = Math.min(offset + n, data.length);
      return { value: "0x" + bytesToHex(data.subarray(offset, end)), bytesRead: n };
    }

    // ----- String: 4-byte u32 LE len + UTF-8 -----
    if (type === "String") {
      const len = readU32LE(data, offset);
      const str = bytesToUtf8(data.subarray(offset + 4, offset + 4 + len));
      return { value: str, bytesRead: 4 + len };
    }

    // ----- Bytes (Vec<u8>): 4-byte len + raw bytes -----
    if (type === "Bytes" || type === "bytes") {
      const len = readU32LE(data, offset);
      const bytes = new Uint8Array(data.subarray(offset + 4, offset + 4 + len));
      return { value: bytes, bytesRead: 4 + len };
    }

    // ----- Option<T>: 1-byte tag + T if Some -----
    if (type.startsWith("Option<") && type.endsWith(">")) {
      const tag = data[offset] ?? 0;
      if (tag === 0) return { value: null, bytesRead: 1 };
      const innerType = type.slice(7, -1);
      const inner = this.decodeValue(data, innerType, offset + 1);
      return { value: inner.value, bytesRead: 1 + inner.bytesRead };
    }

    // ----- Tuple "(T1, T2, ...)": fields concatenated -----
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

    // ----- Array "[T; N]": N items concatenated -----
    if (type.startsWith("[") && type.endsWith("]")) {
      const parsed = parseArrayType(type.slice(1, -1));
      if (parsed) {
        const [elemType, count] = parsed;
        let cursor = offset;
        const items: any[] = [];
        for (let i = 0; i < count; i++) {
          const { value, bytesRead } = this.decodeValue(data, elemType, cursor);
          items.push(value);
          cursor += bytesRead;
        }
        return { value: items, bytesRead: cursor - offset };
      }
    }

    // ----- Vec<T>: 4-byte u32 LE count + T items -----
    if (type.startsWith("Vec<") && type.endsWith(">")) {
      const elemType = type.slice(4, -1);
      const count = readU32LE(data, offset);
      let cursor = offset + 4;
      const items: any[] = [];
      for (let i = 0; i < count; i++) {
        const { value, bytesRead } = this.decodeValue(data, elemType, cursor);
        items.push(value);
        cursor += bytesRead;
      }
      return { value: items, bytesRead: cursor - offset };
    }

    // ----- Struct: fields concatenated in declaration order -----
    const structDef = this.structs.get(type);
    if (structDef) {
      let cursor = offset;
      const obj: Record<string, any> = {};
      for (const field of structDef.fields) {
        const { value, bytesRead } = this.decodeValue(data, field.type, cursor);
        obj[field.name] = value;
        cursor += bytesRead;
      }
      return { value: obj, bytesRead: cursor - offset };
    }

    // ----- Enum (unit variants only): 1-byte variant index -----
    const enumDef = this.enums.get(type);
    if (enumDef) {
      const disc = data[offset] ?? 0;
      const variant = enumDef.variants.find((v) => v.discriminant === disc);
      return { value: variant?.name ?? disc, bytesRead: 1 };
    }

    if (type === "()" || type === "unit" || type === "void") {
      return { value: null, bytesRead: 0 };
    }

    throw new Error(`unsupported type '${type}' at decode offset ${offset}`);
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

  get _args(): Uint8Array {
    return concatBytes(this._parts);
  }
  get args(): Uint8Array {
    return this._args;
  }

  private push(buf: Uint8Array): void {
    this._parts.push(buf);
  }

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
    if (val < 0 || val > 4294967295)
      throw new RangeError(`argU32: ${val} out of range (0 to 4294967295)`);
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
    if (val < -32768 || val > 32767)
      throw new RangeError(`argI16: ${val} out of range (-32768 to 32767)`);
    return this.argI64(BigInt(val));
  }
  /** Signed 32-bit integer. Range: -2,147,483,648 to 2,147,483,647. Sign-extended to 8 bytes LE. */
  argI32(val: number): this {
    if (val < -2147483648 || val > 2147483647)
      throw new RangeError(`argI32: ${val} out of range (-2147483648 to 2147483647)`);
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
  argBool(val: boolean): this {
    return this.argU64(val ? 1 : 0);
  }
  /** Unsigned 128-bit integer. Range: 0 to 2^128 - 1. Encoded as 16 bytes LE. */
  argU128(val: bigint): this {
    if (val < 0n || val >= 1n << 128n) throw new RangeError("argU128: value out of range");
    const buf = new Uint8Array(16);
    writeU64LE(buf, 0, val & 0xffffffffffffffffn);
    writeU64LE(buf, 8, (val >> 64n) & 0xffffffffffffffffn);
    this.push(buf);
    return this;
  }
  /** Signed 128-bit integer. Range: -2^127 to 2^127 - 1. Encoded as 16 bytes LE (two's complement). */
  argI128(val: bigint): this {
    if (val < -(1n << 127n) || val >= 1n << 127n)
      throw new RangeError("argI128: value out of range");
    const unsigned = val & ((1n << 128n) - 1n);
    const buf = new Uint8Array(16);
    writeU64LE(buf, 0, unsigned & 0xffffffffffffffffn);
    writeU64LE(buf, 8, (unsigned >> 64n) & 0xffffffffffffffffn);
    this.push(buf);
    return this;
  }
  /** Unsigned 256-bit integer. Range: 0 to 2^256 - 1. Encoded as 32 bytes LE. */
  argU256(val: bigint): this {
    if (val < 0n || val >= 1n << 256n) throw new RangeError("argU256: value out of range");
    const buf = new Uint8Array(32);
    for (let i = 0; i < 4; i++) {
      writeU64LE(buf, i * 8, (val >> BigInt(i * 64)) & 0xffffffffffffffffn);
    }
    this.push(buf);
    return this;
  }
  /** Signed 256-bit integer. Range: -2^255 to 2^255 - 1. Encoded as 32 bytes LE (two's complement). */
  argI256(val: bigint): this {
    if (val < -(1n << 255n) || val >= 1n << 255n)
      throw new RangeError("argI256: value out of range");
    const unsigned = val & ((1n << 256n) - 1n);
    const buf = new Uint8Array(32);
    for (let i = 0; i < 4; i++) {
      writeU64LE(buf, i * 8, (unsigned >> BigInt(i * 64)) & 0xffffffffffffffffn);
    }
    this.push(buf);
    return this;
  }
  /** 32-byte address. Validates hex length. */
  argAddress(hex: string): this {
    const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
    if (!/^[0-9a-fA-F]{64}$/.test(clean)) {
      throw new Error(
        `argAddress: expected 64 hex chars, got "${clean.length > 20 ? clean.slice(0, 20) + "..." : clean}"`,
      );
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
    this.push(lenBuf);
    this.push(bytes);
    if (padding > 0) this.push(new Uint8Array(padding));
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
    this.push(header);
    this.push(elems);
    return this;
  }
  /** Vec<bool>: encoded as Vec<u64>. */
  argVecBool(vals: boolean[]): this {
    return this.argVecU64(vals.map((b) => (b ? 1 : 0)));
  }
  /** Vec<Address>: [byte_len:8][count:8][cap:8][addr0:32][addr1:32]... */
  argVecAddress(vals: string[]): this {
    const dataLen = 16 + vals.length * 32;
    const header = new Uint8Array(24);
    writeU64LE(header, 0, BigInt(dataLen));
    writeU64LE(header, 8, BigInt(vals.length));
    writeU64LE(header, 16, BigInt(vals.length));
    const elems: Uint8Array[] = vals.map((hex) => {
      const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
      if (clean.length !== 64) throw new Error(`argVecAddress: expected 64 hex chars per address`);
      return bytesFromHex(clean);
    });
    this.push(header);
    for (const e of elems) this.push(e);
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
    this.push(header);
    this.push(elements);
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
    this.push(lenBuf);
    this.push(fields);
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
  return readU64LE(buf, 0) | (readU64LE(buf, 8) << 64n);
}
export function decodeI128(hex: string): bigint {
  const buf = bytesFromHex(hex);
  if (buf.length < 16) return 0n;
  let val = readU64LE(buf, 0) | (readU64LE(buf, 8) << 64n);
  if (val >= 1n << 127n) val -= 1n << 128n;
  return val;
}
export function decodeU256(hex: string): bigint {
  const buf = bytesFromHex(hex);
  if (buf.length < 32) return 0n;
  let val = 0n;
  for (let i = 0; i < 4; i++) val |= readU64LE(buf, i * 8) << BigInt(i * 64);
  return val;
}
export function decodeI256(hex: string): bigint {
  const buf = bytesFromHex(hex);
  if (buf.length < 32) return 0n;
  let val = 0n;
  for (let i = 0; i < 4; i++) val |= readU64LE(buf, i * 8) << BigInt(i * 64);
  if (val >= 1n << 255n) val -= 1n << 256n;
  return val;
}
export function decodeBool(hex: string): boolean {
  return decodeU64(hex) !== 0n;
}
export function decodeAddress(hex: string): string {
  const buf = bytesFromHex(hex);
  return buf.length >= 32 ? "0x" + bytesToHex(buf.subarray(0, 32)) : "0x" + "00".repeat(32);
}
export function decodeString(hex: string): string {
  const buf = bytesFromHex(hex);
  if (buf.length < 8) return "";
  const len = Number(readU64LE(buf, 0));
  if (buf.length < 8 + len)
    throw new Error(`decodeString: expected ${len} bytes, buffer has ${buf.length - 8}`);
  return bytesToUtf8(buf.subarray(8, 8 + len));
}
export function decodeBytes(hex: string): Uint8Array {
  const buf = bytesFromHex(hex);
  if (buf.length < 8) throw new Error("decodeBytes: buffer too short for length prefix");
  const len = Number(readU64LE(buf, 0));
  if (buf.length < 8 + len)
    throw new Error(`decodeBytes: expected ${len} bytes, buffer has ${buf.length - 8}`);
  return buf.subarray(8, 8 + len);
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

// ============================================================================
// ABI normalisation — engine's native shape → encoder's flat shape.
// ============================================================================
//
// The `otigen build` output uses a discriminated union for types
// (`{Custom: "Order"} | {Vec: "U64"} | {FixedBytes: 32} | "U64"`) and a
// packed `attrs.bits` field for view/payable. Older spec drafts use a
// flat string type + boolean flags. Both are accepted at load time and
// flattened to the encoder/decoder's expected `{type: string, view:
// boolean, payable: boolean}` shape.

const ATTR_VIEW_BIT = 0x01;
const ATTR_PAYABLE_BIT = 0x02;

/** Engine wire-shape type spec — either a flat string or a discriminated
 *  union (`{Custom}`, `{Vec}`, `{FixedBytes}`, `{Option}`, `{Tuple}`,
 *  `{Array}`, `{Map}`). */
type EngineAbiType = string | null | undefined | { [k: string]: unknown };

function normaliseAbiType(t: EngineAbiType): string {
  if (t == null) return "()";
  if (typeof t === "string") {
    const lower = t.toLowerCase();
    if (
      [
        "u8",
        "u16",
        "u32",
        "u64",
        "u128",
        "u256",
        "i8",
        "i16",
        "i32",
        "i64",
        "i128",
        "i256",
        "bool",
      ].includes(lower)
    ) {
      return lower;
    }
    if (lower === "string") return "String";
    if (lower === "bytes") return "Bytes";
    if (lower === "address" || lower === "hash" || lower === "hash32") return "Address";
    // Pass through any user-named type (struct/enum); the encoder
    // resolves it via the struct/enum registry.
    return t;
  }
  if (typeof t === "object" && t !== null) {
    const o = t as Record<string, unknown>;
    if (typeof o.Custom === "string") return o.Custom;
    if (o.Vec !== undefined) return `Vec<${normaliseAbiType(o.Vec as EngineAbiType)}>`;
    if (typeof o.FixedBytes === "number") {
      return o.FixedBytes === 32 ? "Address" : `FixedBytes:${o.FixedBytes}`;
    }
    if (o.Option !== undefined) return `Option<${normaliseAbiType(o.Option as EngineAbiType)}>`;
    if (Array.isArray(o.Tuple)) {
      return `(${(o.Tuple as EngineAbiType[]).map(normaliseAbiType).join(",")})`;
    }
    if (Array.isArray(o.Array) && o.Array.length === 2) {
      return `[${normaliseAbiType((o.Array as [EngineAbiType, number])[0])}; ${(o.Array as [EngineAbiType, number])[1]}]`;
    }
    if (Array.isArray(o.Map) && o.Map.length === 2) {
      return `Map<${normaliseAbiType((o.Map as [EngineAbiType, EngineAbiType])[0])}, ${normaliseAbiType((o.Map as [EngineAbiType, EngineAbiType])[1])}>`;
    }
  }
  return String(t);
}

function normaliseAbiFunction(raw: Record<string, unknown>): AbiFunction {
  const params = ((raw.params as unknown[]) ?? []).map((p, i) => {
    const o = p as Record<string, unknown>;
    return {
      name: (o.name as string | undefined) ?? `arg${i}`,
      type: normaliseAbiType((o.ty ?? o.type) as EngineAbiType),
    };
  });

  // attrs.bits: bit 0 = view, bit 1 = payable. Older drafts use direct
  // booleans — honour them when present.
  let view = Boolean(raw.view);
  let payable = Boolean(raw.payable);
  const attrs = raw.attrs as { bits?: number } | undefined;
  if (typeof attrs?.bits === "number") {
    view = (attrs.bits & ATTR_VIEW_BIT) !== 0;
    payable = (attrs.bits & ATTR_PAYABLE_BIT) !== 0;
  } else if (typeof raw.attributes === "number") {
    view = (raw.attributes & ATTR_VIEW_BIT) !== 0;
    payable = (raw.attributes & ATTR_PAYABLE_BIT) !== 0;
  }

  // selector: engine emits a 4-byte array; older drafts a hex string.
  let selectorHex: string;
  let selectorBytes: Uint8Array | undefined;
  if (Array.isArray(raw.selector) && raw.selector.length === 4) {
    selectorBytes = new Uint8Array(raw.selector as number[]);
    selectorHex = "0x" + bytesToHex(selectorBytes);
  } else if (typeof raw.selector === "string") {
    selectorHex = raw.selector;
  } else {
    selectorHex =
      "0x" +
      computeSelector(raw.name as string)
        .toString(16)
        .padStart(8, "0");
  }

  return {
    name: raw.name as string,
    selector: selectorHex,
    ...(selectorBytes ? { selectorBytes } : {}),
    params,
    returns: normaliseAbiType(raw.returns as EngineAbiType),
    view,
    payable,
    constructor: Boolean(raw.constructor),
  };
}

function normaliseStructDef(raw: Record<string, unknown>): AbiStructDef {
  const fields = ((raw.fields as unknown[]) ?? []).map((f, i) => {
    const o = f as Record<string, unknown>;
    return {
      name: (o.name as string | undefined) ?? `field${i}`,
      type: normaliseAbiType((o.ty ?? o.type) as EngineAbiType),
    };
  });
  return { name: raw.name as string, fields };
}

function normaliseEnumDef(raw: Record<string, unknown>): AbiEnumDef {
  const variants = ((raw.variants as unknown[]) ?? []).map((v, i) => {
    const o = v as Record<string, unknown>;
    return {
      name: (o.name as string | undefined) ?? `Variant${i}`,
      discriminant: typeof o.discriminant === "number" ? o.discriminant : i,
    };
  });
  return { name: raw.name as string, variants };
}

function normaliseAbiEvent(raw: Record<string, unknown>): AbiEvent {
  const fields = ((raw.fields as unknown[]) ?? []).map((f, i) => {
    const o = f as Record<string, unknown>;
    return {
      name: (o.name as string | undefined) ?? `field${i}`,
      type: normaliseAbiType((o.ty ?? o.type) as EngineAbiType),
      indexed: Boolean(o.indexed),
    };
  });
  return { name: raw.name as string, fields };
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
  const count = Number(readU64LE(buf, 8));
  const maxCount = Math.floor((buf.length - 24) / 8);
  const safe = Math.min(count, maxCount);
  const result: bigint[] = [];
  for (let i = 0; i < safe; i++) result.push(readU64LE(buf, 24 + i * 8));
  return result;
}

export function decodeVecBool(hex: string): boolean[] {
  return decodeVecU64(hex).map((v) => v !== 0n);
}

export function decodeVecAddress(hex: string): string[] {
  const buf = bytesFromHex(hex);
  if (buf.length < 24) return [];
  const count = Number(readU64LE(buf, 8));
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
  static async fromArtifact(
    artifactPath: string,
    args: Record<string, any> = {},
  ): Promise<DeployData> {
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
  argU8(val: number): this {
    return this.argU64(val);
  }
  argU16(val: number): this {
    return this.argU64(val);
  }
  argU32(val: number): this {
    return this.argU64(val);
  }
  argU64(val: number | bigint): this {
    const buf = new Uint8Array(8);
    writeU64LE(buf, 0, BigInt(val));
    this.argsBuf = concatBytes([this.argsBuf, buf]);
    return this;
  }
  argI8(val: number): this {
    return this.argI64(BigInt(val));
  }
  argI16(val: number): this {
    return this.argI64(BigInt(val));
  }
  argI32(val: number): this {
    return this.argI64(BigInt(val));
  }
  argI64(val: number | bigint): this {
    const buf = new Uint8Array(8);
    writeI64LE(buf, 0, BigInt(val));
    this.argsBuf = concatBytes([this.argsBuf, buf]);
    return this;
  }
  argBool(val: boolean): this {
    return this.argU64(val ? 1 : 0);
  }
  // Wide integers
  argU128(val: bigint): this {
    const buf = new Uint8Array(16);
    writeU64LE(buf, 0, val & 0xffffffffffffffffn);
    writeU64LE(buf, 8, (val >> 64n) & 0xffffffffffffffffn);
    this.argsBuf = concatBytes([this.argsBuf, buf]);
    return this;
  }
  argI128(val: bigint): this {
    const unsigned = val & ((1n << 128n) - 1n);
    const buf = new Uint8Array(16);
    writeU64LE(buf, 0, unsigned & 0xffffffffffffffffn);
    writeU64LE(buf, 8, (unsigned >> 64n) & 0xffffffffffffffffn);
    this.argsBuf = concatBytes([this.argsBuf, buf]);
    return this;
  }
  argU256(val: bigint): this {
    const buf = new Uint8Array(32);
    for (let i = 0; i < 4; i++)
      writeU64LE(buf, i * 8, (val >> BigInt(i * 64)) & 0xffffffffffffffffn);
    this.argsBuf = concatBytes([this.argsBuf, buf]);
    return this;
  }
  argI256(val: bigint): this {
    const unsigned = val & ((1n << 256n) - 1n);
    const buf = new Uint8Array(32);
    for (let i = 0; i < 4; i++)
      writeU64LE(buf, i * 8, (unsigned >> BigInt(i * 64)) & 0xffffffffffffffffn);
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
