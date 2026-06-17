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
  Wave,
  WaveHeader,
  HardFinalityCert,
  SnapshotManifest,
  Account,
  AccountTypeDiscriminant,
  TransactionInfo,
  TransactionResponse,
  CallOverrides,
  FeeData,
  ThresholdPublicKey,
  MetricsSnapshot,
  NodeInfo,
  ValidatorInfo,
  SimulateTransactionResult,
} from "./types";
import { AccountType } from "./types";
import {
  CallExceptionError,
  ConnectionError,
  InvalidArgumentError,
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
  /** Allow non-TLS `http://` transports. Defaults to false — the
   *  constructor throws for plaintext URLs unless this is explicitly
   *  opted in (devnet, localhost testing, CI). Production deployments
   *  should never set this. */
  allowInsecureTransport?: boolean;
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
  private options: Required<Omit<ProviderOptions, "headers" | "allowInsecureTransport">> & {
    headers: Record<string, string>;
  };

  constructor(rpcUrl: string, options?: ProviderOptions) {
    enforceSecureScheme(rpcUrl, options?.allowInsecureTransport, "Provider");
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
   *  16-slot sliding window per Chapter 11). Spec: chapter 17.4
   *  `pyde_getTransactionCount`.
   *
   *  Returns a bigint — nonce is u64 on chain, and the SDK refuses to
   *  silently truncate above 2^53. */
  async getNonce(address: string): Promise<bigint> {
    const result = await this.call_("pyde_getTransactionCount", [address]);
    return parseBigIntLoose(result, "getNonce");
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

  /** Fetch nonce + chainId in one round-trip (used when building a tx).
   *  Returns `[bigint, number]` — nonce is u64, chainId is small in practice. */
  async getNonceAndChainId(address: string): Promise<[bigint, number]> {
    const [nonce, chainId] = await Promise.all([this.getNonce(address), this.getChainId()]);
    return [nonce, chainId];
  }

  /** Return the full account record. Returns null when the account has
   *  never been touched on chain (chain returns null/undefined OR an
   *  empty object). A real account always has at least an address +
   *  one non-zero field in the response. Spec: Chapter 11 §11.1 +
   *  chapter 17.4. */
  async getAccount(address: string): Promise<Account | null> {
    const result = await this.call_("pyde_getAccount", [address]);
    if (!result || typeof result !== "object") return null;
    // Distinguish "unknown account" from "exists but zeroed": a real
    // account record carries the wire-format address field; an empty
    // / placeholder response does not.
    const o = result as Record<string, unknown>;
    if (!o.address && !o.nonce && !o.balance) return null;
    return fromWireAccount(result);
  }

  // ========================================================================
  // Contract queries
  // ========================================================================

  /** Return the contract's WASM bytecode as hex. Empty string for EOAs.
   *  Spec: chapter 17.4 `pyde_getContractCode`. */
  async getContractCode(address: string): Promise<string> {
    return asString(await this.call_("pyde_getContractCode", [address]), "pyde_getContractCode");
  }

  /** Return the value of a single contract state slot. Slots are
   *  **global** 32-byte keys in v1 — callers compute the full key
   *  per HOST_FN_ABI_SPEC §7.1:
   *
   *      slot = Poseidon2(self_address || field_bytes [|| key_bytes])
   *
   *  `field_bytes` is the author-chosen field name (e.g. `b"balances"`),
   *  not a numeric slot index. `key_bytes` is appended for mapping-
   *  style fields. Engine RPC catalog v0.1 §13 / `pyde_getStorageSlot`.
   *  Returns `null` when the slot was never written. */
  async getStorageSlot(slotHash: string): Promise<string | null> {
    const result = await this.call_("pyde_getStorageSlot", [{ slot: slotHash }]);
    return result == null ? null : asString(result, "pyde_getStorageSlot");
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
   *  wave). Spec: chapter 17.4 `pyde_getWave`. */
  async getWave(waveId?: Wave): Promise<WaveHeader | null> {
    let target = waveId;
    if (target === undefined) {
      target = await this.latestWaveId();
    }
    // Engine expects a **bare u64 number** for this method (not hex).
    // We've already validated `target` is in safe-integer range via
    // parseBigIntLoose / latestWaveId; Number() is precision-safe here.
    const result = await this.call_("pyde_getWave", [Number(target)]);
    return result ? fromWireWaveHeader(result) : null;
  }

  /** Return the current head wave id.
   *  Spec: chapter 17.4 `pyde_waveId` — Pyde's analogue of EVM
   *  `block.number`, see HOST_FN_ABI §7.3. */
  async getWaveId(): Promise<Wave> {
    const result = await this.call_("pyde_waveId", []);
    return parseBigIntLoose(result, "pyde_waveId");
  }

  /** Internal alias — used by `getWave()` when no wave id is passed. */
  private async latestWaveId(): Promise<Wave> {
    return this.getWaveId();
  }

  /** Current network base fee per gas unit.
   *  Spec: Chapter 10 — EIP-1559 style, `pyde_getBaseFee`. */
  async getBaseFee(): Promise<bigint> {
    const result = await this.call_("pyde_getBaseFee", []);
    return parseBigIntLoose(result, "pyde_getBaseFee");
  }

  /** Current network fee data — base fee + suggested tip. v1 has no
   *  priority fees, so `gasPrice === baseFee`. Spec: Chapter 10 —
   *  `pyde_getFeeData`. */
  async getFeeData(): Promise<FeeData> {
    const result = (await this.call_("pyde_getFeeData", [])) as
      | { base_fee?: unknown; suggested_tip?: unknown }
      | null;
    if (!result || typeof result !== "object") {
      throw new RpcError(`pyde_getFeeData: empty response`);
    }
    const baseFee = parseBigIntLoose(result.base_fee, "pyde_getFeeData.base_fee");
    const tip = parseBigIntLoose(result.suggested_tip ?? 0, "pyde_getFeeData.suggested_tip");
    return { baseFee, gasPrice: baseFee + tip };
  }

  /** Return the threshold-signed hard finality certificate for a wave.
   *  Spec: Chapter 6 + chapter 17.4 `pyde_getHardFinalityCert`. */
  async getHardFinalityCert(waveId: number | bigint): Promise<HardFinalityCert | null> {
    // Engine expects a **bare u64 number** for this method (not hex),
    // same as `pyde_getWave`. Number() is safe for any value within
    // u64's safe-integer range; bigints above 2^53 are rejected at
    // call-site (the chain itself doesn't reach those values yet).
    const result = await this.call_("pyde_getHardFinalityCert", [Number(waveId)]);
    return result ? fromWireHardFinalityCert(result) : null;
  }

  // ========================================================================
  // State sync
  // ========================================================================

  /** Return the snapshot manifest at the state store's last flushed
   *  wave. Spec: STATE_SYNC.md + chapter 17.4 `pyde_getSnapshotManifest`.
   *  Takes no params — the engine picks the latest available manifest. */
  async getSnapshotManifest(): Promise<SnapshotManifest | null> {
    const result = await this.call_("pyde_getSnapshotManifest", []);
    return result ? fromWireSnapshotManifest(result) : null;
  }

  // ========================================================================
  // View calls + simulation
  // ========================================================================

  /** Off-chain view-function call. Free; no tx, no consensus. Spec:
   *  chapter 17.4 — bounded by per-call instruction cap on the node. */
  async call(to: string, data: string, overrides?: CallOverrides): Promise<string> {
    const params = this.buildCallParams(to, data, overrides);
    return asString(await this.call_("pyde_call", [params]), "pyde_call");
  }

  /**
   * Dry-run a signed transaction. Returns the receipt the chain WOULD
   * produce + the access list (slots read / written) for Block-STM
   * parallelism on real submission. Same input shape as
   * `sendRawTransaction` — borsh-encoded `Tx` hex.
   *
   * Engine RPC catalog v0.1 §12 / `pyde_simulateTransaction`.
   *
   * Per catalog: `receipt: null` for no-op txs (system tx types,
   * plain transfers to EOAs). For contract calls / deploys the
   * receipt's `gas_used` is the **real chain estimate**, not the
   * SDK's conservative default. Use this from `Wallet.transfer` /
   * `sendCall` to replace the fixed 100k / 5M floors.
   */
  async simulateTransaction(signedTxHex: string): Promise<SimulateTransactionResult> {
    const result = await this.call_("pyde_simulateTransaction", [signedTxHex]);
    return fromWireSimulateResult(result);
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
  async getThresholdPublicKey(): Promise<ThresholdPublicKey | null> {
    const result = await this.call_("pyde_getThresholdPublicKey", []);
    if (result == null) return null;
    if (typeof result !== "object") {
      throw new RpcError(
        `pyde_getThresholdPublicKey returned non-object: ${JSON.stringify(result)}`,
      );
    }
    const o = result as Record<string, unknown>;
    // Engine may suffix the scheme with a parameter-set tag (e.g.
    // "kyber-768-goldilocks" for the Goldilocks-prime accelerated
    // build). Pass it through verbatim — `Wallet.sendEncrypted`
    // checks `scheme.startsWith("kyber-768")` to decide whether real
    // DKG is live.
    return {
      epoch: parseBigIntLoose(o.epoch, "ThresholdPublicKey.epoch"),
      scheme: asString(o.scheme, "ThresholdPublicKey.scheme"),
      publicKey: asString(o.public_key ?? o.publicKey, "ThresholdPublicKey.publicKey"),
    };
  }

  /**
   * Submit a client-built, client-signed encrypted-tx envelope (wire-hex
   * from `buildRawEncryptedTx`). Plaintext never leaves the client; the
   * envelope is FALCON-signed over an `EncryptedTx::hash` that binds to
   * the ciphertext + cleartext (sender, nonce, gas, chain).
   *
   * **Important — two distinct hashes:**
   * - The RPC result is the **envelope hash**
   *   (`Blake3(version || ciphertext_len_le || ciphertext)`). Use it to
   *   confirm local admit / track gossip publication.
   * - Receipts after wave-commit are keyed by the **plaintext tx hash**
   *   the chain reconstructs post-decryption — NOT the envelope hash.
   *
   * The returned `TransactionResponse.wait()` will time out polling the
   * envelope hash. Callers wanting the receipt should hash the inner
   * Tx client-side (via `crypto.hashTransaction` against the reconstructed
   * plaintext shape) and poll `getTransactionReceipt` against that.
   *
   * Spec: Engine RPC catalog v0.1 §8 · `pyde_sendRawEncryptedTransaction`.
   */
  async sendRawEncryptedTransaction(encTxHex: string): Promise<TransactionResponse> {
    const result = await this.call_("pyde_sendRawEncryptedTransaction", [encTxHex]);
    return this.buildTxResponse(asString(result, "pyde_sendRawEncryptedTransaction"));
  }

  // ========================================================================
  // Transaction lookup + receipts
  // ========================================================================

  /** Look up a committed transaction by hash. Returns null if absent.
   *  Spec: chapter 17.4 `pyde_getTx` (archival query — raw serde-derived
   *  shape with byte arrays + JSON numbers, not the hex-string form
   *  used by `pyde_getTransactionReceipt`). The SDK adapter accepts
   *  both wire forms tolerantly. */
  async getTransaction(txHash: string): Promise<TransactionInfo | null> {
    const result = await this.call_("pyde_getTx", [txHash]);
    return result ? fromWireTransactionInfo(result, txHash) : null;
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
    throw new TimeoutError(`Receipt not available after ${timeoutMs}ms for tx ${txHash}`);
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

  /**
   * Permissive event scan. Same event-record shape as
   * `pyde_getTransactionReceipt.events` and `pyde_getLogs.entries`,
   * sorted by `(wave_id, tx_index, event_index)`. Malformed filters
   * silently return `[]` — for strict validation use `getLogs`.
   *
   * Engine RPC catalog v0.1 §13 · `pyde_getEvents`.
   */
  async getEvents(filter?: { fromWave?: Wave; toWave?: Wave; contract?: string }): Promise<Log[]> {
    const wire: Record<string, unknown> = {};
    if (filter?.fromWave !== undefined) wire.fromWave = "0x" + filter.fromWave.toString(16);
    if (filter?.toWave !== undefined) wire.toWave = "0x" + filter.toWave.toString(16);
    if (filter?.contract !== undefined) wire.contract = filter.contract;
    const result = await this.call_("pyde_getEvents", [wire]);
    const raw = (result ?? []) as unknown[];
    return raw.map(fromWireLog);
  }

  // ========================================================================
  // Validator queries
  // ========================================================================

  /** Return the validator record at `address` or `null` if none exists.
   *  Engine RPC catalog v0.1 §16 · `pyde_getValidator`. */
  async getValidator(address: string): Promise<ValidatorInfo | null> {
    const result = await this.call_("pyde_getValidator", [address]);
    if (result == null || typeof result !== "object") return null;
    const o = result as Record<string, unknown>;
    const status = asString(o.status, "ValidatorInfo.status");
    const normStatus: ValidatorInfo["status"] =
      status === "active" || status === "unbonding" || status === "exited" || status === "jailed"
        ? status
        : "exited";
    const optWave = (key: string, alt: string): bigint | null => {
      const v = (o[key] ?? o[alt]) as unknown;
      if (v == null) return null;
      return parseBigIntLoose(v, `ValidatorInfo.${key}`);
    };
    return {
      validatorAddress: asString(
        o.validator_address ?? o.validatorAddress,
        "ValidatorInfo.validatorAddress",
      ),
      operator: asString(o.operator, "ValidatorInfo.operator"),
      pubkey: asString(o.pubkey, "ValidatorInfo.pubkey"),
      stake: parseBigIntLoose(o.stake, "ValidatorInfo.stake"),
      status: normStatus,
      unbondAtWave: optWave("unbond_at_wave", "unbondAtWave"),
      jailUntilWave: optWave("jail_until_wave", "jailUntilWave"),
      lastClaimedRps: parseBigIntLoose(
        o.last_claimed_rps ?? o.lastClaimedRps,
        "ValidatorInfo.lastClaimedRps",
      ),
      uptimeBps: Number(o.uptime_bps ?? o.uptimeBps ?? 0),
    };
  }

  /** Return every validator-address an operator controls. Empty array
   *  if the operator runs no validators. Operators cap at 3 per the
   *  staking model. Engine RPC catalog v0.1 §17 ·
   *  `pyde_getOperatorValidators`. */
  async getOperatorValidators(operatorAddress: string): Promise<string[]> {
    const result = await this.call_("pyde_getOperatorValidators", [operatorAddress]);
    return ((result ?? []) as unknown[]).map((v) => asString(v, "getOperatorValidators[i]"));
  }

  // ========================================================================
  // Node identity + metrics
  // ========================================================================

  /** Return node identity + capabilities. `falconPubkey: null` means
   *  the node has no consensus signing identity (full / archive node).
   *  Engine RPC catalog v0.1 §18 · `pyde_getNodeInfo`. */
  async getNodeInfo(): Promise<NodeInfo> {
    const result = await this.call_("pyde_getNodeInfo", []);
    if (!result || typeof result !== "object") {
      throw new RpcError(`pyde_getNodeInfo returned non-object: ${JSON.stringify(result)}`);
    }
    const o = result as Record<string, unknown>;
    const falcon = o.falcon_pubkey ?? o.falconPubkey;
    return {
      peerId: asString(o.peer_id ?? o.peerId, "NodeInfo.peerId"),
      falconPubkey: falcon == null ? null : asString(falcon, "NodeInfo.falconPubkey"),
      listenAddrs: ((o.listen_addrs ?? o.listenAddrs ?? []) as unknown[]).map((a) =>
        asString(a, "NodeInfo.listenAddrs[i]"),
      ),
      agentVersion: asString(o.agent_version ?? o.agentVersion, "NodeInfo.agentVersion"),
      protocolVersion: asString(
        o.protocol_version ?? o.protocolVersion,
        "NodeInfo.protocolVersion",
      ),
    };
  }

  /** Return an instantaneous metrics snapshot — counter per mainloop
   *  subsystem, schema mirrors the engine's `MainLoopMetrics`. For
   *  time-series scrape the Prometheus `/metrics` HTTP route instead.
   *  Engine RPC catalog v0.1 §19 · `pyde_getMetrics`. */
  async getMetrics(): Promise<MetricsSnapshot> {
    const result = await this.call_("pyde_getMetrics", []);
    if (!result || typeof result !== "object") {
      throw new RpcError(`pyde_getMetrics returned non-object: ${JSON.stringify(result)}`);
    }
    return result as MetricsSnapshot;
  }

  // ========================================================================
  // Archival receipts + raw tx + snapshot bundle
  // ========================================================================

  /** Archival receipt query — raw serde-derived wire shape with byte
   *  arrays + JSON numbers (NOT the hex-string convention of
   *  `getTransactionReceipt`). Use this for explorer / indexer code
   *  that wants the canonical borsh-shape data without the SDK's
   *  hex normalization. Returns `null` if not found.
   *  Engine RPC catalog v0.1 §21 · `pyde_getReceipt`. */
  async getReceiptArchival(txHash: string): Promise<unknown | null> {
    const result = await this.call_("pyde_getReceipt", [txHash]);
    return result ?? null;
  }

  /** Return the full snapshot bundle as a standard-base64 string
   *  (RFC 4648 §4 — NOT URL-safe). Decodes to a borsh-encoded
   *  `SnapshotBundle { manifest, chunks }` — multi-MB on a populated
   *  chain. For just the manifest use `getSnapshotManifest()`.
   *  Engine RPC catalog v0.1 §25 · `pyde_getSnapshot`. */
  async getSnapshot(): Promise<string> {
    return asString(await this.call_("pyde_getSnapshot", []), "pyde_getSnapshot");
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
   *   { method: "pyde_getTransactionCount", params: [addr] },
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
    return {
      hash,
      wait: (timeoutMs = 10_000): Promise<Receipt> =>
        this.waitForReceipt(hash, timeoutMs),
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
    // Native HTTP 429 (Too Many Requests) handling — independent of
    // `options.retries`. Bursty workloads (test suites, indexer
    // bootstraps) routinely trip rate limiters; the SDK transparently
    // honours `Retry-After` and retries up to 3 times before
    // surfacing the error. Capped backoff so callers don't stall
    // indefinitely. Spec: RFC 6585 §4 + RFC 7231 §7.1.3.
    const MAX_429_RETRIES = 3;
    const MAX_BACKOFF_MS = 2_000;
    for (let attempt = 0; attempt <= MAX_429_RETRIES; attempt++) {
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
      if (resp.status === 429 && attempt < MAX_429_RETRIES) {
        const retryAfter = resp.headers.get("retry-after");
        const waitMs =
          retryAfter && /^\d+$/.test(retryAfter)
            ? Math.min(parseInt(retryAfter, 10) * 1000, MAX_BACKOFF_MS)
            : Math.min(200 * Math.pow(2, attempt), MAX_BACKOFF_MS);
        await sleep(waitMs);
        continue;
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
    // Loop exits via return or throw; this is unreachable.
    throw new RpcError("fetchJson exhausted retries without resolving");
  }
}

// ============================================================================
// Wire <-> TS conversion helpers
// ============================================================================

const ZERO_ADDR = "0x" + "00".repeat(32);

/** Reject plaintext transports unless the caller opted in. Throws an
 *  `InvalidArgumentError` so the failure is visible at constructor
 *  time rather than at first request (when sensitive data may already
 *  be in flight). */
export function enforceSecureScheme(
  url: string,
  allowInsecure: boolean | undefined,
  ctx: string,
): void {
  if (allowInsecure) return;
  const lower = url.toLowerCase();
  if (lower.startsWith("http://") || lower.startsWith("ws://")) {
    throw new InvalidArgumentError(
      `${ctx}: plaintext transport (${lower.startsWith("http") ? "http://" : "ws://"}) rejected. ` +
        `Pass options.allowInsecureTransport: true for devnet / localhost; production must use https:// / wss://.`,
      "url",
      url,
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asString(value: unknown, ctx: string): string {
  if (typeof value !== "string") {
    throw new RpcError(`${ctx} returned non-string: ${JSON.stringify(value)}`);
  }
  return value;
}

/** Tolerant hex parser — accepts either a `"0x..."` string or a raw
 *  JSON byte array `[240, 120, ...]` (the archival serde wire form
 *  per catalog notes on `pyde_getReceipt` / `pyde_getTx`). Returns a
 *  canonical `0x`-prefixed lowercase hex string. */
function asHex(value: unknown, ctx: string): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((v) => typeof v === "number")) {
    return (
      "0x" +
      (value as number[])
        .map((b) => (b & 0xff).toString(16).padStart(2, "0"))
        .join("")
    );
  }
  throw new RpcError(`${ctx} returned non-hex: ${JSON.stringify(value)}`);
}

/** Parse the engine's `tx_type` field. Archival serde ships
 *  PascalCase enum variants (`"Standard"`, `"Deploy"`, ...);
 *  hex-string convention ships a numeric `0x..` discriminant; bare
 *  JSON numbers (e.g. `0`) also occur. Map all three to the SDK's
 *  `TxType` numeric discriminant. */
function parseTxTypeWire(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    // hex-string form ("0x00", "0x0d", ...)
    if (value.startsWith("0x") || /^[0-9]+$/.test(value)) {
      return parseUint(value, "Tx.txType");
    }
    // Enum-variant form — engine builds report PascalCase
    // ("Standard"), snake_case ("standard"), or kebab-case
    // ("register-pubkey"). Normalize to a lowercase-no-separators
    // lookup key.
    const map: Record<string, number> = {
      standard: 0,
      deploy: 1,
      stakedeposit: 3,
      stakewithdraw: 4,
      slash: 5,
      claimreward: 6,
      claimairdrop: 7,
      sweepairdrop: 8,
      multisigtx: 9,
      rotatemultisig: 10,
      emergencypause: 11,
      emergencyresume: 12,
      registerpubkey: 13,
    };
    const key = value.toLowerCase().replace(/[_-]/g, "");
    const n = map[key];
    if (n === undefined) {
      throw new RpcError(`Tx.txType returned unknown enum variant: ${value}`);
    }
    return n;
  }
  throw new RpcError(`Tx.txType returned non-numeric: ${JSON.stringify(value)}`);
}

function parseUint(hex: string, ctx: string): number {
  const n = hex.startsWith("0x") ? parseInt(hex, 16) : parseInt(hex, 10);
  if (!Number.isFinite(n)) throw new RpcError(`${ctx} returned invalid number: ${hex}`);
  return n;
}

/** Tolerant u64 parser → bigint. Accepts JSON numbers, hex strings,
 *  decimal strings, and bigints. Returns a bigint so values up to 2^64-1
 *  are represented without loss. */
function parseBigIntLoose(v: unknown, ctx: string): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new RpcError(`${ctx} returned invalid number: ${v}`);
    return BigInt(v);
  }
  if (typeof v === "string") {
    try {
      return BigInt(v);
    } catch {
      throw new RpcError(`${ctx} returned invalid u64: ${v}`);
    }
  }
  throw new RpcError(`${ctx} returned non-numeric: ${JSON.stringify(v)}`);
}

function bigIntToHex(v: bigint | number | string): string {
  return "0x" + BigInt(v).toString(16);
}

function isReceiptNotFound(e: unknown): boolean {
  return (
    e instanceof RpcError && typeof e.message === "string" && /receipt not found/i.test(e.message)
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
    nonce: tryBigInt(o.nonce) ?? 0n,
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

function parseAccountType(v: unknown): AccountTypeDiscriminant {
  const n = typeof v === "number" ? v : typeof v === "string" ? parseInt(v, 10) : 0;
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
  const anchor = o.anchor ?? o.anchor_hash ?? o.anchorHash;
  const stateRoot = o.state_root ?? o.stateRoot;
  const eventsRoot = o.events_root ?? o.eventsRoot;
  const txCount = o.tx_count ?? o.txCount;
  // The engine's `next_epoch_beacon`-bearing header has no `timestamp`
  // field (anchor_round + epoch carry equivalent ordering). Synthesize
  // a stable placeholder so downstream callers don't observe an
  // unexpected `undefined`. When the engine ships proper timestamps,
  // the parse falls through to the real value.
  const timestamp = o.timestamp ?? o.anchor_round ?? o.anchorRound ?? 0;
  const out: WaveHeader = {
    waveId: parseBigIntLoose(o.wave_id ?? o.waveId, "WaveHeader.waveId"),
    timestamp: String(timestamp),
    anchor: hexlifyAnchor(anchor),
  };
  if (stateRoot !== undefined && stateRoot !== null) out.stateRoot = hexlifyAnchor(stateRoot);
  if (eventsRoot !== undefined && eventsRoot !== null) out.eventsRoot = hexlifyAnchor(eventsRoot);
  if (txCount !== undefined) out.txCount = Number(txCount);
  return out;
}

/** Tolerate three wire shapes for hash-like fields:
 *   - already-hex `"0xabcd..."` string
 *   - raw 32-byte JSON array `[15, 156, 224, ...]`
 *   - dual-hash struct `{blake3: number[], poseidon2: number[]}`
 *     (engine ships this for state_root per the Poseidon2/Blake3 hybrid
 *     in `hash_strategy_and_validation`). The Blake3 leg is the
 *     execution-side authority so we surface that one. */
function hexlifyAnchor(raw: unknown): string {
  if (raw == null) return "0x";
  if (typeof raw === "string") return raw.startsWith("0x") ? raw : "0x" + raw;
  if (Array.isArray(raw)) {
    return "0x" + raw.map((b) => Number(b).toString(16).padStart(2, "0")).join("");
  }
  if (typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    if (Array.isArray(o.blake3)) return hexlifyAnchor(o.blake3);
    if (Array.isArray(o.poseidon2)) return hexlifyAnchor(o.poseidon2);
  }
  return String(raw);
}

// ----------------------------------------------------------------------------
// HardFinalityCert
// ----------------------------------------------------------------------------

function fromWireHardFinalityCert(w: unknown): HardFinalityCert {
  const o = w as Record<string, unknown>;
  return {
    waveId: parseBigIntLoose(o.wave_id ?? o.waveId, "HFC.waveId"),
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
  const hashes = Array.isArray(o.chunk_hashes) ? (o.chunk_hashes as unknown[]) : [];
  return {
    waveId: BigInt(o.wave_id as number | string | bigint),
    stateRoot: asString(o.state_root, "Snapshot.stateRoot"),
    chunkSize: Number(o.chunk_size),
    chunkCount: Number(o.chunk_count),
    chunkHashes: hashes.map((h, i) => asString(h, `Snapshot.chunkHashes[${i}]`)),
    totalKeys: Number(o.total_keys),
  } as SnapshotManifest;
}


// ----------------------------------------------------------------------------
// Receipt + Log
// ----------------------------------------------------------------------------

function fromWireReceipt(w: unknown): Receipt {
  const o = w as Record<string, unknown>;
  // Engine drift: the chain emits a `status: "success" | "reverted"
  // | "out_of_gas"` string AND/OR an older `success: boolean`. Accept
  // both. Likewise not every field (effective_gas / fee_burned /
  // fee_validator / logs) ships on every chain build; fall back to
  // "0x0" / [] so callers see a stable shape.
  const status = typeof o.status === "string" ? o.status : null;
  const success =
    typeof o.success === "boolean" ? o.success : status !== null ? status === "success" : false;
  const asStringOr = (v: unknown, fallback: string): string =>
    typeof v === "string" ? v : fallback;
  const rawLogs = (o.logs ?? o.events ?? []) as unknown[];
  const out: Receipt = {
    txHash: asString(o.tx_hash ?? o.txHash, "Receipt.txHash"),
    success,
    gasUsed: asString(o.gas_used ?? o.gasUsed, "Receipt.gasUsed"),
    effectiveGas: asStringOr(o.effective_gas ?? o.effectiveGas, "0x0"),
    feePaid: asStringOr(o.fee_paid ?? o.feePaid, "0x0"),
    feeBurned: asStringOr(o.fee_burned ?? o.feeBurned, "0x0"),
    feeValidator: asStringOr(o.fee_validator ?? o.feeValidator, "0x0"),
    logs: rawLogs.map(fromWireLog),
  };
  // exactOptionalPropertyTypes: only set returnData when present —
  // assigning `undefined` would violate the Receipt type contract.
  const rd = o.return_data ?? o.returnData;
  if (rd) out.returnData = asString(rd, "Receipt.returnData");
  return out;
}

function fromWireLog(w: unknown): Log {
  const o = w as Record<string, unknown>;
  return {
    waveId: parseBigIntLoose(o.wave_id ?? o.waveId, "Log.waveId"),
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

function fromWireTransactionInfo(w: unknown, queriedHash?: string): TransactionInfo {
  const o = w as Record<string, unknown>;
  // Engine catalog §22 returns the raw archival Tx envelope:
  //   - No `hash` field (caller already knew it — that's how they
  //     queried). Fall back to `queriedHash`.
  //   - `sender` not `from` (per pyde_engine_types::Tx).
  //   - Address / hash / data fields ship as byte arrays
  //     (`[240, 120, ...]`) instead of hex strings — tolerate both
  //     via `asHex`.
  //   - `value` is u128 in JSON, either string or numeric — keep
  //     raw via `asString` after normalising.
  //   - `nonce`, `chain_id`, `gas_limit`, `tx_type` are raw JSON
  //     numbers (not hex strings).
  const wireHash = o.hash ?? o.tx_hash;
  const hash =
    wireHash !== undefined ? asHex(wireHash, "Tx.hash") : queriedHash;
  if (hash === undefined) {
    throw new RpcError("Tx.hash missing on wire and no queried hash supplied");
  }
  const out: TransactionInfo = {
    hash,
    from: asHex(o.sender ?? o.from, "Tx.from"),
    to: asHex(o.to, "Tx.to"),
    value:
      typeof o.value === "string"
        ? o.value
        : typeof o.value === "number" || typeof o.value === "bigint"
          ? String(o.value)
          : asHex(o.value, "Tx.value"),
    data: asHex(o.data, "Tx.data"),
    gasLimit:
      typeof o.gas_limit === "number"
        ? "0x" + o.gas_limit.toString(16)
        : typeof o.gasLimit === "number"
          ? "0x" + o.gasLimit.toString(16)
          : asString(o.gas_limit ?? o.gasLimit, "Tx.gasLimit"),
    nonce: parseBigIntLoose(o.nonce, "Tx.nonce"),
    chainId:
      typeof o.chain_id === "number"
        ? (o.chain_id as number)
        : typeof o.chainId === "number"
          ? (o.chainId as number)
          : parseUint(asString(o.chain_id ?? o.chainId, "Tx.chainId"), "Tx.chainId"),
    txType: parseTxTypeWire(o.tx_type ?? o.txType),
  };
  if (o.wave_id !== undefined || o.waveId !== undefined) {
    out.waveId = parseBigIntLoose(o.wave_id ?? o.waveId, "Tx.waveId");
  }
  return out;
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
  // u64 wave bounds — engine accepts hex strings. JSON.stringify
  // would throw on a raw bigint, so encode here.
  // `contracts` is the **plural array** the engine expects (within-array
  // OR). The SDK keeps a single-`contract` LogFilter field for ergonomic
  // call sites and wraps it into a 1-element array on the wire.
  const wire: Record<string, unknown> = {
    from_wave: "0x" + f.fromWave.toString(16),
    to_wave: "0x" + f.toWave.toString(16),
    topics,
    contracts: f.contract != null ? [f.contract] : null,
    limit: f.limit ?? 100,
  };
  if (f.cursor) wire.cursor = toWireCursor(f.cursor);
  return wire;
}

function toWireCursor(c: EventCursor): Record<string, unknown> {
  // wave_id is bigint on the JS side; hex-encode for JSON safety.
  return {
    wave_id: "0x" + c.waveId.toString(16),
    tx_index: c.txIndex,
    event_index: c.eventIndex,
  };
}

function fromWireCursor(w: unknown): EventCursor {
  const o = w as Record<string, unknown>;
  return {
    waveId: parseBigIntLoose(o.wave_id ?? o.waveId, "EventCursor.waveId"),
    txIndex: parseUint(
      asString(o.tx_index ?? o.txIndex, "EventCursor.txIndex"),
      "EventCursor.txIndex",
    ),
    eventIndex: parseUint(
      asString(o.event_index ?? o.eventIndex, "EventCursor.eventIndex"),
      "EventCursor.eventIndex",
    ),
  };
}

function fromWireSimulateResult(w: unknown): SimulateTransactionResult {
  const o = (w ?? {}) as Record<string, unknown>;
  const accessList = (o.access_list ?? o.accessList ?? {}) as Record<string, unknown>;
  const rawReads = (accessList.reads ?? []) as unknown[];
  const rawWrites = (accessList.writes ?? []) as unknown[];
  const rawReceipt = o.receipt;

  let receipt: SimulateTransactionResult["receipt"] = null;
  if (rawReceipt && typeof rawReceipt === "object") {
    const r = rawReceipt as Record<string, unknown>;
    const status = asString(r.status, "SimulateReceipt.status");
    const normStatus: "Success" | "Reverted" | "OutOfGas" =
      status === "Success" || status === "Reverted" || status === "OutOfGas" ? status : "Reverted";
    receipt = {
      status: normStatus,
      gasUsed: BigInt(asString(r.gas_used ?? r.gasUsed, "SimulateReceipt.gasUsed")),
      feePaid: BigInt(asString(r.fee_paid ?? r.feePaid, "SimulateReceipt.feePaid")),
      returnData:
        typeof (r.return_data ?? r.returnData) === "string"
          ? ((r.return_data ?? r.returnData) as string)
          : "0x",
    };
  }

  return {
    receipt,
    reads: rawReads.map((entry) => {
      const e = (entry ?? {}) as Record<string, unknown>;
      const observed = e.observed_version ?? e.observedVersion;
      const observedVersion =
        observed && typeof observed === "object"
          ? {
              txIndex: Number(
                (observed as Record<string, unknown>).tx_index ??
                  (observed as Record<string, unknown>).txIndex ??
                  0,
              ),
              attempt: Number((observed as Record<string, unknown>).attempt ?? 0),
            }
          : null;
      return {
        slot: asString(e.slot, "SimulateRead.slot"),
        observedVersion,
      };
    }),
    writes: rawWrites.map((s) => asString(s, "SimulateWrite.slot")),
  };
}

function fromWireGetLogsResponse(w: unknown): GetLogsResponse {
  const o = w as Record<string, unknown>;
  // Engine exposes the field as `entries`; older spec drafts + the
  // SDK type call it `events`. Accept both — engine is the authority
  // for the current shape.
  const raw = (o.entries ?? o.events ?? []) as unknown[];
  const events = raw.map(fromWireLog);
  const out: GetLogsResponse = { events };
  const next = o.next_cursor ?? o.nextCursor;
  if (next != null) out.nextCursor = fromWireCursor(next);
  return out;
}
