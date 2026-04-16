import WebSocket from "ws";
import { Provider } from "./provider";
import { Log, LogFilter, BlockHeader } from "./types";
import { ConnectionError, RpcError } from "./errors";

type Listener = (...args: any[]) => void;

/**
 * WebSocket provider with subscription support.
 *
 * Uses dedicated WS server (port 8546) for subscriptions and HTTP (port 8545) for queries.
 *
 * ```ts
 * const ws = new WebSocketProvider("ws://127.0.0.1:8546");
 * await ws.ready;
 * ws.on("block", (h) => console.log(h.slot));
 * ws.on("logs", {}, (log) => console.log(log));
 * ws.destroy();
 * ```
 */
export class WebSocketProvider {
  /** The underlying WebSocket (exposed for advanced use). */
  readonly ws: WebSocket;
  readonly httpProvider: Provider;
  readonly ready: Promise<void>;

  private _rpcId = 0;
  private _pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private _listeners = new Map<string, Set<Listener>>();
  private _subscriptions = new Map<string, string>();
  private _destroyed = false;

  constructor(url: string) {
    // HTTP provider for standard queries (WS server handles subscriptions only)
    const httpUrl = url.replace("ws://", "http://").replace("wss://", "https://")
      .replace(/:(\d+)$/, (_, port) => `:${parseInt(port) - 1}`);
    this.httpProvider = new Provider(httpUrl);

    // Create WebSocket and wire up ALL handlers inline
    const ws = new WebSocket(url);
    this.ws = ws;

    // Shared state references (avoid `this` in callbacks for reliability)
    const pending = this._pending;
    const subscriptions = this._subscriptions;
    const listeners = this._listeners;

    let resolveReady: () => void;
    let rejectReady: (e: Error) => void;
    this.ready = new Promise<void>((res, rej) => { resolveReady = res; rejectReady = rej; });

    ws.on("open", () => resolveReady!());
    ws.on("error", () => rejectReady!(new ConnectionError("WebSocket connection failed")));
    ws.on("close", () => {
      for (const [, p] of pending) p.reject(new ConnectionError("WebSocket closed"));
      pending.clear();
    });

    // Handler for RPC responses (resolve/reject pending promises)
    ws.on("message", (raw: WebSocket.RawData) => {
      try {
        const data = JSON.parse(raw.toString());
        if (data.id !== undefined) {
          const p = pending.get(data.id);
          if (p) {
            pending.delete(data.id);
            if (data.error) p.reject(new RpcError(JSON.stringify(data.error), data.error));
            else p.resolve(data.result);
          }
        }
      } catch { /* ignore */ }
    });

    // Separate handler for subscription notifications (added via ws.on — both fire)
    ws.on("message", (raw: WebSocket.RawData) => {
      try {
        const data = JSON.parse(raw.toString());
        if (data.method && data.params) {
          const subId = String(data.params.subscription);
          const result = data.params.result;
          const eventType = subscriptions.get(subId);
          if (eventType && result) {
            const fns = listeners.get(eventType);
            if (fns) for (const fn of fns) fn(result);
          }
        }
      } catch { /* ignore */ }
    });
  }

  // ========================================================================
  // Subscriptions (via WS)
  // ========================================================================

  async onBlock(listener: (header: BlockHeader) => void): Promise<void> {
    await this.ready;
    const subId = await this._rpc("pyde_subscribe", ["newHeads"]);
    this._subscriptions.set(String(subId), "block");
    this._addListener("block", listener);
  }

  async onPendingTransaction(listener: (txHash: string) => void): Promise<void> {
    await this.ready;
    const subId = await this._rpc("pyde_subscribePending", []);
    this._subscriptions.set(String(subId), "pending");
    this._addListener("pending", listener);
  }

  async onLogs(filter: LogFilter, listener: (log: Log) => void): Promise<void> {
    await this.ready;
    const subId = await this._rpc("pyde_subscribeLogs", [filter]);
    this._subscriptions.set(String(subId), "logs");
    this._addListener("logs", listener);
  }

  on(event: string, listener: Listener): void { this._addListener(event, listener); }
  once(event: string, listener: Listener): void {
    const w = (...args: any[]) => { this._removeListener(event, w); listener(...args); };
    this._addListener(event, w);
  }
  off(event: string, listener: Listener): void { this._removeListener(event, listener); }
  removeAllListeners(event?: string): void {
    if (event) this._listeners.delete(event); else this._listeners.clear();
  }

  // ========================================================================
  // Queries (via HTTP)
  // ========================================================================

  async getBalance(address: string): Promise<bigint> { return this.httpProvider.getBalance(address); }
  async getNonce(address: string): Promise<number> { return this.httpProvider.getNonce(address); }
  async getChainId(): Promise<number> { return this.httpProvider.getChainId(); }
  async getBlockNumber(): Promise<number> { return this.httpProvider.getBlockNumber(); }
  async getGasPrice(): Promise<bigint> { return this.httpProvider.getGasPrice(); }
  async call(to: string, data: string): Promise<string> { return this.httpProvider.call(to, data); }
  async getLogs(filter: LogFilter): Promise<Log[]> { return this.httpProvider.getLogs(filter); }

  // ========================================================================
  // Cleanup
  // ========================================================================

  destroy(): void {
    this._destroyed = true;
    this._listeners.clear();
    this.ws.close();
  }

  // ========================================================================
  // Internal
  // ========================================================================

  private _addListener(event: string, listener: Listener): void {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event)!.add(listener);
  }
  private _removeListener(event: string, listener: Listener): void {
    this._listeners.get(event)?.delete(listener);
  }

  private _rpc(method: string, params: unknown[], timeoutMs = 30000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (this.ws.readyState !== WebSocket.OPEN) {
        return reject(new ConnectionError("WebSocket not connected"));
      }
      const id = ++this._rpcId;
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new ConnectionError(`WS RPC timeout for ${method}`));
      }, timeoutMs);
      this._pending.set(id, {
        resolve: (v: any) => { clearTimeout(timer); resolve(v); },
        reject: (e: Error) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }
}
