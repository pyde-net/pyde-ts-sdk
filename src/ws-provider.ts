/**
 * WebSocket Provider — live subscriptions over JSON-RPC.
 *
 * Spec sources:
 *   - Chapter 17.4    — `pyde_subscribe`: newHeads / accountChanges / logs
 *   - HOST_FN_ABI §15.5 — subscription mechanics + at-least-once delivery
 *                         + cursor-based resume via `from: EventCursor`
 *
 * What this module provides:
 *   - Isomorphic transport: uses `globalThis.WebSocket` (browser native,
 *     Node 22+ native). Inject `options.webSocketConstructor` for Node 20
 *     or any environment without a global.
 *   - Three subscription kinds with per-subscription unsubscribe handles.
 *   - Automatic reconnect with exponential backoff. On reconnect, all
 *     active subscriptions are re-issued — `logs` resumes from the last
 *     delivered cursor (HOST_FN_ABI §15.5: at-least-once with subscriber
 *     reconciliation via cursor).
 *   - Falls back to an HTTP `Provider` for non-subscription queries so a
 *     single `WebSocketProvider` instance covers the full read surface.
 *
 * Delivery guarantees (from §15.5):
 *   - Post-commit only — no pending notifications.
 *   - Canonical order — events arrive in `(wave_id, tx_index, event_index)`.
 *   - At-least-once — listeners may see duplicates around a reconnect.
 *     Each `Log` carries its cursor coordinates; callers that need
 *     exactly-once semantics should dedupe by `(waveId, txIndex, eventIndex)`.
 */

import { Provider, enforceSecureScheme } from "./provider";
import type { Log, WaveHeader, Account, EventCursor, Hash } from "./types";
import { ConnectionError, RpcError, TimeoutError } from "./errors";

// ============================================================================
// Public types
// ============================================================================

/** Constructor type compatible with browser + Node WebSocket. */
export type WebSocketCtor = new (url: string, protocols?: string | string[]) => WebSocketLike;

/** Event surface for `WebSocketProvider.on(...)`. */
export type WebSocketProviderEvent = "terminalError";
type WSEventListener = (error: Error) => void;

/** Minimal WebSocket surface this module uses. */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
}

export interface WebSocketProviderOptions {
  /** Custom WebSocket constructor (for environments lacking `globalThis.WebSocket`,
   *  e.g. Node < 22 without `--experimental-websocket` or the `ws` package). */
  webSocketConstructor?: WebSocketCtor;
  /** HTTP RPC URL used for non-subscription queries (getBalance / etc).
   *  If absent, derived from the WS URL by swapping `ws[s]://` → `http[s]://`
   *  on the same host + port. */
  httpRpcUrl?: string;
  /** Initial reconnect delay in ms. Default 1,000. */
  reconnectInitialDelayMs?: number;
  /** Max delay between reconnect attempts in ms. Default 30,000. */
  reconnectMaxDelayMs?: number;
  /** Max reconnect attempts. 0 = infinite. Default 0. */
  reconnectMaxAttempts?: number;
  /** RPC call timeout in ms. Default 30,000. */
  rpcTimeoutMs?: number;
  /** Allow non-TLS `ws://` transports. Default false. See ProviderOptions. */
  allowInsecureTransport?: boolean;
}

/** Filter for `subscribeLogs` — same positional topics + contract shape as
 *  `LogFilter` minus wave bounds (live subscription) plus optional
 *  resume-from cursor. Spec: HOST_FN_ABI §15.5 LogSubscription. */
export interface LogSubscriptionFilter {
  /** Positional topic filter (0-3). null at position i = any. */
  topics?: (Hash[] | null)[];
  /** Optional contract address restriction. */
  contract?: string;
  /** Resume from this cursor (for at-least-once after a disconnect).
   *  Omit to receive only events committed AFTER subscription time. */
  from?: EventCursor;
}

/** Handle to an active subscription. Call to unsubscribe + remove listener. */
export type Unsubscribe = () => Promise<void>;

// ============================================================================
// Internal state
// ============================================================================

type Resolver<T> = { resolve: (v: T) => void; reject: (e: Error) => void };

interface NewHeadsSub {
  kind: "newHeads";
  serverSubId: string | null;
  listener: (h: WaveHeader) => void;
}

interface AccountChangesSub {
  kind: "accountChanges";
  serverSubId: string | null;
  address: string;
  listener: (a: Account) => void;
}

interface LogsSub {
  kind: "logs";
  serverSubId: string | null;
  filter: LogSubscriptionFilter;
  /** Last delivered cursor; used to resume on reconnect (§15.5 at-least-once). */
  lastCursor: EventCursor | null;
  listener: (log: Log) => void;
}

type LocalSub = NewHeadsSub | AccountChangesSub | LogsSub;

const WS_OPEN = 1;

// ============================================================================
// WebSocketProvider
// ============================================================================

export class WebSocketProvider {
  /** HTTP Provider for non-subscription queries (getBalance, getWave, etc). */
  readonly http: Provider;
  /** Resolves once the initial connection is established. */
  readonly ready: Promise<void>;

  private url: string;
  private opts: Required<
    Omit<WebSocketProviderOptions, "webSocketConstructor" | "httpRpcUrl" | "allowInsecureTransport">
  > & {
    webSocketConstructor: WebSocketCtor;
  };
  private ws: WebSocketLike | null = null;
  private rpcId = 0;
  private pending = new Map<number, Resolver<unknown>>();
  /** Local subscription id → state. Local IDs are stable across reconnects. */
  private subs = new Map<number, LocalSub>();
  private localSubId = 0;
  private destroyed = false;
  private reconnectAttempt = 0;
  private resolveReady!: () => void;
  private rejectReady!: (e: Error) => void;
  /** Last error that ended the reconnect cycle (if any). Available
   *  after the `terminalError` event fires. */
  private _lastError: Error | null = null;
  private terminalListeners = new Set<WSEventListener>();

  constructor(url: string, options?: WebSocketProviderOptions) {
    enforceSecureScheme(url, options?.allowInsecureTransport, "WebSocketProvider");
    this.url = url;
    const ctor = options?.webSocketConstructor ?? globalThisWebSocket();
    if (!ctor) {
      throw new Error(
        "No WebSocket constructor available. Pass options.webSocketConstructor (e.g. require('ws')) on Node < 22.",
      );
    }
    this.opts = {
      webSocketConstructor: ctor,
      reconnectInitialDelayMs: options?.reconnectInitialDelayMs ?? 1_000,
      reconnectMaxDelayMs: options?.reconnectMaxDelayMs ?? 30_000,
      reconnectMaxAttempts: options?.reconnectMaxAttempts ?? 0,
      rpcTimeoutMs: options?.rpcTimeoutMs ?? 30_000,
    };
    // The HTTP fallback honors the same insecure-transport allowance
    // the WS endpoint was granted.
    this.http = new Provider(options?.httpRpcUrl ?? wsToHttp(url), {
      ...(options?.allowInsecureTransport ? { allowInsecureTransport: true } : {}),
    });
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.connect();
  }

  // ==========================================================================
  // Subscriptions (per chapter 17.4 + HOST_FN_ABI §15.5)
  // ==========================================================================

  /** Subscribe to wave commits (`pyde_subscribe({method: "newHeads"})`). */
  async subscribeNewHeads(listener: (header: WaveHeader) => void): Promise<Unsubscribe> {
    await this.ready;
    const local = this.registerLocal({ kind: "newHeads", serverSubId: null, listener });
    await this.serverSubscribe(local);
    return () => this.unsubscribe(local);
  }

  /** Subscribe to state changes for a specific account
   *  (`pyde_subscribe({method: "accountChanges", address})`). */
  async subscribeAccountChanges(
    address: string,
    listener: (account: Account) => void,
  ): Promise<Unsubscribe> {
    await this.ready;
    const local = this.registerLocal({
      kind: "accountChanges",
      serverSubId: null,
      address,
      listener,
    });
    await this.serverSubscribe(local);
    return () => this.unsubscribe(local);
  }

  /** Subscribe to live events matching `filter`. Pass `filter.from` to
   *  resume from a prior cursor (HOST_FN_ABI §15.5 at-least-once). */
  async subscribeLogs(
    filter: LogSubscriptionFilter,
    listener: (log: Log) => void,
  ): Promise<Unsubscribe> {
    await this.ready;
    const local = this.registerLocal({
      kind: "logs",
      serverSubId: null,
      filter,
      lastCursor: filter.from ?? null,
      listener,
    });
    await this.serverSubscribe(local);
    return () => this.unsubscribe(local);
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  /** Close the connection + tear down all subscriptions. The instance is
   *  unusable after destroy. */
  destroy(): void {
    this.destroyed = true;
    this.subs.clear();
    this.pending.forEach((p) => p.reject(new ConnectionError("WebSocketProvider destroyed")));
    this.pending.clear();
    this.terminalListeners.clear();
    this.ws?.close();
    this.ws = null;
  }

  /** Subscribe to provider-level events. Currently exposes
   *  `terminalError` — fired exactly once when reconnect gives up. */
  on(event: WebSocketProviderEvent, listener: WSEventListener): void {
    if (event === "terminalError") this.terminalListeners.add(listener);
  }

  /** Unsubscribe from a provider-level event. */
  off(event: WebSocketProviderEvent, listener: WSEventListener): void {
    if (event === "terminalError") this.terminalListeners.delete(listener);
  }

  /** Last error that ended the reconnect cycle (null if not terminal). */
  get lastError(): Error | null {
    return this._lastError;
  }

  // ==========================================================================
  // Internals — connection + reconnect
  // ==========================================================================

  private connect(): void {
    if (this.destroyed) return;
    const ws = new this.opts.webSocketConstructor(this.url);
    this.ws = ws;
    ws.onopen = () => this.onOpen();
    ws.onmessage = (ev) => this.onMessage(ev.data);
    ws.onerror = () => this.onError();
    ws.onclose = () => this.onClose();
  }

  private onOpen(): void {
    // Reset reconnect counter only after subs are re-issued successfully;
    // an open-then-immediate-close cycle that loses every sub mid-flight
    // should still count toward the max.
    if (this.subs.size === 0) {
      this.reconnectAttempt = 0;
      this.resolveReady();
      return;
    }
    // Reconnect: re-issue every active subscription with the right
    // `from` cursor for logs (§15.5 at-least-once resume). Reset the
    // attempt counter only once every active sub has re-issued cleanly.
    Promise.all(
      Array.from(this.subs.values()).map((sub) =>
        this.serverSubscribe(sub).catch(() => false as const),
      ),
    ).then((results) => {
      if (results.every((r) => r !== false)) {
        this.reconnectAttempt = 0;
      }
      // If any sub failed to re-issue we leave the counter alone — the
      // next onClose will increment it and the cycle continues.
    });
    this.resolveReady();
  }

  private onMessage(raw: unknown): void {
    let msg: Record<string, unknown>;
    try {
      msg = typeof raw === "string" ? JSON.parse(raw) : JSON.parse(String(raw));
    } catch {
      return;
    }

    // RPC response (has `id`).
    if (msg.id !== undefined) {
      const id = Number(msg.id);
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      if (msg.error) {
        pending.reject(new RpcError(JSON.stringify(msg.error), msg.error));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    // Subscription notification (no `id`; has `method: "pyde_subscription"`).
    if (msg.method === "pyde_subscription" && msg.params && typeof msg.params === "object") {
      const params = msg.params as { subscription?: unknown; result?: unknown };
      const serverSubId = typeof params.subscription === "string" ? params.subscription : null;
      if (!serverSubId) return;
      this.dispatch(serverSubId, params.result);
    }
  }

  private onError(): void {
    if (this.subs.size === 0 && this.reconnectAttempt === 0) {
      // Initial connect failed; surface to ready() caller.
      this.rejectReady(new ConnectionError("WebSocket connection failed"));
    }
  }

  private onClose(): void {
    if (this.destroyed) return;
    this.failPending(new ConnectionError("WebSocket closed"));
    // Schedule a reconnect with exponential backoff.
    if (
      this.opts.reconnectMaxAttempts > 0 &&
      this.reconnectAttempt >= this.opts.reconnectMaxAttempts
    ) {
      const err = new ConnectionError(
        `WebSocket reconnect gave up after ${this.opts.reconnectMaxAttempts} attempts`,
      );
      this._lastError = err;
      this.destroyed = true;
      for (const listener of this.terminalListeners) {
        try {
          listener(err);
        } catch {
          // Listener errors must not break peer subscribers.
        }
      }
      return;
    }
    this.reconnectAttempt += 1;
    const delay = Math.min(
      this.opts.reconnectInitialDelayMs * 2 ** (this.reconnectAttempt - 1),
      this.opts.reconnectMaxDelayMs,
    );
    setTimeout(() => this.connect(), delay);
  }

  private failPending(e: Error): void {
    this.pending.forEach((p) => p.reject(e));
    this.pending.clear();
  }

  // ==========================================================================
  // Internals — dispatch
  // ==========================================================================

  private dispatch(serverSubId: string, result: unknown): void {
    for (const sub of this.subs.values()) {
      if (sub.serverSubId !== serverSubId) continue;
      switch (sub.kind) {
        case "newHeads":
          sub.listener(this.toWaveHeader(result));
          return;
        case "accountChanges":
          sub.listener(this.toAccount(result));
          return;
        case "logs": {
          const log = this.toLog(result);
          sub.lastCursor = { waveId: log.waveId, txIndex: log.txIndex, eventIndex: log.eventIndex };
          sub.listener(log);
          return;
        }
      }
    }
  }

  // ==========================================================================
  // Internals — server subscribe / unsubscribe
  // ==========================================================================

  private registerLocal<S extends LocalSub>(sub: S): S {
    const id = ++this.localSubId;
    this.subs.set(id, sub);
    return sub;
  }

  private async serverSubscribe(sub: LocalSub): Promise<void> {
    // Engine RPC catalog v0.1 only supports `"logs"` over `pyde_subscribe`.
    // `newHeads` / `accountChanges` would surface as `INVALID_PARAMS`
    // server-side; reject locally with a clearer message so callers
    // don't conflate "engine missing the subscription" with "subscribe
    // call malformed".
    if (sub.kind !== "logs") {
      throw new RpcError(
        `pyde_subscribe v1 only supports event_type="logs"; ` +
          `${sub.kind} is on the engine roadmap (not yet wired).`,
      );
    }
    const params = this.subscribeParams(sub);
    const result = await this.rpc("pyde_subscribe", params);
    if (typeof result !== "string") {
      throw new RpcError(
        `pyde_subscribe returned non-string subscription id: ${JSON.stringify(result)}`,
      );
    }
    sub.serverSubId = result;
  }

  /** Build the positional `pyde_subscribe` params array:
   *    [event_type: "logs", filter: { from_wave?, to_wave?, contracts?,
   *                                   topics?, cursor? }]
   *  Spec: engine RPC catalog v0.1 §25. */
  private subscribeParams(sub: LocalSub): unknown[] {
    if (sub.kind !== "logs") {
      // Unreachable — `serverSubscribe` short-circuits non-logs subs.
      throw new RpcError(`unreachable: subscribeParams(${sub.kind})`);
    }
    const topics: (string[] | null)[] = [null, null, null, null];
    if (sub.filter.topics) {
      for (let i = 0; i < Math.min(4, sub.filter.topics.length); i++) {
        topics[i] = sub.filter.topics[i] ?? null;
      }
    }
    const filter: Record<string, unknown> = {
      // `contracts` is the plural array shape the engine expects
      // (within-array OR). SDK's single-contract filter wraps into
      // a 1-element array on the wire.
      contracts: sub.filter.contract != null ? [sub.filter.contract] : null,
      topics,
    };
    // Resume from the last delivered cursor on reconnect; otherwise the
    // initial caller-supplied `from`, if any. Spec: §15.5.
    const from = sub.lastCursor;
    if (from) {
      filter.cursor = {
        wave_id: from.waveId,
        tx_index: from.txIndex,
        event_index: from.eventIndex,
      };
    }
    return ["logs", filter];
  }

  private async unsubscribe(sub: LocalSub): Promise<void> {
    const subId = sub.serverSubId;
    // Remove from local registry regardless of server-side result.
    const entry = [...this.subs.entries()].find(([_, s]) => s === sub);
    if (entry) this.subs.delete(entry[0]);
    if (subId && this.ws?.readyState === WS_OPEN) {
      try {
        await this.rpc("pyde_unsubscribe", [subId]);
      } catch {
        // Server may not support pyde_unsubscribe explicitly; subscription
        // dies with the connection regardless.
      }
    }
  }

  // ==========================================================================
  // Internals — RPC over WS
  // ==========================================================================

  private rpc(method: string, params: unknown[]): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WS_OPEN) {
        reject(new ConnectionError("WebSocket not connected"));
        return;
      }
      const id = ++this.rpcId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new TimeoutError(`WS RPC timeout for ${method}`));
      }, this.opts.rpcTimeoutMs);
      this.pending.set(id, {
        resolve: (v: unknown) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e: Error) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  // ==========================================================================
  // Internals — wire ⇄ TS converters (tolerant of both snake_case + camelCase)
  // ==========================================================================

  private toWaveHeader(w: unknown): WaveHeader {
    const o = w as Record<string, unknown>;
    const out: WaveHeader = {
      waveId: bigHex(o.wave_id ?? o.waveId, "waveId"),
      timestamp: asString(o.timestamp, "timestamp"),
      anchor: asString(o.anchor, "anchor"),
    };
    if (o.state_root ?? o.stateRoot)
      out.stateRoot = asString(o.state_root ?? o.stateRoot, "stateRoot");
    if (o.events_root ?? o.eventsRoot)
      out.eventsRoot = asString(o.events_root ?? o.eventsRoot, "eventsRoot");
    if (o.tx_count !== undefined || o.txCount !== undefined) {
      out.txCount = numHex(o.tx_count ?? o.txCount, "txCount");
    }
    return out;
  }

  private toLog(w: unknown): Log {
    const o = w as Record<string, unknown>;
    return {
      waveId: bigHex(o.wave_id ?? o.waveId, "waveId"),
      txIndex: numHex(o.tx_index ?? o.txIndex, "txIndex"),
      eventIndex: numHex(o.event_index ?? o.eventIndex, "eventIndex"),
      contract: asString(o.contract_addr ?? o.contract ?? o.address, "contract"),
      topics: ((o.topics ?? []) as unknown[]).map((t) => asString(t, "topic")),
      data: asString(o.data, "data"),
    };
  }

  private toAccount(w: unknown): Account {
    // accountChanges pushes the same shape as `pyde_getAccount`.
    const o = w as Record<string, unknown>;
    return {
      address: asString(o.address, "address"),
      nonce: bigHex(o.nonce, "nonce"),
      balance: BigInt(asString(o.balance, "balance")),
      codeHash: asString(o.code_hash ?? o.codeHash, "codeHash"),
      stateRoot: asString(
        o.state_root ?? o.stateRoot ?? o.storage_root ?? o.storageRoot,
        "stateRoot",
      ),
      accountType: numHex(o.account_type ?? o.accountType, "accountType") as Account["accountType"],
      authKeys: asString(o.auth_keys ?? o.authKeys, "authKeys"),
      gasTank: BigInt(asString(o.gas_tank ?? o.gasTank, "gasTank")),
      keyNonce: numHex(o.key_nonce ?? o.keyNonce, "keyNonce"),
    };
  }
}

// ============================================================================
// Helpers
// ============================================================================

function globalThisWebSocket(): WebSocketCtor | undefined {
  const g = globalThis as { WebSocket?: WebSocketCtor };
  return g.WebSocket;
}

/** Convert a ws:// or wss:// URL to the http(s) sibling, preserving
 *  host, port, path, query, and fragment. If the URL has a path that
 *  isn't the HTTP RPC endpoint, callers should pass `options.httpRpcUrl`
 *  explicitly rather than relying on this helper. */
function wsToHttp(wsUrl: string): string {
  try {
    const u = new URL(wsUrl);
    if (u.protocol === "wss:") u.protocol = "https:";
    else if (u.protocol === "ws:") u.protocol = "http:";
    return u.toString();
  } catch {
    // Fallback to prefix-swap for URLs the URL constructor can't parse
    // (rare; mostly malformed input that should already be rejected
    // upstream).
    if (wsUrl.startsWith("wss://")) return "https://" + wsUrl.slice(6);
    if (wsUrl.startsWith("ws://")) return "http://" + wsUrl.slice(5);
    return wsUrl;
  }
}

function asString(v: unknown, ctx: string): string {
  if (typeof v !== "string") {
    throw new RpcError(`${ctx} not a string: ${JSON.stringify(v)}`);
  }
  return v;
}

function numHex(v: unknown, ctx: string): number {
  if (typeof v === "number") return v;
  const s = asString(v, ctx);
  const n = s.startsWith("0x") ? parseInt(s, 16) : parseInt(s, 10);
  if (!Number.isFinite(n)) throw new RpcError(`${ctx} not a number: ${s}`);
  return n;
}

/** Bigint variant for u64 wire fields. Accepts numbers, hex strings,
 *  decimal strings, and bigints. */
function bigHex(v: unknown, ctx: string): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(v);
  const s = asString(v, ctx);
  try {
    return BigInt(s);
  } catch {
    throw new RpcError(`${ctx} not a u64: ${s}`);
  }
}
