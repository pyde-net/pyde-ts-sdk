import { Receipt, Log, LogFilter, BlockHeader } from "./types";
import { CallExceptionError, ConnectionError, RpcError } from "./errors";

type Listener = (...args: any[]) => void;

/**
 * WebSocket JSON-RPC provider with subscription support.
 *
 * ```ts
 * const ws = new WebSocketProvider("ws://127.0.0.1:8546");
 * await ws.ready;
 *
 * // Subscribe to new blocks
 * ws.on("block", (header) => console.log("New block:", header.slot));
 *
 * // Subscribe to contract events
 * ws.on("logs", { address: "0x..." }, (log) => console.log(log));
 *
 * // All standard Provider methods also work
 * const balance = await ws.getBalance("0x...");
 *
 * ws.destroy();
 * ```
 */
export class WebSocketProvider {
  private ws: WebSocket | null = null;
  private rpcId = 0;
  private pending: Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }> = new Map();
  private listeners: Map<string, Set<Listener>> = new Map();
  private subscriptions: Map<string, string> = new Map(); // subId → event type
  private url: string;
  private _ready: Promise<void>;
  private _resolveReady!: () => void;
  private _rejectReady!: (e: Error) => void;
  private destroyed = false;

  constructor(url: string) {
    this.url = url;
    this._ready = new Promise((resolve, reject) => {
      this._resolveReady = resolve;
      this._rejectReady = reject;
    });
    this.connect();
  }

  /** Resolves when the WebSocket connection is open. */
  get ready(): Promise<void> { return this._ready; }

  private connect(): void {
    this.ws = new WebSocket(this.url);

    // IMPORTANT: In Node 22's experimental WebSocket, addEventListener("message")
    // must be registered AFTER the "open" event to reliably receive all messages.
    // Registering before "open" causes subscription notifications to be silently dropped.
    // Use only property assignments (no addEventListener) for Node 22
    // experimental WebSocket compatibility. Mixing addEventListener with
    // property assignments causes message handler to silently drop notifications.
    const subs = this.subscriptions;
    const listeners = this.listeners;
    const pending = this.pending;
    const resolveReady = () => this._resolveReady();
    const rejectReady = (e: Error) => this._rejectReady(e);

    this.ws.onmessage = function(event: MessageEvent) {
      try {
        const data = JSON.parse(event.data as string);
        if (data.method && data.method.includes("subscription")) {
          const subId = String(data.params?.subscription);
          const result = data.params?.result;
          const eventType = subs.get(subId);
          if (eventType && result) {
            const set = listeners.get(eventType);
            if (set) for (const fn of set) fn(result);
          }
          return;
        }
        const p = pending.get(data.id);
        if (p) {
          pending.delete(data.id);
          if (data.error) {
            p.reject(new RpcError(JSON.stringify(data.error), data.error));
          } else {
            p.resolve(data.result);
          }
        }
      } catch { /* ignore */ }
    };

    this.ws.onopen = () => { resolveReady(); };

    this.ws.onerror = () => {
      rejectReady(new ConnectionError("WebSocket connection failed"));
    };

    this.ws.onclose = () => {
      for (const [, p] of pending) {
        p.reject(new ConnectionError("WebSocket closed"));
      }
      pending.clear();
    };
  }

  // Message handling is inline in connect() for Node 22 experimental WebSocket
  // compatibility. Using class methods with `this` caused subscription notifications
  // to be silently dropped due to a bug in Node 22's WebSocket implementation.

  // ========================================================================
  // Event subscriptions
  // ========================================================================

  /** Subscribe to new block headers. */
  async onBlock(listener: (header: BlockHeader) => void): Promise<void> {
    await this.ready;
    const subId = await this.rpc("pyde_subscribe", ["newHeads"]);
    this.subscriptions.set(String(subId), "block");
    this.addListener("block", listener);
  }

  /** Subscribe to pending transactions. */
  async onPendingTransaction(listener: (txHash: string) => void): Promise<void> {
    await this.ready;
    const subId = await this.rpc("pyde_subscribePending", []);
    this.subscriptions.set(String(subId), "pending");
    this.addListener("pending", listener);
  }

  /** Subscribe to contract event logs matching a filter. */
  async onLogs(filter: LogFilter, listener: (log: Log) => void): Promise<void> {
    await this.ready;
    const subId = await this.rpc("pyde_subscribeLogs", [filter]);
    this.subscriptions.set(String(subId), "logs");
    this.addListener("logs", listener);
  }

  /** Generic event listener. */
  on(event: string, listener: Listener): void {
    this.addListener(event, listener);
  }

  /** Listen once. */
  once(event: string, listener: Listener): void {
    const wrapped = (...args: any[]) => {
      this.removeListener(event, wrapped);
      listener(...args);
    };
    this.addListener(event, wrapped);
  }

  /** Remove a specific listener. */
  off(event: string, listener: Listener): void {
    this.removeListener(event, listener);
  }

  /** Remove all listeners for an event (or all events if no arg). */
  removeAllListeners(event?: string): void {
    if (event) {
      this.listeners.delete(event);
    } else {
      this.listeners.clear();
    }
  }

  private addListener(event: string, listener: Listener): void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(listener);
  }

  private removeListener(event: string, listener: Listener): void {
    this.listeners.get(event)?.delete(listener);
  }

  private emit(event: string, ...args: any[]): void {
    const set = this.listeners.get(event);
    if (set) for (const fn of set) fn(...args);
  }

  // ========================================================================
  // Standard Provider methods (same as HTTP Provider)
  // ========================================================================

  async getBalance(address: string): Promise<bigint> {
    const result = await this.rpc("pyde_getBalance", [address]);
    return BigInt(result as string);
  }

  async getNonce(address: string): Promise<number> {
    const result = await this.rpc("pyde_getTransactionCount", [address]);
    const s = result as string;
    return s.startsWith("0x") ? parseInt(s, 16) : parseInt(s, 10);
  }

  async getChainId(): Promise<number> {
    const result = await this.rpc("pyde_chainId", []);
    return parseInt(result as string, 16);
  }

  async getBlockNumber(): Promise<number> {
    const result = await this.rpc("pyde_blockNumber", []);
    return parseInt(result as string, 16);
  }

  async getGasPrice(): Promise<bigint> {
    const result = await this.rpc("pyde_gasPrice", []);
    return BigInt(result as string);
  }

  async call(to: string, data: string): Promise<string> {
    return (await this.rpc("pyde_call", [{ from: "0x" + "00".repeat(32), to, data }])) as string;
  }

  async getLogs(filter: LogFilter): Promise<Log[]> {
    return (await this.rpc("pyde_getLogs", [filter])) as Log[];
  }

  // ========================================================================
  // Cleanup
  // ========================================================================

  /** Close the WebSocket connection and clean up. */
  destroy(): void {
    this.destroyed = true;
    this.removeAllListeners();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  // ========================================================================
  // Internal RPC
  // ========================================================================

  private rpc(method: string, params: unknown[], timeoutMs = 30000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return reject(new ConnectionError("WebSocket not connected"));
      }
      const id = ++this.rpcId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ConnectionError(`WebSocket RPC timeout after ${timeoutMs}ms for ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v: any) => { clearTimeout(timer); resolve(v); },
        reject: (e: Error) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }
}
