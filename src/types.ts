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

export interface Log {
  address: string;
  topics: string[];
  data: string;
}

export interface LogFilter {
  fromBlock?: number;
  toBlock?: number;
  address?: string;
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
