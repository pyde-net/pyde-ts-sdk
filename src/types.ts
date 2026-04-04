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
};

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
