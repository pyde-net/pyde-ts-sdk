/**
 * Crypto bindings for Pyde — thin typed wrapper over `pyde-crypto-wasm`.
 *
 * What this module provides:
 *   1. Typed return types — JSON strings from WASM parsed into objects.
 *   2. Handle-based signing as the preferred API surface.
 *   3. Spec-cited TSDoc tying each function back to the book.
 *
 * What this module does NOT do:
 *   - Implement any primitive. Everything routes to pyde-crypto-wasm
 *     (wasm-bindgen wrapper around the same Rust crate the node uses).
 *
 * Security:
 *   - Prefer handle-based functions (`generateKeypairHandle`,
 *     `signMessageWithHandle`, `signTransactionWithHandle`, `dropKeypair`).
 *     Handles keep the FALCON-512 secret key inside the WASM heap; the
 *     SK bytes never enter the JS heap.
 *   - Hex-string variants exist for keystore workflows (encrypt-to-disk
 *     then discard) only. Callers MUST discard the value immediately
 *     and never log it.
 *
 * Spec:
 *   - Chapter 8.2:  FALCON-512 (signatures)
 *   - Chapter 8.3:  Kyber-768 / ML-KEM (threshold KEM)
 *   - Chapter 8.4:  Poseidon2 + Blake3 (hashing)
 *   - Chapter 8.5:  Threshold Encryption (MEV protection)
 *   - Chapter 9:    MEV Protection (user-facing flow)
 *   - Chapter 11 §11.2: EOA address = Poseidon2(falcon_public_key_bytes)
 *   - Chapter 11:   RegisterPubkey tx type (address-derivation proof)
 */

import * as wasm from "./vendor/crypto-wasm/pyde_crypto_wasm.js";

import type { AccessEntry, TxFields } from "./types";
import { InvalidArgumentError, SigningError } from "./errors";

// ============================================================================
// Types
// ============================================================================

/**
 * Hex-secret-key keypair. ⚠️ Prefer `KeypairHandle` for live signing;
 * use this only when the SK must transit JS for keystore encryption.
 */
export interface Keypair {
  /** FALCON-512 public key (897 bytes hex). */
  publicKey: string;
  /** FALCON-512 secret key (1281 bytes hex). Sensitive. */
  secretKey: string;
  /** 32-byte address = Poseidon2(publicKey). */
  address: string;
}

/**
 * Opaque handle to a SK retained in the WASM heap. Pair with
 * `signMessageWithHandle` / `signTransactionWithHandle` for signing
 * and `dropKeypair(handle)` to zeroize when done.
 */
export interface KeypairHandle {
  /** FALCON-512 public key (897 bytes hex). */
  publicKey: string;
  /** 32-byte address = Poseidon2(publicKey). */
  address: string;
  /** Opaque u32 handle — pass to handle-based signers. */
  handle: number;
}

/**
 * Params for the one-shot MEV-protected tx builder. The `(to, value,
 * calldata)` triple is threshold-encrypted against the committee
 * pubkey so RPC operators cannot read tx contents before commit.
 *
 * Spec: Chapter 8.5 + Chapter 9.
 */
export interface EncryptedTxParams {
  /** Committee threshold pubkey hex. Cache per session — fetch via
   *  `Provider.getThresholdPublicKey()`. */
  thresholdPk: string;
  /** Sender address (32-byte hex). Plaintext on the wire. */
  sender: string;
  /** Per-sender tx counter (u64) — see chapter 11's 16-slot nonce window. */
  nonce: bigint;
  /** Gas budget for the decrypted inner tx. */
  gasLimit: number;
  /** Optional. Used by the parallel scheduler to place the tx without
   *  blocking. Populate via `Provider.estimateAccess(...)` for non-trivial
   *  calls. Plaintext on the wire. */
  accessList?: AccessEntry[];
  /** Optional wave-based deadline (drop if not committed by this wave). */
  deadline?: number | null;
  /** Chain ID for replay protection. */
  chainId: number;
  /** Recipient (32-byte hex). Encrypted on the wire. */
  to: string;
  /** Value in quanta, decimal string (bigint-safe). Encrypted. */
  value: string;
  /** Call data hex. Encrypted. Defaults to "0x". */
  calldata?: string;
}

// ============================================================================
// Key generation
// ============================================================================

/** Generate a FALCON-512 keypair with hex SK. ⚠️ Prefer `generateKeypairHandle`.
 *  Spec: Chapter 8.2 + Chapter 11 §11.1. */
export function generateKeypair(): Keypair {
  return JSON.parse(wasm.generateKeypair()) as Keypair;
}

/** Generate a FALCON-512 keypair with SK retained in the WASM heap.
 *  The SK bytes never enter the JS heap. Spec: Chapter 8.2. */
export function generateKeypairHandle(): KeypairHandle {
  return JSON.parse(wasm.generateKeypairHandle()) as KeypairHandle;
}

/** Deterministically derive a FALCON-512 keypair from a 32-byte seed.
 *  Same hex-SK shape as `generateKeypair` — same security warning.
 *
 *  Matches the engine's devnet-prefund derivation:
 *
 *  ```
 *  seed_i = Blake3("pyde-devnet-v1/" || (i as u64 LE bytes))
 *  ```
 *
 *  Lets integration tests fund SDK-derived addresses via a devnet
 *  prefunded wallet without round-tripping through the otigen keystore. */
export function keypairFromSeed(seedHex: string): Keypair {
  return JSON.parse(wasm.keypairFromSeed(seedHex)) as Keypair;
}

/** Drop a keypair handle, zeroizing the retained SK. Idempotent —
 *  returns `false` if the handle was already dropped. */
export function dropKeypair(handle: number): boolean {
  return wasm.dropKeypair(handle);
}

// ============================================================================
// Address derivation
// ============================================================================

/** Derive a 32-byte address from a FALCON-512 public key.
 *  Spec: Chapter 11 §11.2 — `address = Poseidon2(falcon_public_key_bytes)`. */
export function deriveAddress(publicKeyHex: string): string {
  return wasm.deriveAddress(publicKeyHex);
}

// ============================================================================
// Signing — message
// ============================================================================

/** FALCON-512 sign a message with a hex SK. ⚠️ Prefer the handle variant.
 *  Spec: Chapter 8.2. */
export function signMessage(secretKeyHex: string, messageHex: string): string {
  try {
    return wasm.signMessage(secretKeyHex, messageHex);
  } catch (e) {
    throw new SigningError(scrubError(e));
  }
}

/** FALCON-512 sign a message using a retained handle. Spec: Chapter 8.2. */
export function signMessageWithHandle(handle: number, messageHex: string): string {
  try {
    return wasm.signMessageWithHandle(handle, messageHex);
  } catch (e) {
    throw new SigningError(scrubError(e));
  }
}

// ============================================================================
// Signing — transaction
// ============================================================================

/** Sign a transaction (returns wire-encoded signed tx hex).
 *  ⚠️ Prefer the handle variant. Spec: Chapter 8.2 + Chapter 11. */
export function signTransaction(tx: TxFields, secretKeyHex: string): string {
  try {
    return wasm.signTransaction(toWasmJson(tx), secretKeyHex);
  } catch (e) {
    throw new SigningError(scrubError(e));
  }
}

/** Sign a transaction using a retained handle. Spec: Chapter 8.2 + Chapter 11. */
export function signTransactionWithHandle(tx: TxFields, handle: number): string {
  try {
    return wasm.signTransactionWithHandle(toWasmJson(tx), handle);
  } catch (e) {
    throw new SigningError(scrubError(e));
  }
}

// ============================================================================
// Verification
// ============================================================================

/** Verify a FALCON-512 signature. Spec: Chapter 8.2. */
export function verifySignature(
  publicKeyHex: string,
  messageHex: string,
  signatureHex: string,
): boolean {
  return wasm.verifySignature(publicKeyHex, messageHex, signatureHex);
}

// ============================================================================
// Hashing
// ============================================================================

/** Poseidon2 hash of arbitrary bytes (ZK-friendly).
 *  Spec: Chapter 8.4 — used for address derivation + JMT internal nodes. */
export function poseidon2Hash(dataHex: string): string {
  return wasm.poseidon2Hash(dataHex);
}

// ============================================================================
// Function selectors
// ============================================================================

/** FNV-1a selector for a method name. Matches Otigen codegen so SDK and
 *  contract-side codegen produce identical selectors. */
export function computeSelector(methodName: string): number {
  // wasm-bindgen's release-mode `passStringToWasm0` doesn't validate
  // its arg is a string — handing it a non-string makes the buffer-
  // length math go NaN and the realloc traps with
  // `RuntimeError: memory access out of bounds`. Validate at the JS
  // boundary so callers get an actionable error instead of a wasm
  // stack trace pointing at a phantom OOB.
  if (typeof methodName !== "string") {
    throw new InvalidArgumentError(
      `computeSelector: methodName must be a string, got ${typeof methodName}`,
      "methodName",
      methodName,
    );
  }
  return wasm.computeSelector(methodName);
}

// ============================================================================
// Transaction hash
// ============================================================================

/** Canonical tx hash without signing — same formula the node uses.
 *  Spec: Chapter 11 (tx wire format). */
export function hashTransaction(tx: TxFields): string {
  return wasm.hashTransaction(toWasmJson(tx));
}

/**
 * Compute the **plaintext** inner-Tx hash that the chain reconstructs
 * after threshold-decrypting an `EncryptedTx`. Receipts are stored
 * keyed by this hash post-commit, NOT the envelope hash echoed back
 * from `pyde_sendRawEncryptedTransaction`. Use it to poll
 * `Provider.waitForReceipt(plaintextHash)` for an encrypted tx.
 *
 * Mirrors `build_inner_tx_value` in pyde-crypto-wasm: renames
 * `sender → from`, `calldata → data` (default `"0x"`), defaults
 * `txType` to `Standard` (0). Forwards `accessList` so the chain-side
 * `hash_access_list` runs over the same entries. `deadline` is
 * deliberately not included — the chain hashes it as `None` regardless
 * (see `compute_tx_hash` in pyde-crypto-wasm).
 *
 * Spec: Chapter 8.5 + Chapter 9.
 */
export function plaintextHashFromEncryptedParams(params: EncryptedTxParams): string {
  const innerTx: TxFields = {
    from: params.sender,
    to: params.to,
    value: params.value,
    data: params.calldata ?? "0x",
    gasLimit: params.gasLimit,
    nonce: params.nonce,
    chainId: params.chainId,
    // Encrypted submission is wired only for Standard (transfers + generic
    // contract calls); buildRawEncryptedTx hardcodes this on the wasm side.
    txType: 0,
    ...(params.accessList ? { accessList: params.accessList } : {}),
  };
  return hashTransaction(innerTx);
}

// ============================================================================
// RegisterPubkey transaction (unsigned)
// ============================================================================

/**
 * Wire-encode a `RegisterPubkey` tx without signing.
 *
 * No FALCON signature is needed or accepted: the chain's
 * address-derivation check (`from == Poseidon2(data)`) IS the proof of
 * pubkey ownership. WASM refuses to encode any other tx type here —
 * misuse on a signed-tx path would be a hard-to-debug protocol violation.
 *
 * Pre-conditions (enforced by the chain):
 *   - The account must exist with `balance > 0`.
 *   - The account must not already be registered.
 *
 * Spec: Chapter 11 (RegisterPubkey tx type).
 */
export function encodeRegisterPubkeyTx(tx: TxFields): string {
  return wasm.encodeRegisterPubkeyTx(toWasmJson(tx));
}

// ============================================================================
// Threshold encryption (MEV protection)
// ============================================================================

/**
 * Threshold-encrypt arbitrary bytes against the committee pubkey.
 *
 * `payloadHex` is typically `to (32) || value_le (16) || calldata`.
 * Returns hex of `ThresholdCiphertext::to_wire_bytes()` ready to embed
 * in an `EncryptedTx`. Most callers want `buildRawEncryptedTx` instead.
 *
 * Spec: Chapter 8.5 + Chapter 9.
 */
export function thresholdEncrypt(thresholdPkHex: string, payloadHex: string): string {
  return wasm.thresholdEncrypt(thresholdPkHex, payloadHex);
}

/**
 * One-shot MEV-protected tx builder. Does the full flow in a single call:
 *   1. Threshold-encrypt `(to || value_le || calldata)` against the
 *      committee pubkey.
 *   2. Assemble the `EncryptedTx` wire frame.
 *   3. Compute `EncryptedTx::hash` (same formula the node uses).
 *   4. FALCON-sign the hash with the sender's secret key.
 *   5. Serialize the full wire frame.
 *
 * Returns hex of the wire-encoded `EncryptedTx`, ready for
 * `Provider.sendRawEncryptedTransaction`.
 *
 * Spec: Chapter 8.5 + Chapter 9 (canonical MEV-protected path).
 */
export function buildRawEncryptedTx(params: EncryptedTxParams, secretKeyHex: string): string {
  // Pre-fill `calldata` so the WASM side never sees `undefined`.
  // Pre-fill calldata default. Spread first so explicit `calldata:
  // undefined` from the caller doesn't shadow the default — the `??`
  // fallback handles both undefined and missing keys uniformly.
  const withDefaults: EncryptedTxParams = { ...params, calldata: params.calldata ?? "0x" };
  try {
    return wasm.buildRawEncryptedTx(toWasmJson(withDefaults), secretKeyHex);
  } catch (e) {
    throw new SigningError(scrubError(e));
  }
}

/**
 * Handle-based variant of `buildRawEncryptedTx`. Same params + same
 * wire-format output, but signs using a key retained in the WASM heap
 * via `generateKeypairHandle`. The SK bytes never enter the JS heap.
 *
 * Spec: Chapter 8.5 + Chapter 9.
 */
export function buildRawEncryptedTxWithHandle(params: EncryptedTxParams, handle: number): string {
  // Pre-fill calldata default. Spread first so explicit `calldata:
  // undefined` from the caller doesn't shadow the default — the `??`
  // fallback handles both undefined and missing keys uniformly.
  const withDefaults: EncryptedTxParams = { ...params, calldata: params.calldata ?? "0x" };
  try {
    return wasm.buildRawEncryptedTxWithHandle(toWasmJson(withDefaults), handle);
  } catch (e) {
    throw new SigningError(scrubError(e));
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * JSON.stringify replacer that converts bigint values to JS numbers
 * for the WASM boundary. pyde-crypto-wasm's serde_json deserializer
 * accepts JSON numbers for u64 fields but cannot decode strings as
 * u64. Conversion is guarded — values above Number.MAX_SAFE_INTEGER
 * throw a clear SigningError rather than silently truncating.
 *
 * Used by every `toWasmJson(tx)` call in this module so the
 * SDK's public bigint types survive the round-trip without loss for
 * any realistically-achievable value.
 */
function jsonBigIntReplacer(key: string, value: unknown): unknown {
  if (typeof value === "bigint") {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new SigningError(
        "bigint value exceeds JS safe-integer range; pyde-crypto-wasm boundary requires u64 fit in 2^53",
      );
    }
    return Number(value);
  }
  if (key === "accessType") {
    if (value === "read") return 0;
    if (value === "readWrite") return 1;
  }
  return value;
}

/** Stringify with bigint support — every WASM-boundary serialization in
 *  this module routes through here. */
function toWasmJson(v: unknown): string {
  return JSON.stringify(v, jsonBigIntReplacer);
}

/**
 * Defense-in-depth: replace any long hex run in an error message with
 * a redaction marker before propagating. WASM errors shouldn't echo
 * input bytes back, but we don't want a future bug there to leak the
 * SK through this SDK's error path either.
 */
function scrubError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  // First pass: redact long hex runs whether or not they're 0x-prefixed
  // (catches FALCON SK / pk leaks regardless of formatting).
  const longHex = raw.replace(/(?:0x)?[0-9a-fA-F]{200,}/g, "[REDACTED]");
  // Second pass: redact 32-byte+ 0x-prefixed values (addresses, hashes,
  // sigs — generally safe to expose but defense-in-depth).
  return longHex.replace(/0x[0-9a-fA-F]{64,}/g, "0x[REDACTED]");
}
