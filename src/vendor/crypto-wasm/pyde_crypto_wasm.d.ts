/* tslint:disable */
/* eslint-disable */

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
 * drop a retained keypair. The `FalconSecretKey`'s
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
 * the in-memory copy (the typical `pyde-ts-sdk` / `otigen`
 * keystore flow), this hex-string return is unavoidable, but
 * callers MUST encrypt the value at the earliest opportunity and
 * must NEVER let it survive across renders or get serialized.
 */
export function generateKeypair(): string;

/**
 * opaque-handle variant of `generateKeypair`. Generates
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
 * sign a message using a key retained by handle. The
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
 * sign a transaction (same JSON shape as
 * `signTransaction`) using a key retained by handle. Returns the
 * signed wire bytes as `0x`-prefixed hex.
 */
export function signTransactionWithHandle(tx_json: string, handle: number): string;

/**
 * Verify a FALCON-512 signature.
 */
export function verifySignature(pk_hex: string, message_hex: string, sig_hex: string): boolean;
