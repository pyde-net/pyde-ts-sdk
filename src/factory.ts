/**
 * Factory-pattern (PIP-0006) primitives — counterfactual child addresses
 * and child-provenance events.
 *
 * A factory contract instantiates children by reference via the engine's
 * `pyde::instantiate` host fn. The child's address is a pure function of
 * (parent, template, salt), so wallets and scripts can compute it BEFORE
 * the instantiating tx lands — same counterfactual property as CREATE2:
 *
 * ```
 * child_address = Poseidon2("pyde-child:" || parent[32] || template[32] || salt[32])
 * ```
 *
 * The preimage is 107 bytes fixed-width — an 11-byte ASCII domain tag then
 * three raw 32-byte values, no length prefixes, no separators. Poseidon2
 * routes through the vendored `pyde-crypto-wasm` (the engine's own
 * implementation) — this module never hand-rolls the hash.
 *
 * Canonical definitions mirrored byte-for-byte from the engine:
 *   - engine crates/account/src/address.rs — child derivation + pinned KAT
 *   - pyde-host vectors/child_address.json — golden conformance vectors
 *     (copied verbatim into `src/__fixtures__/` and replayed in tests)
 */

import { poseidon2Hash } from "./crypto";
import { getBytes } from "./hex";
import { InvalidArgumentError } from "./errors";
import type { Log } from "./types";

// ============================================================================
// Wire-frozen constants (never change post-mainnet)
// ============================================================================

/** Domain-separation tag for child-address derivation. Wire-frozen — the
 *  engine hashes these exact 11 UTF-8 bytes (`b"pyde-child:"`). */
export const CHILD_ADDRESS_DOMAIN_TAG = "pyde-child:";
const DOMAIN_TAG_BYTES = new TextEncoder().encode(CHILD_ADDRESS_DOMAIN_TAG);

/** topic[0] of the engine's child-provenance event —
 *  `Blake3("pyde.Instantiated")`. Wire-frozen. Unlike ABI events (FNV-1a
 *  selector, zero-padded), system events pin a full 32-byte Blake3 hash. */
export const INSTANTIATED_TOPIC0 =
  "0x622a0a9e1e2b487288904a22b18174d6e45b3749c756a94209ef9a9cf768847a";

// ============================================================================
// Child-address derivation
// ============================================================================

/**
 * Assemble the 107-byte child-address preimage:
 * `"pyde-child:" || parent[32] || template[32] || salt[32]`.
 *
 * Inputs are 32-byte hex strings (`0x`-prefixed or bare); returns the
 * preimage as `0x` + 214 hex chars. Exposed so callers can audit exactly
 * what gets hashed; most callers want {@link childAddress} directly.
 */
export function childPreimage(parent: string, template: string, salt: string): string {
  const p = bytes32(parent, "parent");
  const t = bytes32(template, "template");
  const s = bytes32(salt, "salt");
  const preimage = new Uint8Array(DOMAIN_TAG_BYTES.length + 96);
  preimage.set(DOMAIN_TAG_BYTES, 0);
  preimage.set(p, DOMAIN_TAG_BYTES.length);
  preimage.set(t, DOMAIN_TAG_BYTES.length + 32);
  preimage.set(s, DOMAIN_TAG_BYTES.length + 64);
  return "0x" + toHex(preimage);
}

/**
 * Counterfactual child address:
 * `Poseidon2("pyde-child:" || parent[32] || template[32] || salt[32])`.
 *
 * Pure — no chain round-trip. `parent` is the factory contract that will
 * call `pyde::instantiate`, `template` is the code being instantiated by
 * reference, `salt` is the 32-byte child-identity salt (see the `saltOf*`
 * helpers). Returns the 32-byte address as `0x` + 64 hex.
 *
 * Mirrors the engine's derivation exactly; the tests replay the pyde-host
 * golden vectors byte-for-byte.
 */
export function childAddress(parent: string, template: string, salt: string): string {
  return poseidon2Hash(childPreimage(parent, template, salt));
}

// ============================================================================
// Salt construction
// ============================================================================

/**
 * General-form identity salt: `Poseidon2(borshBytes)`.
 *
 * `borshBytes` is the borsh encoding of the value that IDENTIFIES the
 * child (a counter, a name, a token pair, a tuple — whatever makes the
 * child unique under its factory). Hashing the borsh bytes keeps every
 * salt exactly 32 bytes regardless of the identity type. Accepts the
 * bytes as a hex string (`0x`-prefixed or bare) or `Uint8Array`; empty
 * input is valid (the borsh encoding of the unit value `()`).
 *
 * The typed helpers below cover the common identities; use this form for
 * anything else (encode with the same borsh rules the contract uses).
 */
export function saltOfBytes(borshBytes: string | Uint8Array): string {
  let bytes: Uint8Array;
  try {
    bytes = getBytes(borshBytes);
  } catch (e) {
    throw new InvalidArgumentError(
      `saltOfBytes: ${e instanceof Error ? e.message : String(e)}`,
      "borshBytes",
      borshBytes,
    );
  }
  return poseidon2Hash("0x" + toHex(bytes));
}

/**
 * Counter-identity salt: `Poseidon2(borsh(counter as u64))` — 8 bytes
 * little-endian (one u64, NOT two u32s), then Poseidon2.
 *
 * The idiomatic salt for "the N-th child of this factory". Range-checked
 * to u64; `number` inputs must additionally be safe integers (pass a
 * `bigint` above 2^53).
 */
export function saltOfCounter(counter: bigint | number): string {
  if (typeof counter === "number" && !Number.isSafeInteger(counter)) {
    throw new InvalidArgumentError(
      `saltOfCounter: counter must be a safe integer number or bigint, got ${counter}`,
      "counter",
      counter,
    );
  }
  const v = BigInt(counter);
  if (v < 0n || v >= 1n << 64n) {
    throw new InvalidArgumentError(
      `saltOfCounter: counter out of u64 range: ${v}`,
      "counter",
      counter,
    );
  }
  const le = new Uint8Array(8);
  let x = v;
  for (let i = 0; i < 8; i++) {
    le[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return saltOfBytes(le);
}

/**
 * Order-independent two-address salt: sort the two 32-byte values
 * ascending BYTEWISE (unsigned lexicographic — `0x7f…` sorts before
 * `0x80…`), concatenate the raw 64 bytes (no framing), Poseidon2.
 *
 * The idiomatic salt for pair markets (AMM pools, escrows between two
 * parties): `saltOfUnorderedPair(a, b) === saltOfUnorderedPair(b, a)`,
 * so both argument orders land on the SAME child address. The sort is
 * on raw bytes, not on hex strings or signed values.
 */
export function saltOfUnorderedPair(a: string, b: string): string {
  const ab = bytes32(a, "a");
  const bb = bytes32(b, "b");
  const [lo, hi] = compareBytes(ab, bb) <= 0 ? [ab, bb] : [bb, ab];
  const joined = new Uint8Array(64);
  joined.set(lo, 0);
  joined.set(hi, 32);
  return saltOfBytes(joined);
}

// ============================================================================
// Instantiated event decoding
// ============================================================================

/** Decoded `pyde.Instantiated` child-provenance event. Emitted by the
 *  engine (not contract code) on every successful `pyde::instantiate`. */
export interface InstantiatedEvent {
  /** The freshly instantiated child contract (topics[1]). */
  child: string;
  /** Template the child was instantiated from, by reference (topics[2]). */
  template: string;
  /** Parent factory (data bytes 0–32). Duplicates the emitting contract
   *  (`log.contract`) so the event decodes standalone. */
  parent: string;
  /** 32-byte salt the child address was derived with (data bytes 32–64). */
  salt: string;
  /** Quanta endowed to the child at instantiation (data bytes 64–80,
   *  u128 little-endian). */
  value: bigint;
  /** The raw log this event was decoded from. */
  log: Log;
}

/**
 * Decode a raw {@link Log} into an {@link InstantiatedEvent}.
 *
 * Wire layout (topic0 = {@link INSTANTIATED_TOPIC0}):
 *   - emitter (`log.contract`) — the parent factory
 *   - `topics[1]` — child_address (32 bytes)
 *   - `topics[2]` — template_address (32 bytes)
 *   - `data` — `parent[32] || salt[32] || value (u128 LE, 16 bytes)`,
 *     exactly 80 bytes
 *
 * Throws {@link InvalidArgumentError} if the log is not an `Instantiated`
 * event (wrong topic0), is missing topics, or carries malformed data.
 * Filter first (`log.topics[0] === INSTANTIATED_TOPIC0`) when scanning
 * mixed logs.
 */
export function decodeInstantiated(log: Log): InstantiatedEvent {
  const topic0 = log.topics?.[0];
  if (topic0 === undefined || normalizeHex(topic0) !== INSTANTIATED_TOPIC0) {
    throw new InvalidArgumentError(
      `decodeInstantiated: topic0 is not the Instantiated event hash (expected ${INSTANTIATED_TOPIC0})`,
      "log",
      topic0,
    );
  }
  if (log.topics.length < 3) {
    throw new InvalidArgumentError(
      `decodeInstantiated: expected 3 topics (topic0, child, template), got ${log.topics.length}`,
      "log",
      log.topics,
    );
  }
  const child = "0x" + toHex(bytes32(log.topics[1]!, "topics[1] (child)"));
  const template = "0x" + toHex(bytes32(log.topics[2]!, "topics[2] (template)"));

  let data: Uint8Array;
  try {
    data = getBytes(log.data);
  } catch (e) {
    throw new InvalidArgumentError(
      `decodeInstantiated: ${e instanceof Error ? e.message : String(e)}`,
      "log",
      log.data,
    );
  }
  if (data.length !== 80) {
    throw new InvalidArgumentError(
      `decodeInstantiated: data must be exactly 80 bytes (parent[32] || salt[32] || value u128 LE[16]), got ${data.length}`,
      "log",
      log.data,
    );
  }
  const parent = "0x" + toHex(data.subarray(0, 32));
  const salt = "0x" + toHex(data.subarray(32, 64));
  let value = 0n;
  for (let i = 15; i >= 0; i--) {
    value = (value << 8n) | BigInt(data[64 + i]!);
  }
  return { child, template, parent, salt, value, log };
}

// ============================================================================
// Local helpers
// ============================================================================

/** Coerce a hex string (`0x` or bare) / `Uint8Array` to exactly 32 bytes. */
function bytes32(value: string | Uint8Array, name: string): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = getBytes(value);
  } catch (e) {
    throw new InvalidArgumentError(
      `${name}: ${e instanceof Error ? e.message : String(e)}`,
      name,
      value,
    );
  }
  if (bytes.length !== 32) {
    throw new InvalidArgumentError(`${name} must be 32 bytes, got ${bytes.length}`, name, value);
  }
  return bytes;
}

/** Unsigned bytewise lexicographic compare (equal-length inputs). */
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < a.length; i++) {
    const d = a[i]! - b[i]!;
    if (d !== 0) return d;
  }
  return 0;
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i]!.toString(16).padStart(2, "0");
  }
  return out;
}

/** Lowercase + ensure `0x` prefix for comparison (wire topics are
 *  `0x`-prefixed; tolerate bare hex defensively). */
function normalizeHex(hex: string): string {
  const bare = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  return "0x" + bare.toLowerCase();
}
