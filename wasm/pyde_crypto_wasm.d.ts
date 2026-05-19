/* tslint:disable */
/* eslint-disable */

/**
 * One-shot client-side EncryptedTx builder. Does everything a
 * wallet needs for the MEV-protected flow in a single call:
 *
 *   1. Threshold-encrypt `(to || value_le || calldata)` with the
 *      committee pubkey.
 *   2. Assemble the EncryptedTx wire frame with `signature = []`.
 *   3. Compute `EncryptedTx::hash` (same formula the node uses).
 *   4. FALCON-sign the hash with the sender's secret key.
 *   5. Serialize the full wire frame.
 *
 * `params_json` shape (all strings are `0x`-prefixed hex unless
 * noted):
 * ```ignore
 * {
 *   "thresholdPk": "0x...",          // wire bytes from pyde_getThresholdPublicKey
 *   "sender": "0x...",               // 32-byte address
 *   "nonce": 0,                      // u64
 *   "gasLimit": 100000,              // u64
 *   "accessList": [                  // optional
 *     { "address": "0x...",
 *       "reads":  ["0x..."],
 *       "writes": ["0x..."] }
 *   ],
 *   "deadline": null,                // optional u64
 *   "chainId": 31337,                // u64
 *   "to": "0x...",                   // 32-byte address
 *   "value": "1000",                 // u128 decimal string
 *   "calldata": "0x..."              // hex bytes
 * }
 * ```
 *
 * Returns hex of the wire-encoded EncryptedTx, ready to submit via
 * `pyde_sendRawEncryptedTransaction`.
 */
export function buildRawEncryptedTx(params_json: string, sk_hex: string): string;

/**
 * Compute FNV-1a function selector (same as Otigen codegen).
 */
export function computeSelector(name: string): number;

/**
 * Derive address from a FALCON-512 public key (hex).
 * address = Poseidon2(public_key_bytes)
 */
export function deriveAddress(pk_hex: string): string;

/**
 * Wire-encode a `TransactionType::RegisterPubkey` tx without signing.
 * The address-derivation check (`from ==
 * Poseidon2(data)`) IS the proof of pubkey ownership for this
 * tx type, so a FALCON sig is neither needed nor accepted.
 * Refuses to encode any other tx type — accidental misuse on a
 * signed-tx path would be a hard-to-debug protocol violation.
 */
export function encodeRegisterPubkeyTx(tx_json: string): string;

/**
 * Generate a FALCON-512 keypair.
 * Returns JSON: { "publicKey": "0x...", "secretKey": "0x...", "address": "0x..." }
 */
export function generateKeypair(): string;

/**
 * Compute transaction hash from JSON fields.
 * Accepts: { from, to, value, data, gasLimit, nonce, chainId, txType }
 * Returns hash hex.
 */
export function hashTransaction(tx_json: string): string;

/**
 * Compute Poseidon2 hash of arbitrary bytes (hex).
 */
export function poseidon2Hash(data_hex: string): string;

/**
 * Sign a message with a FALCON-512 secret key. Returns signature hex.
 */
export function signMessage(sk_hex: string, message_hex: string): string;

/**
 * Sign a transaction. Returns the signed tx bytes as hex (wire format).
 * Accepts JSON tx fields + secretKey hex.
 */
export function signTransaction(tx_json: string, sk_hex: string): string;

/**
 * Threshold-encrypt a payload against the committee's public key.
 * `pk_hex` is the hex-encoded wire bytes from
 * `pyde_getThresholdPublicKey`. `payload_hex` is the bytes to
 * encrypt — typically `to (32) || value_le (16) || calldata`.
 *
 * Returns hex of `ThresholdCiphertext::to_wire_bytes()` ready to
 * embed in an `EncryptedTx`.
 */
export function thresholdEncrypt(pk_hex: string, payload_hex: string): string;

/**
 * Verify a FALCON-512 signature.
 */
export function verifySignature(pk_hex: string, message_hex: string, sig_hex: string): boolean;
