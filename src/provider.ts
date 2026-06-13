/**
 * HTTP JSON-RPC client. Read-only RPC surface for the Pyde chain.
 *
 * Spec sources:
 *   - Chapter 17.4    — JSON-RPC method catalog
 *   - HOST_FN_ABI §15 — events + cursor pagination shape (getLogs)
 *   - Chapter 6       — wave / HardFinalityCert
 *   - Chapter 10      — fee model (no tips in v1)
 *   - Chapter 11      — account model
 *   - STATE_SYNC.md   — snapshot manifest
 *
 * Wire conventions:
 *   - Requests + responses use snake_case on the wire; this SDK exposes
 *     camelCase to TS callers. Per-method translation happens in the
 *     small `toWire*` / `fromWire*` helpers at the bottom of the file
 *     so the public surface is idiomatic TS.
 *   - Numbers: u64 + u32 ride the wire as hex strings (`0x` prefix) for
 *     safety; the SDK parses back to `number` (≤ 2^53) or `bigint`
 *     (u128 / u256) at the boundary.
 *
 * Transaction submission, encrypted-tx, and WebSocket subscriptions
 * live in their respective phases — this module is the read-only +
 * tx-submission HTTP surface.
 */

import type {
  Receipt,
  Log,
  LogFilter,
  GetLogsResponse,
  EventCursor,
  WaveHeader,
  HardFinalityCert,
  SnapshotManifest,
  Account,
  AccountTypeDiscriminant,
  TransactionInfo,
  TransactionResponse,
  FeeData,
  CallOverrides,
  AccessEntry,
} from "./types";
import { AccountType } from "./types";
import {
  CallExceptionError,
  ConnectionError,
  RpcError,
  TimeoutError,
} from "./errors";

/** Options for the Provider's HTTP transport. */
export interface ProviderOptions {
  /** Request timeout in milliseconds (default 30,000). */
  timeout?: number;
  /** Retry attempts on transport failures (default 0). */
  retries?: number;
  /** Custom HTTP headers (e.g. auth keys, x-trace-id). */
  headers?: Record<string, string>;
}

/**
 * HTTP JSON-RPC client for a Pyde node.
 *
 * ```ts
 * const provider = new Provider("https://rpc.pyde.network");
 * const balance = await provider.getBalance("0x...");
 * ```
 */
export class Provider {
  readonly rpcUrl: string;
  private rpcId = 0;
  private cachedChainId: number | null = null;
  private options: Required<Omit<ProviderOptions, "headers">> & {
    headers: Record<string, string>;
  };

  constructor(rpcUrl: string, options?: ProviderOptions) {
    this.rpcUrl = rpcUrl;
    this.options = {
      timeout: options?.timeout ?? 30_000,
      retries: options?.retries ?? 0,
      headers: options?.headers ?? {},
    };
  }

  // ========================================================================
  // Account queries
  // ========================================================================

  /** Return the spendable balance (quanta, u128). Spec: chapter 17.4. */
  async getBalance(address: string): Promise<bigint> {
    const result = await this.call_("pyde_getBalance", [address]);
    return BigInt(asString(result, "pyde_getBalance"));
  }

  /** Return the account's low-end nonce (next available slot in the
   *  16-slot sliding window per Chapter 11). Spec: chapter 17.4.
   *
   *  Backward-compat: some chain builds still expose this only under
   *  the pre-pivot `pyde_getTransactionCount` name. Falls back when the
   *  canonical name isn't found. Remove the fallback once the engine
   *  rename ships. */
  async getNonce(address: string): Promise<number> {
    const result = await this.callWithFallback(
      ["pyde_getNonce", "pyde_getTransactionCount"],
      [address],
    );
    return parseUintLoose(result, "getNonce");
  }

  /** Return the chain ID (used for replay protection in signed txs).
   *  Result is cached per Provider instance (chain ID is genesis-immutable). */
  async getChainId(): Promise<number> {
    if (this.cachedChainId !== null) return this.cachedChainId;
    const result = await this.call_("pyde_chainId", []);
    const n = parseUint(asString(result, "pyde_chainId"), "pyde_chainId");
    this.cachedChainId = n;
    return n;
  }

  /** Fetch nonce + chainId in one round-trip (used when building a tx). */
  async getNonceAndChainId(address: string): Promise<[number, number]> {
    const [nonce, chainId] = await Promise.all([
      this.getNonce(address),
      this.getChainId(),
    ]);
    return [nonce, chainId];
  }

  /** Return the full account record. Spec: Chapter 11 §11.1 + chapter 17.4. */
  async getAccount(address: string): Promise<Account | null> {
    const result = await this.call_("pyde_getAccount", [address]);
    return result ? fromWireAccount(result) : null;
  }

  // ========================================================================
  // Contract queries
  // ========================================================================

  /** Return the contract's WASM bytecode as hex. Empty string for EOAs.
   *  Spec: chapter 17.4 `pyde_getContractCode`. */
  async getContractCode(address: string): Promise<string> {
    return asString(
      await this.call_("pyde_getContractCode", [address]),
      "pyde_getContractCode",
    );
  }

  /** Return the value of a single contract state slot.
   *  Spec: chapter 17.4 `pyde_getContractState`. */
  async getContractState(address: string, slotHash: string): Promise<string> {
    return asString(
      await this.call_("pyde_getContractState", [address, slotHash]),
      "pyde_getContractState",
    );
  }

  // ========================================================================
  // PNS name resolution
  // ========================================================================

  /** Resolve a Pyde Name Service `.pyde` name to its 32-byte address.
   *  Returns null if the name is unregistered. Spec: chapter 17.4. */
  async resolveName(name: string): Promise<string | null> {
    const result = await this.call_("pyde_resolveName", [name]);
    return result == null ? null : asString(result, "pyde_resolveName");
  }

  // ========================================================================
  // Wave + finality
  // ========================================================================

  /** Return the header for a wave (omit `waveId` for the latest committed
   *  wave). Spec: chapter 17.4 `pyde_getWave`.
   *
   *  Backward-compat: the engine currently requires the `wave_id`
   *  param. When omitted the SDK resolves "latest" via a synthetic
   *  block-number query first and then fetches that wave. */
  async getWave(waveId?: number): Promise<WaveHeader | null> {
    let target = waveId;
    if (target === undefined) {
      target = await this.latestWaveId();
    }
    const result = await this.call_("pyde_getWave", [target]);
    return result ? fromWireWaveHeader(result) : null;
  }

  /** Internal: resolve the current head wave id via either
   *  `pyde_blockNumber` (pre-pivot name still wired by the engine) or a
   *  receipt-style indirection. Used by `getWave()` when no wave id is
   *  passed explicitly. */
  private async latestWaveId(): Promise<number> {
    const result = await this.callWithFallback(["pyde_getWaveNumber", "pyde_blockNumber"], []);
    return parseUintLoose(result, "latestWaveId");
  }

  /** Return the threshold-signed hard finality certificate for a wave.
   *  Spec: Chapter 6 + chapter 17.4 `pyde_getHardFinalityCert`. */
  async getHardFinalityCert(waveId: number): Promise<HardFinalityCert | null> {
    const result = await this.call_("pyde_getHardFinalityCert", [waveId]);
    return result ? fromWireHardFinalityCert(result) : null;
  }

  // ========================================================================
  // State sync
  // ========================================================================

  /** Return the snapshot manifest for a wave (light-client state sync).
   *  Spec: STATE_SYNC.md + chapter 17.4 `pyde_getSnapshotManifest`. */
  async getSnapshotManifest(waveId: number): Promise<SnapshotManifest | null> {
    const result = await this.call_("pyde_getSnapshotManifest", [waveId]);
    return result ? fromWireSnapshotManifest(result) : null;
  }

  // ========================================================================
  // Fee data
  // ========================================================================

  /** Return the current base fee (gas-price = base in v1; no priority tip).
   *  Spec: Chapter 10 + chapter 17.4 `pyde_getBaseFee`.
   *
   *  Backward-compat: pre-pivot chain builds expose this as
   *  `pyde_gasPrice`. Falls back automatically. */
  async getBaseFee(): Promise<bigint> {
    const result = await this.callWithFallback(["pyde_getBaseFee", "pyde_gasPrice"], []);
    return BigInt(asString(result, "getBaseFee"));
  }

  /** Convenience wrapper that surfaces the same value under two names
   *  (gasPrice + baseFee). Pyde has no priority tips in v1, so they are
   *  always equal. Spec: Chapter 10. */
  async getFeeData(): Promise<FeeData> {
    const base = await this.getBaseFee();
    return { gasPrice: base, baseFee: base };
  }

  // ========================================================================
  // View calls + gas / access estimation
  // ========================================================================

  /** Off-chain view-function call. Free; no tx, no consensus. Spec:
   *  chapter 17.4 — bounded by per-call instruction cap on the node. */
  async call(to: string, data: string, overrides?: CallOverrides): Promise<string> {
    const params = this.buildCallParams(to, data, overrides);
    return asString(await this.call_("pyde_call", [params]), "pyde_call");
  }

  /** Estimate gas for a call. Spec: chapter 17.4 `pyde_estimateGas`. */
  async estimateGas(
    to: string,
    data: string,
    overrides?: CallOverrides,
  ): Promise<number> {
    const params = this.buildCallParams(to, data, overrides);
    const result = await this.call_("pyde_estimateGas", [params]);
    return parseUint(asString(result, "pyde_estimateGas"), "pyde_estimateGas");
  }

  /**
   * Simulate the call and return the access list (slots the call would
   * read / write). Used by wallets to attach an access list to the
   * outgoing tx so the chain's parallel scheduler can place it without
   * blocking. Spec: chapter 17.4 `pyde_estimateAccess`.
   */
  async estimateAccess(params: {
    to: string;
    data: string;
    from?: string;
    value?: bigint | number | string;
    gasLimit?: number;
  }): Promise<AccessEntry[]> {
    const wire: Record<string, unknown> = {
      from: params.from ?? ZERO_ADDR,
      to: params.to,
      data: params.data,
    };
    if (params.value !== undefined) wire.value = bigIntToHex(params.value);
    if (params.gasLimit !== undefined) wire.gas = "0x" + params.gasLimit.toString(16);
    const result = await this.call_("pyde_estimateAccess", [wire]);
    return parseAccessList(result);
  }

  // ========================================================================
  // Transaction submission
  // ========================================================================

  /** Submit a signed transaction (wire-hex from `signTransaction`).
   *  Spec: chapter 17.4 `pyde_sendRawTransaction`. */
  async sendRawTransaction(signedTxHex: string): Promise<TransactionResponse> {
    const result = await this.call_("pyde_sendRawTransaction", [signedTxHex]);
    return this.buildTxResponse(extractTxHash(result));
  }

  /**
   * Fetch the committee's threshold public key (wire bytes hex). Cache
   * per session — the key only rotates with the committee, and rotation
   * preserves the pubkey (only shares rotate). Required input to
   * `buildRawEncryptedTx`. Spec: Chapter 8.5 + chapter 17.4.
   */
  async getThresholdPublicKey(): Promise<string> {
    return asString(
      await this.call_("pyde_getThresholdPublicKey", []),
      "pyde_getThresholdPublicKey",
    );
  }

  /**
   * Submit a client-built, client-signed `EncryptedTx` (wire-hex from
   * `buildRawEncryptedTx`). Plaintext never leaves the client; the
   * signature binds to a ciphertext the client produced. Canonical
   * MEV-protected submission path. Spec: Chapter 8.5 + Chapter 9 +
   * chapter 17.4 `pyde_sendRawEncryptedTransaction`.
   */
  async sendRawEncryptedTransaction(
    encTxHex: string,
  ): Promise<TransactionResponse> {
    const result = await this.call_("pyde_sendRawEncryptedTransaction", [encTxHex]);
    return this.buildTxResponse(asString(result, "pyde_sendRawEncryptedTransaction"));
  }

  // ========================================================================
  // Transaction lookup + receipts
  // ========================================================================

  /** Look up a committed transaction by hash. Returns null if absent.
   *  Spec: chapter 17.4 `pyde_getTransactionByHash`. */
  async getTransaction(txHash: string): Promise<TransactionInfo | null> {
    const result = await this.call_("pyde_getTransactionByHash", [txHash]);
    return result ? fromWireTransactionInfo(result) : null;
  }

  /** Fetch a receipt. Returns null if the tx hasn't committed yet (and
   *  the node knows that's the reason it has no receipt). Spec: chapter 17.4. */
  async getTransactionReceipt(txHash: string): Promise<Receipt | null> {
    try {
      const result = await this.call_("pyde_getTransactionReceipt", [txHash]);
      return result ? fromWireReceipt(result) : null;
    } catch (e) {
      if (isReceiptNotFound(e)) return null;
      throw e;
    }
  }

  /** Poll until the receipt is available or `timeoutMs` elapses. */
  async waitForReceipt(txHash: string, timeoutMs = 10_000): Promise<Receipt> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const r = await this.getTransactionReceipt(txHash);
      if (r) return r;
      await sleep(100);
    }
    throw new TimeoutError(
      `Receipt not available after ${timeoutMs}ms for tx ${txHash}`,
    );
  }

  /** Send + wait + throw on revert. Convenience for one-shot calls. */
  async sendAndWait(signedTxHex: string, timeoutMs = 10_000): Promise<Receipt> {
    const tx = await this.sendRawTransaction(signedTxHex);
    const r = await this.waitForReceipt(tx.hash, timeoutMs);
    if (!r.success) {
      throw new CallExceptionError(r.gasUsed, r.returnData ?? "0x");
    }
    return r;
  }

  // ========================================================================
  // Historical event queries (cursor pagination)
  // ========================================================================

  /**
   * Fetch a single page of events matching `filter`. Spec: HOST_FN_ABI
   * §15.4 — `to_wave - from_wave ≤ 5,000`, per-position topic list ≤ 8,
   * default limit 100, max 1,000.
   *
   * Returns the page + an optional `nextCursor` for the next page; pass
   * that cursor on the next call to continue. `nextCursor === undefined`
   * means the query is exhausted.
   */
  async getLogs(filter: LogFilter): Promise<GetLogsResponse> {
    const wire = toWireLogFilter(filter);
    const result = await this.call_("pyde_getLogs", [wire]);
    return fromWireGetLogsResponse(result);
  }

  // ========================================================================
  // Batch RPC
  // ========================================================================

  /**
   * Send multiple RPC calls in a single HTTP round-trip.
   *
   * ```ts
   * const [balance, nonce, chainId] = await provider.batch([
   *   { method: "pyde_getBalance", params: [addr] },
   *   { method: "pyde_getNonce",   params: [addr] },
   *   { method: "pyde_chainId",    params: [] },
   * ]);
   * ```
   *
   * Returns raw RPC results in order. Caller does any post-parsing.
   */
  async batch(calls: { method: string; params: unknown[] }[]): Promise<unknown[]> {
    const bodies = calls.map((c) => ({
      jsonrpc: "2.0" as const,
      id: ++this.rpcId,
      method: c.method,
      params: c.params,
    }));
    const results = await this.fetchJson(bodies);
    if (!Array.isArray(results)) {
      throw new RpcError("batch response was not an array");
    }
    return results.map((r) => {
      if (r && typeof r === "object" && "error" in r && r.error) {
        throw new RpcError(JSON.stringify(r.error), r.error);
      }
      return r?.result;
    });
  }

  // ========================================================================
  // Internals
  // ========================================================================

  private buildCallParams(
    to: string,
    data: string,
    overrides?: CallOverrides,
  ): Record<string, unknown> {
    const params: Record<string, unknown> = {
      from: overrides?.from ?? ZERO_ADDR,
      to,
      data,
    };
    if (overrides?.value !== undefined) params.value = bigIntToHex(overrides.value);
    if (overrides?.gasLimit !== undefined) {
      params.gas = "0x" + overrides.gasLimit.toString(16);
    }
    return params;
  }

  private buildTxResponse(hash: string): TransactionResponse {
    const provider = this;
    return {
      hash,
      wait(timeoutMs = 10_000): Promise<Receipt> {
        return provider.waitForReceipt(hash, timeoutMs);
      },
    };
  }

  /** Call the first method that responds successfully. Used to ride out
   *  the pre-pivot → post-pivot RPC rename window without burdening
   *  callers. Throws the LAST RpcError if every candidate returns
   *  -32601 (method not found) or every candidate fails for some other
   *  reason. */
  private async callWithFallback(methods: string[], params: unknown[]): Promise<unknown> {
    let lastError: unknown = null;
    for (const method of methods) {
      try {
        return await this.call_(method, params);
      } catch (e) {
        lastError = e;
        const isMethodNotFound =
          e instanceof RpcError && /-32601|method not found/i.test(e.message);
        if (!isMethodNotFound) break;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new RpcError(`every fallback failed: ${methods.join(", ")}`);
  }

  /** Single JSON-RPC call (with retry). */
  private async call_(method: string, params: unknown[]): Promise<unknown> {
    const body = {
      jsonrpc: "2.0" as const,
      id: ++this.rpcId,
      method,
      params,
    };
    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= this.options.retries; attempt++) {
      try {
        const json = await this.fetchJson(body);
        if (json && typeof json === "object" && "error" in json && json.error) {
          throw new RpcError(JSON.stringify(json.error), json.error);
        }
        return (json as { result?: unknown }).result;
      } catch (e) {
        lastError = e as Error;
        if (attempt < this.options.retries) {
          await sleep(100 * (attempt + 1));
        }
      }
    }
    throw lastError;
  }

  private async fetchJson(body: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeout);
    let resp: Response;
    try {
      resp = await fetch(this.rpcUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...this.options.headers,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e) {
      throw new ConnectionError(e instanceof Error ? e.message : String(e));
    } finally {
      clearTimeout(timer);
    }
    if (!resp.ok) {
      throw new RpcError(`HTTP ${resp.status}: ${resp.statusText}`);
    }
    try {
      return await resp.json();
    } catch {
      throw new RpcError("invalid JSON response");
    }
  }
}

// ============================================================================
// Wire <-> TS conversion helpers
// ============================================================================

const ZERO_ADDR = "0x" + "00".repeat(32);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asString(value: unknown, ctx: string): string {
  if (typeof value !== "string") {
    throw new RpcError(`${ctx} returned non-string: ${JSON.stringify(value)}`);
  }
  return value;
}

function parseUint(hex: string, ctx: string): number {
  const n = hex.startsWith("0x") ? parseInt(hex, 16) : parseInt(hex, 10);
  if (!Number.isFinite(n)) throw new RpcError(`${ctx} returned invalid number: ${hex}`);
  return n;
}

/** Tolerant uint parser — accepts plain JSON numbers + hex strings +
 *  decimal strings. Used for chain responses where the engine isn't
 *  consistently quoting numerics (a common JSON-RPC quirk). */
function parseUintLoose(v: unknown, ctx: string): number {
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new RpcError(`${ctx} returned invalid number: ${v}`);
    return v;
  }
  if (typeof v === "string") return parseUint(v, ctx);
  throw new RpcError(`${ctx} returned non-numeric: ${JSON.stringify(v)}`);
}

function bigIntToHex(v: bigint | number | string): string {
  return "0x" + BigInt(v).toString(16);
}

function isReceiptNotFound(e: unknown): boolean {
  return (
    e instanceof RpcError &&
    typeof e.message === "string" &&
    /receipt not found/i.test(e.message)
  );
}

function extractTxHash(result: unknown): string {
  // Some nodes wrap the hash in a `{txHash: "0x..."}` envelope; tolerate both.
  if (typeof result === "string") return result;
  if (result && typeof result === "object" && "txHash" in result) {
    return asString((result as { txHash: unknown }).txHash, "sendRawTransaction");
  }
  throw new RpcError(`sendRawTransaction returned unexpected shape: ${JSON.stringify(result)}`);
}

// ----------------------------------------------------------------------------
// Account
// ----------------------------------------------------------------------------

const ZERO_HASH = "0x" + "00".repeat(32);

function fromWireAccount(w: unknown): Account {
  const o = w as Record<string, unknown>;
  // Engine builds may omit zero-valued optional fields. Fill defaults
  // so callers get a stable Account shape regardless of which field
  // subset the chain serialised.
  return {
    address: asString(o.address, "Account.address"),
    nonce: tryParseUint(o.nonce) ?? 0,
    balance: tryBigInt(o.balance) ?? 0n,
    codeHash: tryString(o.code_hash ?? o.codeHash) ?? ZERO_HASH,
    storageRoot: tryString(o.storage_root ?? o.storageRoot) ?? ZERO_HASH,
    accountType: parseAccountType(o.account_type ?? o.accountType ?? 0),
    authKeys: tryString(o.auth_keys ?? o.authKeys) ?? "0x",
    gasTank: tryBigInt(o.gas_tank ?? o.gasTank) ?? 0n,
    keyNonce: tryParseUint(o.key_nonce ?? o.keyNonce) ?? 0,
  };
}

function tryString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function tryParseUint(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const n = v.startsWith("0x") ? parseInt(v, 16) : parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function tryBigInt(v: unknown): bigint | null {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return Number.isFinite(v) ? BigInt(v) : null;
  if (typeof v === "string") {
    try {
      return BigInt(v);
    } catch {
      return null;
    }
  }
  return null;
}

/** Like `asString` but tolerates JSON numbers for bigint conversion. */
function asStringOrNumber(v: unknown, ctx: string): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "bigint") return v.toString();
  throw new RpcError(`${ctx} returned non-string/number: ${JSON.stringify(v)}`);
}

function parseAccountType(v: unknown): AccountTypeDiscriminant {
  const n =
    typeof v === "number"
      ? v
      : typeof v === "string"
        ? parseInt(v, 10)
        : 0;
  if (n === AccountType.EOA || n === AccountType.Contract || n === AccountType.System) {
    return n;
  }
  // Default to EOA for unknown / out-of-range values — pragmatic for
  // engine drift, parser stays strict via the asserts above.
  return AccountType.EOA;
}

// ----------------------------------------------------------------------------
// WaveHeader
// ----------------------------------------------------------------------------

function fromWireWaveHeader(w: unknown): WaveHeader {
  const o = w as Record<string, unknown>;
  const out: WaveHeader = {
    waveId: parseUint(asString(o.wave_id ?? o.waveId, "WaveHeader.waveId"), "WaveHeader.waveId"),
    timestamp: asString(o.timestamp, "WaveHeader.timestamp"),
    anchor: asString(o.anchor, "WaveHeader.anchor"),
  };
  if (o.state_root ?? o.stateRoot) out.stateRoot = asString(o.state_root ?? o.stateRoot, "stateRoot");
  if (o.events_root ?? o.eventsRoot) out.eventsRoot = asString(o.events_root ?? o.eventsRoot, "eventsRoot");
  if (o.tx_count !== undefined || o.txCount !== undefined) {
    out.txCount = parseUint(asString(o.tx_count ?? o.txCount, "txCount"), "txCount");
  }
  return out;
}

// ----------------------------------------------------------------------------
// HardFinalityCert
// ----------------------------------------------------------------------------

function fromWireHardFinalityCert(w: unknown): HardFinalityCert {
  const o = w as Record<string, unknown>;
  return {
    waveId: parseUint(asString(o.wave_id ?? o.waveId, "HFC.waveId"), "HFC.waveId"),
    stateRoot: asString(o.state_root ?? o.stateRoot, "HFC.stateRoot"),
    eventsRoot: asString(o.events_root ?? o.eventsRoot, "HFC.eventsRoot"),
    eventsBloom: asString(o.events_bloom ?? o.eventsBloom, "HFC.eventsBloom"),
    signature: asString(o.signature, "HFC.signature"),
  };
}

// ----------------------------------------------------------------------------
// SnapshotManifest
// ----------------------------------------------------------------------------

function fromWireSnapshotManifest(w: unknown): SnapshotManifest {
  const o = w as Record<string, unknown>;
  const chunks = (o.chunks ?? o.chunk_manifest ?? []) as unknown[];
  return {
    epoch: parseUint(asString(o.epoch, "Snapshot.epoch"), "Snapshot.epoch"),
    stateRootBlake3: asString(
      o.state_root_blake3 ?? o.snapshot_state_root_blake3 ?? o.stateRootBlake3,
      "Snapshot.stateRootBlake3",
    ),
    stateRootPoseidon2: asString(
      o.state_root_poseidon2 ?? o.snapshot_state_root_poseidon2 ?? o.stateRootPoseidon2,
      "Snapshot.stateRootPoseidon2",
    ),
    chunks: chunks.map((c) => {
      const cc = c as Record<string, unknown>;
      return {
        chunkIndex: parseUint(
          asString(cc.chunk_index ?? cc.chunkIndex, "ChunkRef.chunkIndex"),
          "ChunkRef.chunkIndex",
        ),
        chunkSize: parseUint(
          asString(cc.chunk_size ?? cc.chunkSize, "ChunkRef.chunkSize"),
          "ChunkRef.chunkSize",
        ),
        chunkHash: asString(cc.chunk_hash ?? cc.chunkHash, "ChunkRef.chunkHash"),
        chunkPath: asString(cc.chunk_path ?? cc.chunkPath, "ChunkRef.chunkPath"),
      };
    }),
    committeePubkeys: ((o.committee_pubkeys ??
      o.current_committee_pubkeys ??
      o.committeePubkeys ??
      []) as unknown[]).map((s) => asString(s, "committeePubkey")),
    signatures: ((o.signatures ?? []) as unknown[]).map((s) => asString(s, "signature")),
  };
}

// ----------------------------------------------------------------------------
// Receipt + Log
// ----------------------------------------------------------------------------

function fromWireReceipt(w: unknown): Receipt {
  const o = w as Record<string, unknown>;
  return {
    txHash: asString(o.tx_hash ?? o.txHash, "Receipt.txHash"),
    success: Boolean(o.success),
    gasUsed: asString(o.gas_used ?? o.gasUsed, "Receipt.gasUsed"),
    effectiveGas: asString(o.effective_gas ?? o.effectiveGas, "Receipt.effectiveGas"),
    feePaid: asString(o.fee_paid ?? o.feePaid, "Receipt.feePaid"),
    feeBurned: asString(o.fee_burned ?? o.feeBurned, "Receipt.feeBurned"),
    feeValidator: asString(o.fee_validator ?? o.feeValidator, "Receipt.feeValidator"),
    returnData:
      o.return_data || o.returnData
        ? asString(o.return_data ?? o.returnData, "Receipt.returnData")
        : undefined,
    logs: ((o.logs ?? []) as unknown[]).map(fromWireLog),
  };
}

function fromWireLog(w: unknown): Log {
  const o = w as Record<string, unknown>;
  return {
    waveId: parseUint(asString(o.wave_id ?? o.waveId, "Log.waveId"), "Log.waveId"),
    txIndex: parseUint(asString(o.tx_index ?? o.txIndex, "Log.txIndex"), "Log.txIndex"),
    eventIndex: parseUint(
      asString(o.event_index ?? o.eventIndex, "Log.eventIndex"),
      "Log.eventIndex",
    ),
    contract: asString(o.contract_addr ?? o.contract ?? o.address, "Log.contract"),
    topics: ((o.topics ?? []) as unknown[]).map((t) => asString(t, "Log.topic")),
    data: asString(o.data, "Log.data"),
  };
}

// ----------------------------------------------------------------------------
// TransactionInfo
// ----------------------------------------------------------------------------

function fromWireTransactionInfo(w: unknown): TransactionInfo {
  const o = w as Record<string, unknown>;
  const out: TransactionInfo = {
    hash: asString(o.hash ?? o.tx_hash, "Tx.hash"),
    from: asString(o.from, "Tx.from"),
    to: asString(o.to, "Tx.to"),
    value: asString(o.value, "Tx.value"),
    data: asString(o.data, "Tx.data"),
    gasLimit: asString(o.gas_limit ?? o.gasLimit, "Tx.gasLimit"),
    nonce: parseUint(asString(o.nonce, "Tx.nonce"), "Tx.nonce"),
    chainId: parseUint(asString(o.chain_id ?? o.chainId, "Tx.chainId"), "Tx.chainId"),
    txType: parseUint(asString(o.tx_type ?? o.txType, "Tx.txType"), "Tx.txType"),
  };
  if (o.wave_id !== undefined || o.waveId !== undefined) {
    out.waveId = parseUint(asString(o.wave_id ?? o.waveId, "Tx.waveId"), "Tx.waveId");
  }
  return out;
}

// ----------------------------------------------------------------------------
// AccessList
// ----------------------------------------------------------------------------

function parseAccessList(result: unknown): AccessEntry[] {
  const arr = (result as { accessList?: unknown[]; access_list?: unknown[] })
    ?.accessList ?? (result as { access_list?: unknown[] })?.access_list ?? [];
  return (arr as unknown[]).map((e) => {
    const o = e as Record<string, unknown>;
    return {
      address: asString(o.address, "AccessEntry.address"),
      reads: ((o.reads ?? []) as unknown[]).map((s) => asString(s, "AccessEntry.read")),
      writes: ((o.writes ?? []) as unknown[]).map((s) => asString(s, "AccessEntry.write")),
    };
  });
}

// ----------------------------------------------------------------------------
// LogFilter + GetLogsResponse
// ----------------------------------------------------------------------------

function toWireLogFilter(f: LogFilter): Record<string, unknown> {
  // Pad topics to 4 positional slots per HOST_FN_ABI §15.4 (positions
  // 0-3 — index i constrains event.topics[i]; null = any).
  const topics: (string[] | null)[] = [null, null, null, null];
  if (f.topics) {
    for (let i = 0; i < Math.min(4, f.topics.length); i++) {
      topics[i] = f.topics[i] ?? null;
    }
  }
  const wire: Record<string, unknown> = {
    from_wave: f.fromWave,
    to_wave: f.toWave,
    topics,
    contract: f.contract ?? null,
    limit: f.limit ?? 100,
  };
  if (f.cursor) wire.cursor = toWireCursor(f.cursor);
  return wire;
}

function toWireCursor(c: EventCursor): Record<string, unknown> {
  return { wave_id: c.waveId, tx_index: c.txIndex, event_index: c.eventIndex };
}

function fromWireCursor(w: unknown): EventCursor {
  const o = w as Record<string, unknown>;
  return {
    waveId: parseUint(asString(o.wave_id ?? o.waveId, "EventCursor.waveId"), "EventCursor.waveId"),
    txIndex: parseUint(asString(o.tx_index ?? o.txIndex, "EventCursor.txIndex"), "EventCursor.txIndex"),
    eventIndex: parseUint(
      asString(o.event_index ?? o.eventIndex, "EventCursor.eventIndex"),
      "EventCursor.eventIndex",
    ),
  };
}

function fromWireGetLogsResponse(w: unknown): GetLogsResponse {
  const o = w as Record<string, unknown>;
  const events = ((o.events ?? []) as unknown[]).map(fromWireLog);
  const out: GetLogsResponse = { events };
  const next = o.next_cursor ?? o.nextCursor;
  if (next != null) out.nextCursor = fromWireCursor(next);
  return out;
}
