/**
 * Commit-reveal ("private transaction") primitives — Pyde's front-running
 * protection.
 *
 * A sender publishes a salted Blake3 commitment whose ordering wave reserves
 * its slot, then opens it with a `Reveal` once the order is finalized. The
 * property delivered — a tx's ordering position is fixed before its contents
 * are visible — needs no secret key anywhere: there is no committee, no shared
 * secret, nothing to reconstruct or trust. A reveal opens exactly one
 * transaction and unlocks nothing else.
 *
 * Honest guarantee (frame it this way in docs): content-targeted
 * front-running is prevented; this is NOT a total ordering lock against
 * unrelated txs that arrive in the reveal→execute window.
 *
 * Canonical definitions mirrored byte-for-byte from the engine:
 *   - engine/crates/types/src/tx.rs          — commitment_hash, COMMITMENT_DOMAIN_TAG
 *   - engine/crates/tx/src/commit_reveal.rs  — CommitPayload, RevealPayload, required_bond
 */

import { blake3 } from "@noble/hashes/blake3";
import { utf8ToBytes } from "@noble/hashes/utils";

// ============================================================================
// Wire-frozen constants (never change post-mainnet)
// ============================================================================

/** Reveal window in waves (~60 s at 500 ms waves). A commit not revealed
 *  within this many waves after its commit wave forfeits its bond. An honest
 *  wallet auto-reveals as soon as the commit finalizes (~1-2 s end to end);
 *  the window is a liveness/censorship cushion, not the expected latency. */
export const COMMIT_REVEAL_WINDOW_WAVES = 120n;

/** Flat bond floor in quanta: 1 PYDE (1 PYDE = 10⁹ quanta). Prices
 *  commit-spam — reserving a slot and never revealing forfeits at least this. */
export const MIN_COMMIT_BOND = 1_000_000_000n;

/** Bond scaling in basis points of the declared value ceiling (100 bps = 1%). */
export const COMMIT_BOND_BPS = 100n;

/** Domain-separation tag for the commitment hash. Wire-frozen — the engine
 *  hashes these exact UTF-8 bytes (`b"pyde-commit-reveal-v1"`). */
export const COMMITMENT_DOMAIN_TAG = "pyde-commit-reveal-v1";
const DOMAIN_TAG_BYTES = utf8ToBytes(COMMITMENT_DOMAIN_TAG);

// ============================================================================
// Typed payloads (see engine `commit_reveal.rs`)
// ============================================================================

/** `tx.data` of a Commit (0x11) = `borsh(CommitPayload)`. `tx.value` = the bond. */
export interface CommitPayload {
  /** 32-byte commitment — `commitmentHash(innerTxBytes, nonce)`. */
  commitment: Uint8Array;
  /** Sender-declared upper bound on the hidden tx's `value` (u128 quanta).
   *  The reveal is rejected if `inner_tx.value > valueCeiling`; the bond
   *  scales with it, so over-declaring (to hide the true amount) costs more. */
  valueCeiling: bigint;
}

/** `tx.data` of a Reveal (0x12) = `borsh(RevealPayload)`. */
export interface RevealPayload {
  /** Which pending commitment this opens (must equal the committed hash). */
  commitment: Uint8Array;
  /** The 32-byte salt drawn at commit time. */
  nonce: Uint8Array;
  /** `borsh(Tx)` of the hidden, fully-signed transaction — the SAME bytes
   *  hashed into `commitment`. */
  innerTx: Uint8Array;
}

// ============================================================================
// Primitives
// ============================================================================

/** Minimum bond a `Commit` must post for a declared `valueCeiling`:
 *  `max(MIN_COMMIT_BOND, valueCeiling × COMMIT_BOND_BPS / 10_000)`.
 *  Mirrors the engine's `required_bond`. The bond is debited at commit,
 *  refunded when the matching reveal is accepted, and burned if the
 *  commitment is never revealed inside the window. */
export function requiredBond(valueCeiling: bigint): bigint {
  if (valueCeiling < 0n) throw new Error(`valueCeiling cannot be negative: ${valueCeiling}`);
  const scaled = (valueCeiling * COMMIT_BOND_BPS) / 10_000n;
  return scaled > MIN_COMMIT_BOND ? scaled : MIN_COMMIT_BOND;
}

/**
 * `commitment = Blake3(COMMITMENT_DOMAIN_TAG || innerTxBytes || nonce)`.
 *
 * `innerTxBytes` is `borsh(inner_tx)` of the fully-signed hidden tx; `nonce`
 * is a fresh 32-byte CSPRNG salt, never reused. Mirrors the engine's
 * `commitment_hash`.
 *
 * ⚠️ Reuse the SAME `innerTxBytes` verbatim in the RevealPayload. Re-encoding
 * — and especially re-signing, since FALCON-512 is non-deterministic — yields
 * different bytes, so the engine's recomputed commitment will not match and
 * the reveal is rejected. Sign the inner tx once; reuse those exact bytes.
 */
export function commitmentHash(innerTxBytes: Uint8Array, nonce: Uint8Array): Uint8Array {
  if (nonce.length !== 32) throw new Error(`commit-reveal nonce must be 32 bytes, got ${nonce.length}`);
  const buf = new Uint8Array(DOMAIN_TAG_BYTES.length + innerTxBytes.length + nonce.length);
  buf.set(DOMAIN_TAG_BYTES, 0);
  buf.set(innerTxBytes, DOMAIN_TAG_BYTES.length);
  buf.set(nonce, DOMAIN_TAG_BYTES.length + innerTxBytes.length);
  return blake3(buf);
}

/** `borsh(CommitPayload)` = `commitment[32] || value_ceiling (u128 LE, 16 bytes)`.
 *  Fixed-size `[u8; 32]` has no length prefix. */
export function encodeCommitPayload(p: CommitPayload): Uint8Array {
  requireLen(p.commitment, 32, "commitment");
  const out = new Uint8Array(32 + 16);
  out.set(p.commitment, 0);
  out.set(u128LE(p.valueCeiling), 32);
  return out;
}

/** `borsh(RevealPayload)` = `commitment[32] || nonce[32] || inner_tx`, where
 *  `inner_tx` is a borsh `Vec<u8>` (4-byte LE length prefix + bytes). */
export function encodeRevealPayload(p: RevealPayload): Uint8Array {
  requireLen(p.commitment, 32, "commitment");
  requireLen(p.nonce, 32, "nonce");
  const out = new Uint8Array(32 + 32 + 4 + p.innerTx.length);
  out.set(p.commitment, 0);
  out.set(p.nonce, 32);
  out.set(u32LE(p.innerTx.length), 64);
  out.set(p.innerTx, 68);
  return out;
}

// ============================================================================
// Local helpers
// ============================================================================

function requireLen(b: Uint8Array, n: number, name: string): void {
  if (b.length !== n) throw new Error(`${name} must be ${n} bytes, got ${b.length}`);
}

/** borsh `u128` → 16 little-endian bytes. Full u128 range (values above
 *  2^53 are fine — these are `bigint`, no float coercion). */
function u128LE(v: bigint): Uint8Array {
  if (v < 0n) throw new Error(`u128 cannot be negative: ${v}`);
  if (v >= 1n << 128n) throw new Error(`value exceeds u128 range: ${v}`);
  const out = new Uint8Array(16);
  let x = v;
  for (let i = 0; i < 16; i++) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

/** borsh `Vec<u8>` length prefix → u32 little-endian. */
function u32LE(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new Error(`length out of u32 range: ${n}`);
  const out = new Uint8Array(4);
  out[0] = n & 0xff;
  out[1] = (n >>> 8) & 0xff;
  out[2] = (n >>> 16) & 0xff;
  out[3] = (n >>> 24) & 0xff;
  return out;
}
