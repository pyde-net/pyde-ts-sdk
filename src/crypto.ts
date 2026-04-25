// eslint-disable-next-line @typescript-eslint/no-var-requires
const wasm = require("../wasm/pyde_crypto_wasm");

import { AccessEntry, TxFields } from "./types";

export interface Keypair {
  publicKey: string;
  secretKey: string;
  address: string;
}

/** Generate a new FALCON-512 keypair with derived address. */
export function generateKeypair(): Keypair {
  return JSON.parse(wasm.generateKeypair());
}

/** Derive address from a FALCON-512 public key hex. */
export function deriveAddress(publicKeyHex: string): string {
  return wasm.deriveAddress(publicKeyHex);
}

/** Sign a message hash with a FALCON-512 secret key. Returns signature hex. */
export function signMessage(secretKeyHex: string, messageHex: string): string {
  return wasm.signMessage(secretKeyHex, messageHex);
}

/** Verify a FALCON-512 signature. */
export function verifySignature(
  publicKeyHex: string,
  messageHex: string,
  signatureHex: string
): boolean {
  return wasm.verifySignature(publicKeyHex, messageHex, signatureHex);
}

/** Compute Poseidon2 hash of arbitrary data (hex). */
export function poseidon2Hash(dataHex: string): string {
  return wasm.poseidon2Hash(dataHex);
}

/** Compute FNV-1a function selector. */
export function computeSelector(methodName: string): number {
  return wasm.computeSelector(methodName);
}

/** Compute transaction hash from fields. */
export function hashTransaction(tx: TxFields): string {
  return wasm.hashTransaction(JSON.stringify(tx));
}

/** Sign a transaction and return wire-encoded signed tx as hex. */
export function signTransaction(tx: TxFields, secretKeyHex: string): string {
  return wasm.signTransaction(JSON.stringify(tx), secretKeyHex);
}

/**
 * Wire-encode a `TransactionType::RegisterPubkey` (audit 229) tx
 * without signing. The address-derivation check (`from ==
 * Poseidon2(data)`) IS the proof of pubkey ownership for this
 * tx type, so a FALCON sig is neither needed nor accepted.
 *
 * Refuses to encode any other tx type — accidental misuse on a
 * signed-tx path would be a hard-to-debug protocol violation.
 */
export function encodeRegisterPubkeyTx(tx: TxFields): string {
  return wasm.encodeRegisterPubkeyTx(JSON.stringify(tx));
}

// ============================================================================
// Threshold encryption (MEV-protected submission)
// ============================================================================

/**
 * Encrypt bytes against the committee's threshold public key. Returns
 * hex of `ThresholdCiphertext::to_wire_bytes()` — usable directly by
 * anything that needs to embed an MEV-protected payload. Most callers
 * want `buildRawEncryptedTx` instead, which chains this with the
 * full EncryptedTx assembly + signing.
 */
export function thresholdEncrypt(
  thresholdPkHex: string,
  payloadHex: string
): string {
  return wasm.thresholdEncrypt(thresholdPkHex, payloadHex);
}

/** Params for `buildRawEncryptedTx`. All addresses + hashes are
 * `0x`-prefixed hex. */
export interface EncryptedTxParams {
  /** Committee threshold public key (hex) — fetch via
   *  `Provider.getThresholdPublicKey()`. Cacheable per session. */
  thresholdPk: string;
  /** Sender address (32-byte hex). */
  sender: string;
  /** Per-sender transaction counter. */
  nonce: number;
  /** Gas budget for the decrypted inner tx. */
  gasLimit: number;
  /** Optional access list. Plaintext on the wire — used by the
   *  parallel scheduler to place the tx without blocking. Populate
   *  via `Provider.createAccessList(...)` for non-trivial calls. */
  accessList?: AccessEntry[];
  /** Optional slot-based expiry. */
  deadline?: number | null;
  /** Chain ID (31337 for local devnet). */
  chainId: number;
  /** Recipient address (32-byte hex). Encrypted on the wire. */
  to: string;
  /** Value in quanta, decimal string (bigint-safe). Encrypted. */
  value: string;
  /** Call data (hex). Encrypted. Defaults to empty. */
  calldata?: string;
}

/**
 * Client-side EncryptedTx builder — threshold-encrypts the private
 * fields, assembles + FALCON-signs the envelope, returns wire bytes
 * ready for `Provider.sendRawEncryptedTransaction`.
 *
 * The node never sees plaintext `(to, value, calldata)` and the
 * signature binds to a hash the CLIENT computed (a property the
 * server-side `pyde_sendEncryptedTransaction` cannot achieve).
 *
 * Wire format matches `pyde-mempool::encrypted::EncryptedTx`
 * byte-for-byte — the Rust native round-trip test in
 * `pyde-crypto-wasm` guards against drift.
 */
export function buildRawEncryptedTx(
  params: EncryptedTxParams,
  secretKeyHex: string
): string {
  // Pre-fill default for calldata so the WASM side never sees
  // `undefined`.
  const withDefaults: EncryptedTxParams = {
    calldata: "0x",
    ...params,
  };
  return wasm.buildRawEncryptedTx(JSON.stringify(withDefaults), secretKeyHex);
}
