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

/** Wave ID — Pyde's primary chain primitive (u64 on chain).
 *  Typed as `bigint` so the SDK never silently truncates near the
 *  2^53 JS safe-integer boundary. Spec: Chapter 6. */
export type Wave = bigint;

/** 32-byte hex hash (Poseidon2 or Blake3 output). */
export type Hash = string;

/** 32-byte address.
 *  Spec: Chapter 11 §11.2 — EOA = Poseidon2(falcon_public_key_bytes);
 *  contracts = Poseidon2(deployer || nonce) or Poseidon2(0xFF || deployer
 *  || salt || code_hash) for CREATE2. */
export type Address = string;

// ============================================================================
// Account record (returned by getAccount)
// ============================================================================

/** Account-type discriminant. Spec: Chapter 11 §11.1. */
export const AccountType = {
  EOA: 0,
  Contract: 1,
  System: 2,
} as const;

export type AccountTypeDiscriminant = (typeof AccountType)[keyof typeof AccountType];

/**
 * Full account record returned by `pyde_getAccount`.
 * Spec: Chapter 11 §11.1 (141 bytes fixed-portion + variable `authKeys`).
 *
 * Numeric fields are hex-encoded on the wire and exposed as bigint for
 * u128 values (balance / gasTank) and number for u64 / u32 (nonce /
 * keyNonce). 32-byte hashes are 0x-prefixed hex strings.
 */
export interface Account {
  address: string;
  /** Low end of the 16-slot nonce window (u64; typed bigint to avoid
   *  silent truncation for long-running accounts). */
  nonce: bigint;
  /** Spendable balance in quanta (u128). */
  balance: bigint;
  /** WASM code hash (Poseidon2). Zero hash for EOAs. */
  codeHash: Hash;
  /** State subtree root for this account. Zero for empty contracts /
   *  freshly-funded EOAs. Engine ships this under `state_root` per
   *  Chapter 11 §11.1; the SDK uses `stateRoot` to match the wire. */
  stateRoot: Hash;
  accountType: AccountTypeDiscriminant;
  /** Opaque authorization-keys blob (variable layout per Chapter 11 §11.5). */
  authKeys: string;
  /** Sponsored-tx balance pool (u128). */
  gasTank: bigint;
  /** Key-rotation counter. */
  keyNonce: number;
}

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

/** Committee-signed hard finality certificate. The committee signs the
 *  wave commit; ≥85 of 128 entries required for hard finality so a
 *  light client can verify the entire wave's integrity.
 *  Spec: Chapter 6 + `pyde_engine_types::consensus::HardFinalityCert`. */
export interface HardFinalityCert {
  /** The wave commit being attested. */
  commit: WaveCommit;
  /** Committee signatures: `(memberId, FALCON-512 signature)` pairs.
   *  `memberId ∈ [0, COMMITTEE_SIZE)`; `length >= 85` on a quorum-passing
   *  cert. v1 wire form is a list of FALCON sigs (true aggregate
   *  signatures arrive in a future engine release). */
  signatures: Array<{ memberId: number; signature: string }>;
}

/** Per-wave commit record carried inside `HardFinalityCert.commit` and
 *  echoed (in flatter form) by `Provider.getWave`. */
export interface WaveCommit {
  waveId: Wave;
  /** Round of the anchor vertex that committed this wave. */
  anchorRound: bigint;
  /** Round of the prior wave's anchor — `null` only for the first
   *  wave after genesis. */
  priorAnchorRound: bigint | null;
  /** Anchor vertex hash. */
  anchorHash: Hash;
  /** Epoch this wave belongs to. */
  epoch: bigint;
  /** Beacon for the NEXT epoch — populated only on the last wave
   *  of each epoch (Ch 6 §9 step 4). `null` on every other wave. */
  nextEpochBeacon: string | null;
  /** State root after this wave's txs are applied. Dual-hash
   *  (Blake3 + Poseidon2). Pre-PR-#349 engines emit a single Blake3
   *  string — kept as a backward-compat fallback. */
  stateRoot: { blake3: Hash; poseidon2: Hash } | Hash;
  /** Blake3 binary-Merkle root over the wave's events. */
  eventsRoot: Hash;
  /** 256-byte bloom filter over event topics + emitter addresses (hex). */
  eventsBloom: string;
  /** Total gas consumed across all txs in the wave. */
  gasUsed: bigint;
}

// ============================================================================
// State-sync snapshot
// ============================================================================

/** Snapshot manifest for state sync (light client / fresh validator).
 *  Wire shape per engine RPC catalog v0.1 §26 `pyde_getSnapshotManifest`.
 *  v1 ships single Blake3 state-root + flat chunk_hashes; dual-root +
 *  committee signatures (per the book design) are deferred until the
 *  archival service ships. */
export interface SnapshotManifest {
  /** Wave the manifest was built at (last_flushed_wave). */
  waveId: bigint;
  /** Blake3 root of the snapshot at `waveId`. */
  stateRoot: Hash;
  /** Bytes per chunk (uniform across chunks except possibly the last). */
  chunkSize: number;
  /** Number of chunks comprising the snapshot. */
  chunkCount: number;
  /** Blake3 hash of each chunk's bytes, indexed positionally. */
  chunkHashes: Hash[];
  /** Total state keys captured. */
  totalKeys: number;
}

// ============================================================================
// Receipt
// ============================================================================

/** Which layer rejected a reverted tx. Matches the engine's
 *  `pyde_engine_types::RevertCategory`. The SDK keeps unknown
 *  values as plain strings for forward-compat. */
export type RevertCategory =
  /** Engine-side pre-execution checks: nonce window, fee payment,
   *  balance for `fee + value`, native handler reject, dispatch
   *  decode. The tx never reached the contract / transfer commit. */
  | "EngineValidation"
  /** Contract code called `revert(msg)` explicitly. `message` is the
   *  contract's revert string (empty when the contract reverted
   *  without revert data). */
  | "Contract"
  /** VM-level abort: wasmtime trap, memory out of bounds, gas
   *  exhausted inside the executor, host-fn rejection. The contract
   *  didn't *choose* to revert — the VM had to stop it. */
  | "Vm";

/** Structured revert payload carried on every `Reverted` receipt.
 *  Branch on `category` for control flow; treat `message` as display
 *  text only (format may shift between engine releases). */
export interface RevertReason {
  /** Engine-categorised reject layer. Forward-compat string allowed
   *  so future variants don't break the parser. */
  category: RevertCategory | (string & {});
  /** Human-readable reason from that layer. */
  message: string;
}

/** Transaction receipt — emitted at execution. Spec: Chapter 10. */
export interface Receipt {
  txHash: Hash;
  /** Position of this tx within the wave's canonical order. */
  txIndex: number;
  success: boolean;
  /** Hex-encoded u64. */
  gasUsed: string;
  /** Effective gas (= gasUsed in v1; no refunds per Chapter 10 §10.1).
   *  `null` when the engine omits the field on the wire — distinguish
   *  "missing" from a real `0x0` charge. */
  effectiveGas: string | null;
  /** Total fee paid (base × gasUsed), hex-encoded u128. */
  feePaid: string;
  /** Portion of fee burned (Chapter 10 — EIP-1559-style). `null` when
   *  the engine omits the field — distinguish "missing" from `0x0`. */
  feeBurned: string | null;
  /** Portion of fee credited to the wave's validator. `null` when the
   *  engine omits the field — distinguish "missing" from `0x0`. */
  feeValidator: string | null;
  /** Return data hex. Ephemeral — only in this receipt; absent on
   *  subsequent tx lookups. */
  returnData?: string;
  /** Structured revert payload on `Reverted` receipts. Null on
   *  `success` / `out_of_gas`. */
  revertReason: RevertReason | null;
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
 * Matches `pyde_engine_types::AccessEntry` v1: one entry per
 * `(address, accessType)` pair carrying the storage slots touched
 * in that direction. v1's `AccessType` has two discriminants:
 * `Read` (slot only read; multiple `Read` entries for the same
 * slot run in parallel) and `ReadWrite` (slot may be written;
 * conflicts with any other entry — read or write — for the same
 * slot). There is no separate write-only variant; write-only goes
 * through `ReadWrite`.
 */
export interface AccessEntry {
  /** Account whose slots are accessed. */
  address: Address;
  /** Slot keys (32-byte hex) touched within `address`. */
  storageKeys: Hash[];
  /** Whether these slots are read-only or read-write. */
  accessType: "read" | "readWrite";
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
  /** Per-sender counter within the 16-slot nonce window (u64). */
  nonce: bigint;
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
 * Transaction-type discriminants. Const-object (not a TS `enum`) so
 * values land as literal types with autocomplete and zero runtime cost.
 *
 * Spec: Chapter 11 §11.8 — the chain's `TransactionType` enum (in
 * `crates/tx/src/types.rs`) has the variants below. Tag `2` is
 * intentionally vacant — `Batch` was prototyped pre-mainnet and removed
 * before launch; keeping the gap means a forged `tx_type = 2` fails
 * decode rather than silently aliasing to another type.
 *
 * Note: `Standard` (id 0) covers BOTH value transfers and contract
 * calls. The chain dispatches on the recipient + data shape, not on a
 * separate tx-type. See `Wallet.transfer()` vs `Wallet.sendCall()` —
 * both submit with `txType: Standard`.
 */
export const TxType = {
  /** Value transfer or contract call. */
  Standard: 0,
  /** Contract deployment (`to == 0x00..00`, data = initcode). */
  Deploy: 1,
  /** Register as a validator. Data = FALCON pubkey (897 B); value ≥ 10,000 PYDE. */
  StakeDeposit: 3,
  /** Begin 30-day unbonding from the staking pool. */
  StakeWithdraw: 4,
  /** Submit double-sign evidence (data = serialized evidence). */
  Slash: 5,
  /** Claim accrued staking yield. */
  ClaimReward: 6,
  /** Claim genesis airdrop with Merkle proof. */
  ClaimAirdrop: 7,
  /** Sweep unclaimed airdrop to treasury (post-deadline). */
  SweepAirdrop: 8,
  /** Treasury spend with multisig signatures. */
  MultisigTx: 9,
  /** Rotate the multisig signer set and required-signature count. */
  RotateMultisig: 10,
  /** Halt block production (multisig-signed). */
  EmergencyPause: 11,
  /** Resume normal processing (multisig-signed, clears pause). */
  EmergencyResume: 12,
  /**
   * First-time pubkey registration for a funded-but-unregistered
   * account. No signature, no gas, no value — pubkey ownership is
   * proven by the chain's `from == Poseidon2(data)` check. Allowed
   * only when `balance > 0` and `auth_keys == AuthKeys::None`.
   */
  RegisterPubkey: 13,
  /**
   * Release a validator from `Status::Jailed` back to
   * `Status::Active`. Allowed only when the jail period has
   * elapsed (`wave_id >= jail_until_wave`) and the caller pays the
   * unjail fee. `tx.from` is the validator's own address;
   * `tx.to == ZERO`; `tx.data` is empty.
   */
  Unjail: 14,
  /**
   * Rotate the FALCON-512 signing key on an already-registered
   * validator. `tx.from` is the validator's address; `tx.to == ZERO`;
   * `tx.data` is the new 897-byte FALCON pubkey. The tx itself is
   * signed by the OLD key — the handler swaps both
   * `ValidatorRecord.pubkey` and `Account.auth_keys` to the new
   * pubkey on success. Allowed only while `Status == Active`.
   */
  RotateValidatorKeys: 15,
  /**
   * Governance dispute over a pending slash. Treasury multisig
   * gates submission via an embedded bundle; `tx.from` is any
   * address, `tx.to == ZERO`, `tx.data` is `borsh(DisputeSlashPayload)`
   * — `{escrow_id, action, multisig_sigs}` where `action` is `Void`
   * or `Reduce { new_bps }`. Allowed only while the targeted
   * `PendingSlash` is still `Pending`.
   */
  DisputeSlash: 16,
  /**
   * `0x11` (17) — Commit-reveal private mempool, phase 1: reserve an
   * ordering slot. `tx.to == ZERO`; `tx.value` = the bond
   * (`requiredBond(valueCeiling)`); `tx.data = borsh(CommitPayload)` =
   * `{commitment, valueCeiling}`. The commitment reserves the slot; the
   * bond is refunded when the matching `Reveal` lands and burned if it
   * never does. See `./private-tx`.
   */
  Commit: 0x11,
  /**
   * `0x12` (18) — Commit-reveal private mempool, phase 2: open a
   * commitment. `tx.to == ZERO`; `tx.value == 0`;
   * `tx.data = borsh(RevealPayload)` = `{commitment, nonce, innerTx}`
   * embedding the hidden, fully-signed inner tx. May be signed by ANY
   * account (relay-friendly) — the preimage is the authorization. The
   * inner tx executes in the reveal wave's resolution pass, in commit
   * order. See `./private-tx`.
   */
  Reveal: 0x12,
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
  /** Per-sender counter (u64). */
  nonce: bigint;
  chainId: number;
  txType: number;
  /** Wave the tx was included in (omitted if pending — for historical
   *  lookups). */
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

/** Mainnet metrics snapshot from `pyde_getMetrics`. Schema mirrors
 *  the engine's `MainLoopMetrics` 1:1 — every mainloop subsystem
 *  exposes its counter here. Snapshot is instant-at-request; for
 *  time-series use the Prometheus `/metrics` HTTP exposition. */
export interface MetricsSnapshot {
  [counter: string]: number | string;
}

/** Node identity probe from `pyde_getNodeInfo`. `falconPubkey: null`
 *  distinguishes full / archive nodes (no consensus signing identity)
 *  from validators. SDKs gate "this node can sign" UX on the
 *  non-null variant. */
export interface NodeInfo {
  /** libp2p peer id (hex). */
  peerId: string;
  /** Validator FALCON-512 pubkey, or `null` for full / archive nodes. */
  falconPubkey: string | null;
  /** Public listen multiaddrs. */
  listenAddrs: string[];
  /** Build-version string, e.g. `"pyde/0.1.0"`. */
  agentVersion: string;
  /** Protocol-family tag — `"pyde/1"` for the v1 stack. */
  protocolVersion: string;
}

/** Validator record returned by `pyde_getValidator`. */
export interface ValidatorInfo {
  validatorAddress: string;
  operator: string;
  pubkey: string;
  stake: bigint;
  status: "active" | "unbonding" | "exited" | "jailed";
  unbondAtWave: bigint | null;
  jailUntilWave: bigint | null;
  /** Last-claimed rewards-per-stake checkpoint (u128 quanta). */
  lastClaimedRps: bigint;
  /** Uptime, basis points (`9999` = 99.99 %). */
  uptimeBps: number;
}

/** Result of `pyde_simulateTransaction` — dry-run with access-list tracking. */
export interface SimulateTransactionResult {
  /** Decoded receipt for txs that produce one (contract calls, deploys).
   *  `null` for no-op txs (system tx types, plain transfers to EOAs). */
  receipt: {
    status: "Success" | "Reverted" | "OutOfGas";
    gasUsed: bigint;
    feePaid: bigint;
    returnData: string;
  } | null;
  /** Slot keys the tx would read + the version observed at sim time. */
  reads: { slot: string; observedVersion: { txIndex: number; attempt: number } | null }[];
  /** Slot keys the tx would write. */
  writes: string[];
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
