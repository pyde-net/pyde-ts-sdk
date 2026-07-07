/* tslint:disable */
/* eslint-disable */

/**
 * One-shot client-side EncryptedTx builder. Does everything a
 * wallet needs for the MEV-protected flow in a single call:
 *   1. Threshold-encrypt `(to || value_le || calldata)` with the
 *      committee pubkey.
 *   2. Assemble the EncryptedTx wire frame with `signature = []`.
 *   3. Compute `EncryptedTx::hash` (same formula the node uses).
 *   4. FALCON-sign the hash with the sender's secret key.
 *   5. Serialize the full wire frame.
 * `params_json` shape (all strings are `0x`-prefixed hex unless
 * noted):
 * ```ignore
 * {
 *   "thresholdPk": "0x...",          // wire bytes from pyde_getThresholdPublicKey
 *   "sender": "0x...",               // 32-byte address
 *   "nonce": 0,                      // u64
 *   "gasLimit": 100000,              // u64
 *   "accessList": [                  // optional
 *     { "address":     "0x...",
 *       "storageKeys": ["0x..."],
 *       "accessType":  0 }           // 0 = Read, 1 = ReadWrite
 *   ],
 *   "deadline": null,                // optional u64
 *   "chainId": 31337,                // u64
 *   "to": "0x...",                   // 32-byte address
 *   "value": "1000",                 // u128 decimal string
 *   "calldata": "0x..."              // hex bytes
 * }
 * ```
 * Returns hex of the wire-encoded EncryptedTx, ready to submit via
 * `pyde_sendRawEncryptedTransaction`.
 */
export function buildRawEncryptedTx(params_json: string, sk_hex: string): string;

/**
 * Handle-based variant of `buildRawEncryptedTx`. Same `params_json`
 * shape + same wire-format output, but signs using a key retained in
 * the handle table — the FALCON secret key never leaves this crate's
 * WASM heap. Use with the keypair from `generateKeypairHandle`.
 *
 * Mirrors the signing handle pattern of `signMessageWithHandle` and
 * `signTransactionWithHandle`.
 */
export function buildRawEncryptedTxWithHandle(params_json: string, handle: number): string;

/**
 * Combine a threshold of decryption shares to recover the plaintext.
 * `shares_json` = JSON array of hex `DecryptionShare`s; `ciphertext_hex` = the
 * same `ThresholdCiphertext` wire bytes; `committee_pks_json` = JSON array of
 * hex FALCON public keys, positioned so `committee_pks[i]` is the member with
 * key-share index `i + 1` (shares are FALCON-verified against this table).
 * Returns hex of the recovered plaintext.
 */
export function combineShares(shares_json: string, threshold: number, ciphertext_hex: string, committee_pks_json: string): string;

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
 * : drop a retained keypair. The `FalconSecretKey`'s
 * `ZeroizeOnDrop` impl () overwrites the secret bytes in
 * place when removed from the table. Returns `true` if a key was
 * actually removed, `false` if the handle was already dropped.
 */
export function dropKeypair(handle: number): boolean;

/**
 * Wire-encode a `TransactionType::RegisterPubkey` () tx
 * without signing. The address-derivation check (`from ==
 * Poseidon2(data)`) IS the proof of pubkey ownership for this
 * tx type, so a FALCON sig is neither needed nor accepted.
 * Refuses to encode any other tx type — accidental misuse on a
 * signed-tx path would be a hard-to-debug protocol violation.
 */
export function encodeRegisterPubkeyTx(tx_json: string): string;

/**
 * One committee member's partial decryption of a ciphertext. `key_share_hex`
 * is one entry from `thresholdKeygen`; `ciphertext_hex` is the
 * `ThresholdCiphertext` wire bytes (exactly what `thresholdEncrypt` returns);
 * `falcon_sk_hex` is THAT member's FALCON secret key (each share is signed).
 * Returns hex of the `DecryptionShare` wire bytes.
 */
export function generateDecryptionShare(key_share_hex: string, ciphertext_hex: string, falcon_sk_hex: string): string;

/**
 * Generate a FALCON-512 keypair.
 * Returns JSON: { "publicKey": "0x...", "secretKey": "0x...", "address": "0x..." }
 * **security warning**: this function returns the
 * secret key as a hex string into the JS heap. Once there, it is
 * reachable from:
 *   - browser dev-tools console (`Object.values(walletState)`)
 *   - browser extensions with content-script access to the page
 *   - process crash dumps (the string survives until JS GC)
 *   - accidental logging (`JSON.stringify(walletState)`)
 * For wallet UIs that need to hold the key in-process, prefer
 * `generateKeypairHandle` + `signMessageWithHandle` /
 * `signTransactionWithHandle` / `dropKeypair`. Those keep the SK
 * inside this crate's WASM heap and return only an opaque `u32`
 * handle to JS — the SK bytes never enter the JS heap at all. For
 * wallets that need to encrypt the SK to disk before discarding
 * the in-memory copy (the typical `pyde-ts-sdk` / `wright`
 * keystore flow), this hex-string return is unavoidable, but
 * callers MUST encrypt the value at the earliest opportunity and
 * must NEVER let it survive across renders or get serialized.
 */
export function generateKeypair(): string;

/**
 * : opaque-handle variant of `generateKeypair`. Generates
 * a FALCON-512 keypair, retains the secret key inside this crate's
 * WASM heap, and returns JSON with only the `publicKey`, `address`,
 * and an opaque `handle: u32` to JS. The SK bytes never enter the
 * JS heap. Use `signMessageWithHandle` / `signTransactionWithHandle`
 * to sign with the retained key, and `dropKeypair(handle)` when
 * done.
 * Returns JSON: `{ "publicKey": "0x...", "address": "0x...",
 *                  "handle": 1 }`.
 */
export function generateKeypairHandle(): string;

/**
 * Compute transaction hash from JSON fields.
 * Accepts: { from, to, value, data, gasLimit, nonce, chainId, txType }
 * Returns hash hex.
 */
export function hashTransaction(tx_json: string): string;

/**
 * Deterministically derive a FALCON-512 keypair from a 32-byte seed.
 * Returns the same JSON shape as `generateKeypair`. Same security
 * warning applies — the SK is in the JS heap; encrypt + discard ASAP.
 *
 * Same FALCON deterministic-keygen path the engine uses for the
 * devnet prefunded accounts (`devnet_secret(i) =
 * Blake3("pyde-devnet-v1/" || i.to_le_bytes())`), so SDK consumers
 * can re-derive the prefunded accounts locally for integration tests
 * without round-tripping through the `otigen` keystore.
 *
 * `seed_hex` is a `0x`-prefixed (or bare) 64-char hex string.
 */
export function keypairFromSeed(seed_hex: string): string;

/**
 * Compute Poseidon2 hash of arbitrary bytes (hex).
 */
export function poseidon2Hash(data_hex: string): string;

/**
 * Sign a message with a FALCON-512 secret key. Returns signature hex.
 */
export function signMessage(sk_hex: string, message_hex: string): string;

/**
 * : sign a message using a key retained by handle. The
 * SK bytes never leave this crate's WASM heap.
 * Returns the signature as a `0x`-prefixed hex string.
 */
export function signMessageWithHandle(handle: number, message_hex: string): string;

/**
 * Sign a transaction. Returns the signed tx bytes as hex (wire format).
 * Accepts JSON tx fields + secretKey hex.
 */
export function signTransaction(tx_json: string, sk_hex: string): string;

/**
 * : sign a transaction (same JSON shape as
 * `signTransaction`) using a key retained by handle. Returns the
 * signed wire bytes as `0x`-prefixed hex.
 */
export function signTransactionWithHandle(tx_json: string, handle: number): string;

/**
 * Threshold-encrypt a payload against the committee's public key.
 * `pk_hex` is the hex-encoded wire bytes from
 * `pyde_getThresholdPublicKey`. `payload_hex` is the bytes to
 * encrypt — typically `to (32) || value_le (16) || calldata`.
 * Returns hex of `ThresholdCiphertext::to_wire_bytes()` ready to
 * embed in an `EncryptedTx`.
 */
export function thresholdEncrypt(pk_hex: string, payload_hex: string): string;

/**
 * Generate a threshold committee of `n` members with reconstruction
 * `threshold`. Returns JSON `{ "thresholdPk": "0x..", "keyShares": ["0x..", ..] }`.
 * `thresholdPk` is what clients encrypt against; each key share is a member's
 * secret decryption material. The sandbox calls `thresholdKeygen(1, 1)`.
 */
export function thresholdKeygen(n: number, threshold: number): string;

/**
 * Verify a FALCON-512 signature.
 */
export function verifySignature(pk_hex: string, message_hex: string, sig_hex: string): boolean;
