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

import * as wasm from "pyde-crypto-wasm";

import type { AccessEntry, TxFields } from "./types";
import { SigningError } from "./errors";

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
  /** Per-sender tx counter — see chapter 11's 16-slot nonce window. */
  nonce: number;
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
    return wasm.signTransaction(JSON.stringify(tx), secretKeyHex);
  } catch (e) {
    throw new SigningError(scrubError(e));
  }
}

/** Sign a transaction using a retained handle. Spec: Chapter 8.2 + Chapter 11. */
export function signTransactionWithHandle(tx: TxFields, handle: number): string {
  try {
    return wasm.signTransactionWithHandle(JSON.stringify(tx), handle);
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
  return wasm.computeSelector(methodName);
}

// ============================================================================
// Transaction hash
// ============================================================================

/** Canonical tx hash without signing — same formula the node uses.
 *  Spec: Chapter 11 (tx wire format). */
export function hashTransaction(tx: TxFields): string {
  return wasm.hashTransaction(JSON.stringify(tx));
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
  return wasm.encodeRegisterPubkeyTx(JSON.stringify(tx));
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
export function buildRawEncryptedTx(
  params: EncryptedTxParams,
  secretKeyHex: string,
): string {
  // Pre-fill `calldata` so the WASM side never sees `undefined`.
  const withDefaults: EncryptedTxParams = { calldata: "0x", ...params };
  try {
    return wasm.buildRawEncryptedTx(JSON.stringify(withDefaults), secretKeyHex);
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
export function buildRawEncryptedTxWithHandle(
  params: EncryptedTxParams,
  handle: number,
): string {
  const withDefaults: EncryptedTxParams = { calldata: "0x", ...params };
  try {
    return wasm.buildRawEncryptedTxWithHandle(JSON.stringify(withDefaults), handle);
  } catch (e) {
    throw new SigningError(scrubError(e));
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Defense-in-depth: replace any long hex run in an error message with
 * a redaction marker before propagating. WASM errors shouldn't echo
 * input bytes back, but we don't want a future bug there to leak the
 * SK through this SDK's error path either.
 */
function scrubError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  return raw.replace(/0x[0-9a-fA-F]{64,}/g, "0x[REDACTED]");
}
