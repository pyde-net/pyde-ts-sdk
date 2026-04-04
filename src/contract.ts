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

  argU64(val: number | bigint): this {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(BigInt(val));
    this.args = Buffer.concat([this.args, buf]);
    return this;
  }

  argBool(val: boolean): this {
    return this.argU64(val ? 1 : 0);
  }

  argAddress(hex: string): this {
    const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
    this.args = Buffer.concat([this.args, Buffer.from(clean, "hex")]);
    return this;
  }

  argString(val: string): this {
    const bytes = Buffer.from(val, "utf-8");
    const lenBuf = Buffer.alloc(8);
    lenBuf.writeBigUInt64LE(BigInt(bytes.length));
    const padding = (8 - (bytes.length % 8)) % 8;
    this.args = Buffer.concat([
      this.args,
      lenBuf,
      bytes,
      Buffer.alloc(padding),
    ]);
    return this;
  }

  argBytes(data: Buffer): this {
    this.args = Buffer.concat([this.args, data]);
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

export function decodeU64(hex: string): bigint {
  const buf = Buffer.from(stripHex(hex), "hex");
  if (buf.length < 8) return 0n;
  return buf.readBigUInt64LE();
}

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
export function decodeValue(hex: string, typeStr: string): any {
  switch (typeStr) {
    case "u64":
    case "u32":
    case "u16":
    case "u8":
      return decodeU64(hex);
    case "bool":
      return decodeBool(hex);
    case "Address":
      return decodeAddress(hex);
    case "String":
      return decodeString(hex);
    default:
      return hex;
  }
}

function stripHex(s: string): string {
  return s.startsWith("0x") ? s.slice(2) : s;
}
