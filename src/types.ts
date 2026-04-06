export interface Receipt {
  txHash: string;
  success: boolean;
  gasUsed: string;
  effectiveGas: string;
  feePaid: string;
  feeBurned: string;
  feeValidator: string;
  returnData?: string;
  logs: Log[];
}

/** Helper functions for Receipt parsing. */
export const ReceiptUtils = {
  /** Parse gasUsed from hex to number. */
  gas(receipt: Receipt): number {
    return parseInt(receipt.gasUsed.replace("0x", ""), 16);
  },

  /** For deploy receipts: extract contract address from returnData. */
  contractAddress(receipt: Receipt): string | null {
    const rd = receipt.returnData;
    if (!rd) return null;
    const hex = rd.startsWith("0x") ? rd.slice(2) : rd;
    return hex.length === 64 ? "0x" + hex : null;
  },

  /** Get raw return bytes as hex. */
  returnHex(receipt: Receipt): string {
    return receipt.returnData || "0x";
  },

  /** Decode returnData as u64. */
  decodeU64(receipt: Receipt): bigint | null {
    const hex = receipt.returnData;
    if (!hex) return null;
    const buf = Buffer.from(hex.startsWith("0x") ? hex.slice(2) : hex, "hex");
    return buf.length >= 8 ? buf.readBigUInt64LE() : null;
  },

  /** Decode returnData as bool. */
  decodeBool(receipt: Receipt): boolean | null {
    const v = ReceiptUtils.decodeU64(receipt);
    return v !== null ? v !== 0n : null;
  },

  /** Decode returnData as string. */
  decodeString(receipt: Receipt): string | null {
    const hex = receipt.returnData;
    if (!hex) return null;
    const buf = Buffer.from(hex.startsWith("0x") ? hex.slice(2) : hex, "hex");
    if (buf.length < 8) return null;
    const len = Number(buf.readBigUInt64LE());
    if (buf.length < 8 + len) return null;
    return buf.subarray(8, 8 + len).toString("utf-8");
  },

  /** Decode returnData as i64. */
  decodeI64(receipt: Receipt): bigint | null {
    const buf = receiptBuf(receipt);
    return buf && buf.length >= 8 ? buf.readBigInt64LE() : null;
  },

  /** Decode returnData as u128. */
  decodeU128(receipt: Receipt): bigint | null {
    const buf = receiptBuf(receipt);
    if (!buf || buf.length < 16) return null;
    return buf.readBigUInt64LE(0) | (buf.readBigUInt64LE(8) << 64n);
  },

  /** Decode returnData as i128. */
  decodeI128(receipt: Receipt): bigint | null {
    const buf = receiptBuf(receipt);
    if (!buf || buf.length < 16) return null;
    let val = buf.readBigUInt64LE(0) | (buf.readBigUInt64LE(8) << 64n);
    if (val >= (1n << 127n)) val -= (1n << 128n);
    return val;
  },

  /** Decode returnData as u256. */
  decodeU256(receipt: Receipt): bigint | null {
    const buf = receiptBuf(receipt);
    if (!buf || buf.length < 32) return null;
    let val = 0n;
    for (let i = 0; i < 4; i++) val |= buf.readBigUInt64LE(i * 8) << BigInt(i * 64);
    return val;
  },

  /** Decode returnData as Address (hex string). */
  decodeAddress(receipt: Receipt): string | null {
    const buf = receiptBuf(receipt);
    return buf && buf.length >= 32 ? "0x" + buf.subarray(0, 32).toString("hex") : null;
  },
};

function receiptBuf(receipt: Receipt): Buffer | null {
  const hex = receipt.returnData;
  if (!hex || hex === "0x") return null;
  return Buffer.from(hex.startsWith("0x") ? hex.slice(2) : hex, "hex");
}

export interface Log {
  address: string;
  topics: string[];
  data: string;
}

export interface LogFilter {
  fromBlock?: number;
  toBlock?: number;
  address?: string;
  /** Topic filters. Each entry is null (match any) or an array of hex values (OR match).
   *  topics[0] = event signature hash, topics[1..3] = indexed params. */
  topics?: (string | string[] | null)[];
}

export interface BlockHeader {
  slot: string;
  timestamp: string;
  proposer: string;
  stateRoot?: string;
  txCount?: string;
}

export interface TxFields {
  from: string;
  to: string;
  value: number | string;
  data: string;
  gasLimit: number;
  nonce: number;
  chainId: number;
  txType: number;
}

/** Transaction info returned by getTransaction. */
export interface TransactionInfo {
  hash: string;
  from: string;
  to: string;
  value: string;
  data: string;
  gasLimit: string;
  nonce: number;
  chainId: number;
  txType: number;
  blockNumber?: number;
}

/** Fee data from the network. */
export interface FeeData {
  /** Current gas price (same as base fee in Pyde's EIP-1559 model, no tips). */
  gasPrice: bigint;
  /** Current base fee per gas unit. */
  baseFee: bigint;
}
