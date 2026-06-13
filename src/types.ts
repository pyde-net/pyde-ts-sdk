/**
 * Core types for the Pyde SDK. Spec-aligned against:
 *   - Chapter 6  (consensus, wave commits, HardFinalityCert)
 *   - Chapter 10 (gas + fee model)
 *   - Chapter 11 (account model, tx wire format, txType discriminants)
 *   - HOST_FN_ABI_SPEC §15 (events, Log + LogFilter + EventCursor shapes)
 *   - STATE_SYNC.md (SnapshotManifest + ChunkRef)
 *
 * Wave-not-block: Pyde commits waves, not blocks. Where Ethereum-shaped
 * SDKs say `block` we say `wave`. Field names follow the chain's
 * canonical naming (see Chapter 6).
 */

// ============================================================================
// Type aliases
// ============================================================================

/** Wave ID — Pyde's primary chain primitive. u64 on chain; values up to
 *  Number.MAX_SAFE_INTEGER fit in a JS number, beyond that callers should
 *  pass / receive a bigint or hex string. Spec: Chapter 6. */
export type Wave = number;

/** 32-byte hex hash (Poseidon2 or Blake3 output). */
export type Hash = string;

/** 32-byte address.
 *  Spec: Chapter 11 §11.1 — EOA = Poseidon2(falcon_public_key_bytes);
 *  contracts = Poseidon2(deployer || nonce) or Poseidon2(0xFF || deployer
 *  || salt || code_hash) for CREATE2. */
export type Address = string;

// ============================================================================
// Wave + chain primitives
// ============================================================================

/** Header of a wave commit. Returned by `getWave()` and `newHeads`
 *  subscriptions. Spec: Chapter 6 — wave commit record carries both
 *  state and events summaries. */
export interface WaveHeader {
  /** Wave ID. */
  waveId: Wave;
  /** Wall-clock commit time (RFC 3339 string from RPC). */
  timestamp: string;
  /** Anchor validator's address (the committee member whose vertex
   *  becomes this wave's anchor via VRF beacon, per Chapter 6). */
  anchor: Address;
  /** Post-wave state root (Blake3 — fast native verification). */
  stateRoot?: Hash;
  /** Event-tree root over canonical-ordered events. */
  eventsRoot?: Hash;
  /** Number of transactions included in this wave. */
  txCount?: number;
}

/** Threshold-signed hard finality certificate. Committee signs
 *  (wave_id, state_root, events_root, events_bloom) so a light client
 *  can verify the entire wave's integrity from a 200-byte header.
 *  Spec: Chapter 6 + HOST_FN_ABI_SPEC §15.2. */
export interface HardFinalityCert {
  waveId: Wave;
  stateRoot: Hash;
  eventsRoot: Hash;
  /** 256-byte bloom filter over the wave's events (hex). */
  eventsBloom: string;
  /** Aggregated FALCON signature (≥85 of 128 committee members). */
  signature: string;
}

// ============================================================================
// State-sync snapshot
// ============================================================================

/** Snapshot manifest for state sync (light client / fresh validator).
 *  Spec: STATE_SYNC.md — dual-root manifest, signed by ≥85 of the prior
 *  epoch's committee for chain-of-trust. */
export interface SnapshotManifest {
  epoch: number;
  /** Snapshot state root — Blake3 (fast native verification). */
  stateRootBlake3: Hash;
  /** Snapshot state root — Poseidon2 (ZK light-client compatibility). */
  stateRootPoseidon2: Hash;
  chunks: ChunkRef[];
  /** Current committee FALCON pubkeys (chain-of-trust). */
  committeePubkeys: string[];
  /** ≥85 FALCON signatures from prior epoch's committee. */
  signatures: string[];
}

/** Reference to one snapshot chunk. */
export interface ChunkRef {
  chunkIndex: number;
  chunkSize: number;
  /** Blake3 hash of the chunk contents. */
  chunkHash: Hash;
  /** P2P routing hint. */
  chunkPath: string;
}

// ============================================================================
// Receipt
// ============================================================================

/** Transaction receipt — emitted at execution. Spec: Chapter 10. */
export interface Receipt {
  txHash: Hash;
  success: boolean;
  /** Hex-encoded u64. */
  gasUsed: string;
  /** Effective gas (= gasUsed in v1; no refunds per Chapter 10 §10.1). */
  effectiveGas: string;
  /** Total fee paid (base × gasUsed), hex-encoded u128. */
  feePaid: string;
  /** Portion of fee burned (Chapter 10 — EIP-1559-style). */
  feeBurned: string;
  /** Portion of fee credited to the wave's validator. */
  feeValidator: string;
  /** Return data hex. Ephemeral — only in this receipt; absent on
   *  subsequent tx lookups. */
  returnData?: string;
  /** Events emitted during execution. */
  logs: Log[];
}

// ============================================================================
// Event / Log + filter (cursor-based delivery)
// ============================================================================

/** Event log with the full `(waveId, txIndex, eventIndex)` cursor coords
 *  for at-least-once delivery on subscriptions.
 *  Spec: HOST_FN_ABI_SPEC §15.2 + §15.4. */
export interface Log {
  /** Wave in which the event was emitted. */
  waveId: Wave;
  /** Position of the emitting tx within the wave. */
  txIndex: number;
  /** Position of the event within the emitting tx. */
  eventIndex: number;
  /** Contract address that emitted the event. */
  contract: Address;
  /** 1-4 topics; topic[0] is the event signature hash (Blake3). */
  topics: Hash[];
  /** Raw event data (hex). */
  data: string;
}

/** Continuation cursor for paginated historical event queries. */
export interface EventCursor {
  waveId: Wave;
  txIndex: number;
  eventIndex: number;
}

/** Filter for historical event queries (`pyde_getLogs`).
 *  Spec: HOST_FN_ABI_SPEC §15.4 — 5k-wave cap, positional topic filter,
 *  cursor pagination, default limit 100, max 1,000. */
export interface LogFilter {
  /** Inclusive lower wave bound. */
  fromWave: Wave;
  /** Inclusive upper wave bound. Constraint: `toWave - fromWave ≤ 5,000`. */
  toWave: Wave;
  /**
   * Positional topic filter. Four slots (positions 0-3) matching
   * `event.topics[i]`:
   *   - `null` (or omitted) at position i: any value matches.
   *   - `string[]` at position i: `event.topics[i]` must be IN the list (OR).
   * Per-position list size ≤ 8.
   */
  topics?: (Hash[] | null)[];
  /** Optional contract address restriction. */
  contract?: Address;
  /** Pagination cursor — pass `nextCursor` from a prior response. */
  cursor?: EventCursor;
  /** Max events to return. Default 100, max 1,000. */
  limit?: number;
}

/** Response from `pyde_getLogs`. */
export interface GetLogsResponse {
  events: Log[];
  /** Omitted = exhausted; present = call again with this cursor for next page. */
  nextCursor?: EventCursor;
}

// ============================================================================
// Transaction wire format
// ============================================================================

/**
 * Access-list entry — drives parallel execution.
 *
 * Spec: Chapter 11 + Chapter 9. Wallets typically auto-fill via
 * `Provider.estimateAccess()`; the chain reverts with `AccessListViolation`
 * if execution touches a slot not declared here.
 *
 * Note: The book (chapter 11) presents a forward-looking shape with
 * `storage_keys` + `access_type: Read | ReadWrite`. The pyde-crypto-wasm
 * encoder currently consumes the split `reads` / `writes` form below —
 * this SDK matches the encoder. If the wasm encoder updates, this type
 * follows.
 */
export interface AccessEntry {
  /** Account whose slots are accessed. */
  address: Address;
  /** Slots read by the tx (hex slot_hash values). */
  reads: Hash[];
  /** Slots written by the tx (hex slot_hash values). */
  writes: Hash[];
}

/**
 * Transaction wire fields — matches the JSON shape `pyde-crypto-wasm`
 * accepts in `signTransaction` / `hashTransaction` / etc.
 *
 * Spec: Chapter 11. The `nonce` participates in a 16-slot sliding-window
 * bitmap (Chapter 11 §nonce mechanics) — sender may have up to 16 txs
 * in flight per account.
 */
export interface TxFields {
  from: Address;
  to: Address;
  /** Value in quanta (decimal string for bigint-safety; number for small values). */
  value: number | string;
  /** Calldata hex; "0x" for value-only transfers. */
  data: string;
  gasLimit: number;
  /** Per-sender counter within the 16-slot nonce window. */
  nonce: number;
  /** Chain ID for replay protection. */
  chainId: number;
  /** Transaction-type discriminant (see `TxType` const below). */
  txType: number;
  /** Optional access list. */
  accessList?: AccessEntry[];
  /** Optional wave deadline; mempool drops the tx after this wave. */
  deadline?: Wave | null;
}

/**
 * Transaction-type discriminants. Const-object pattern (not a TS `enum`)
 * so values land as literal types with autocomplete and zero runtime
 * overhead. Spec: Chapter 11 §11.8 — the chain's `TransactionType` enum
 * currently has 13 variants; Phase 6 wires the full catalog. Values
 * below are pinned now to avoid drift across modules during the build.
 */
export const TxType = {
  Transfer: 0,
  ContractDeploy: 1,
  ContractCall: 2,
  RegisterPubkey: 13,
} as const;

export type TxTypeDiscriminant = (typeof TxType)[keyof typeof TxType];

/** Pending transaction handle. */
export interface TransactionResponse {
  hash: Hash;
  /** Wait for the tx to land in a wave. Throws TimeoutError if not by `timeoutMs`. */
  wait(timeoutMs?: number): Promise<Receipt>;
}

/** Transaction info returned by `getTransaction`. */
export interface TransactionInfo {
  hash: Hash;
  from: Address;
  to: Address;
  /** Hex-encoded u128. */
  value: string;
  data: string;
  /** Hex-encoded u64. */
  gasLimit: string;
  nonce: number;
  chainId: number;
  txType: number;
  /** Wave the tx was included in (omitted if pending — though Pyde has
   *  no pending state for encrypted-mempool txs; this is for plaintext
   *  paths and historical lookups). */
  waveId?: Wave;
}

/** Override params for `call` / `estimateGas`. */
export interface CallOverrides {
  from?: Address;
  value?: bigint | number | string;
  gasLimit?: number;
}

/** Current network fee data. Spec: Chapter 10 — EIP-1559 style, no tips in v1. */
export interface FeeData {
  /** Effective gas price (= base fee in v1; no priority fees). */
  gasPrice: bigint;
  /** Base fee per gas unit. */
  baseFee: bigint;
}

// ============================================================================
// Receipt helpers (bigint decoders for common return shapes)
// ============================================================================

/** Helpers for parsing Receipt return data into typed JS values. */
export const ReceiptUtils = {
  /** Parse `gasUsed` from hex to number. */
  gas(receipt: Receipt): number {
    return parseInt(strip0x(receipt.gasUsed), 16);
  },

  /** For deploy receipts: extract the deployed contract address. */
  contractAddress(receipt: Receipt): Address | null {
    const rd = receipt.returnData;
    if (!rd) return null;
    const hex = strip0x(rd);
    return hex.length === 64 ? "0x" + hex : null;
  },

  /** Raw return bytes as hex (or "0x" if none). */
  returnHex(receipt: Receipt): string {
    return receipt.returnData || "0x";
  },

  /** Decode return data as u64 (little-endian). */
  decodeU64(receipt: Receipt): bigint | null {
    const bytes = receiptBytes(receipt);
    return bytes && bytes.length >= 8 ? readU64LE(bytes, 0) : null;
  },

  /** Decode return data as bool. */
  decodeBool(receipt: Receipt): boolean | null {
    const v = ReceiptUtils.decodeU64(receipt);
    return v !== null ? v !== 0n : null;
  },

  /** Decode return data as length-prefixed UTF-8 string. */
  decodeString(receipt: Receipt): string | null {
    const bytes = receiptBytes(receipt);
    if (!bytes || bytes.length < 8) return null;
    const len = Number(readU64LE(bytes, 0));
    if (bytes.length < 8 + len) return null;
    return new TextDecoder("utf-8").decode(bytes.subarray(8, 8 + len));
  },

  /** Decode return data as i64. */
  decodeI64(receipt: Receipt): bigint | null {
    const bytes = receiptBytes(receipt);
    return bytes && bytes.length >= 8 ? readI64LE(bytes, 0) : null;
  },

  /** Decode return data as u128 (little-endian). */
  decodeU128(receipt: Receipt): bigint | null {
    const bytes = receiptBytes(receipt);
    if (!bytes || bytes.length < 16) return null;
    return readU64LE(bytes, 0) | (readU64LE(bytes, 8) << 64n);
  },

  /** Decode return data as i128 (little-endian, two's complement). */
  decodeI128(receipt: Receipt): bigint | null {
    const bytes = receiptBytes(receipt);
    if (!bytes || bytes.length < 16) return null;
    let val = readU64LE(bytes, 0) | (readU64LE(bytes, 8) << 64n);
    if (val >= 1n << 127n) val -= 1n << 128n;
    return val;
  },

  /** Decode return data as u256 (little-endian). */
  decodeU256(receipt: Receipt): bigint | null {
    const bytes = receiptBytes(receipt);
    if (!bytes || bytes.length < 32) return null;
    let val = 0n;
    for (let i = 0; i < 4; i++) {
      val |= readU64LE(bytes, i * 8) << BigInt(i * 64);
    }
    return val;
  },

  /** Decode return data as a 32-byte address. */
  decodeAddress(receipt: Receipt): Address | null {
    const bytes = receiptBytes(receipt);
    if (!bytes || bytes.length < 32) return null;
    let hex = "0x";
    for (let i = 0; i < 32; i++) hex += (bytes[i] ?? 0).toString(16).padStart(2, "0");
    return hex;
  },
};

// ============================================================================
// Local helpers (kept private to this module)
// ============================================================================

function strip0x(hex: string): string {
  return hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
}

function receiptBytes(receipt: Receipt): Uint8Array | null {
  const rd = receipt.returnData;
  if (!rd || rd === "0x") return null;
  const hex = strip0x(rd);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function readU64LE(bytes: Uint8Array, offset: number): bigint {
  let val = 0n;
  for (let i = 0; i < 8; i++) {
    val |= BigInt(bytes[offset + i] ?? 0) << BigInt(i * 8);
  }
  return val;
}

function readI64LE(bytes: Uint8Array, offset: number): bigint {
  let val = readU64LE(bytes, offset);
  if (val >= 1n << 63n) val -= 1n << 64n;
  return val;
}
