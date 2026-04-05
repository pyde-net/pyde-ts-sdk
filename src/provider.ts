import { Receipt, Log, LogFilter, BlockHeader } from "./types";

/** JSON-RPC client for interacting with a Pyde node. */
export class Provider {
  private rpcUrl: string;
  private rpcId = 0;

  constructor(rpcUrl: string) {
    this.rpcUrl = rpcUrl;
  }

  // ========================================================================
  // Queries
  // ========================================================================

  async getBalance(address: string): Promise<bigint> {
    const result = await this.rpc("pyde_getBalance", [address]);
    return BigInt(result as string);
  }

  async getNonce(address: string): Promise<number> {
    const result = await this.rpc("pyde_getTransactionCount", [address]);
    const s = result as string;
    const n = s.startsWith("0x") ? parseInt(s, 16) : parseInt(s, 10);
    if (Number.isNaN(n)) throw new Error(`Invalid nonce response: ${s}`);
    return n;
  }

  async getCode(address: string): Promise<string> {
    return (await this.rpc("pyde_getCode", [address])) as string;
  }

  async getChainId(): Promise<number> {
    const result = await this.rpc("pyde_chainId", []);
    const n = parseInt(result as string, 16);
    if (Number.isNaN(n)) throw new Error(`Invalid chainId response: ${result}`);
    return n;
  }

  async getBlockNumber(): Promise<number> {
    const result = await this.rpc("pyde_blockNumber", []);
    const n = parseInt(result as string, 16);
    if (Number.isNaN(n)) throw new Error(`Invalid blockNumber response: ${result}`);
    return n;
  }

  async getGasPrice(): Promise<bigint> {
    const result = await this.rpc("pyde_gasPrice", []);
    return BigInt(result as string);
  }

  async getStorageAt(address: string, slot: number): Promise<string> {
    return (await this.rpc("pyde_getStorageAt", [address, slot])) as string;
  }

  async getBlockByNumber(slot: number): Promise<BlockHeader | null> {
    const result = await this.rpc("pyde_getBlockByNumber", [slot]);
    return result ? (result as BlockHeader) : null;
  }

  // ========================================================================
  // Static calls & gas estimation
  // ========================================================================

  async call(to: string, data: string): Promise<string> {
    const params = {
      from: "0x" + "00".repeat(32),
      to,
      data,
    };
    return (await this.rpc("pyde_call", [params])) as string;
  }

  async estimateGas(to: string, data: string): Promise<number> {
    const params = {
      from: "0x" + "00".repeat(32),
      to,
      data,
    };
    const result = await this.rpc("pyde_estimateGas", [params]);
    const n = parseInt(result as string, 16);
    if (Number.isNaN(n)) throw new Error(`Invalid estimateGas response: ${result}`);
    return n;
  }

  // ========================================================================
  // Transaction submission
  // ========================================================================

  /** Send a raw signed transaction. Returns tx hash hex. */
  async sendRawTransaction(signedTxHex: string): Promise<string> {
    const result = await this.rpc("pyde_sendRawTransaction", [signedTxHex]);
    const s = result as string;
    // May be nested JSON
    try {
      const inner = JSON.parse(s);
      return inner.txHash || s;
    } catch {
      return s;
    }
  }

  // ========================================================================
  // Receipts
  // ========================================================================

  async getReceipt(txHash: string): Promise<Receipt | null> {
    const result = await this.rpc("pyde_getTransactionReceipt", [txHash]);
    return result ? (result as Receipt) : null;
  }

  /** Poll for receipt until available or timeout. */
  async waitForReceipt(txHash: string, timeoutMs = 10000): Promise<Receipt> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const receipt = await this.getReceipt(txHash);
      if (receipt) return receipt;
      await sleep(100);
    }
    throw new Error(`Receipt not available after ${timeoutMs}ms for tx ${txHash}`);
  }

  /** Send raw tx and wait for receipt. Throws on revert. */
  async sendAndWait(signedTxHex: string, timeoutMs = 10000): Promise<Receipt> {
    const txHash = await this.sendRawTransaction(signedTxHex);
    const receipt = await this.waitForReceipt(txHash, timeoutMs);
    if (!receipt.success) {
      throw new Error(`Transaction reverted (gas=${receipt.gasUsed})`);
    }
    return receipt;
  }

  // ========================================================================
  // Events
  // ========================================================================

  async getLogs(filter: LogFilter): Promise<Log[]> {
    return (await this.rpc("pyde_getLogs", [filter])) as Log[];
  }

  // ========================================================================
  // Internal
  // ========================================================================

  private async rpc(method: string, params: unknown[]): Promise<unknown> {
    const body = {
      jsonrpc: "2.0",
      id: ++this.rpcId,
      method,
      params,
    };

    let resp: Response;
    try {
      resp = await fetch(this.rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (e: unknown) {
      throw new Error(`Connection error: ${e instanceof Error ? e.message : String(e)}`);
    }

    if (!resp.ok) {
      throw new Error(`RPC HTTP error ${resp.status}: ${resp.statusText}`);
    }

    let json: { result?: unknown; error?: unknown } = {};
    try {
      json = await resp.json() as { result?: unknown; error?: unknown };
    } catch {
      throw new Error(`RPC error: invalid JSON response from ${method}`);
    }
    if (json.error) {
      throw new Error(`RPC error: ${JSON.stringify(json.error)}`);
    }
    return json.result;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
