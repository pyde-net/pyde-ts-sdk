/**
 * Commit-reveal ("private tx") primitives + wire parity — unit tests (no devnet).
 *
 * Parity is proven against the canonical cross-repo fixture
 * (otigen_commit_reveal_vectors_v1.json), which pins the same FALCON key and
 * schema as cross_repo_tx_vectors_v1.json. For each vector we reproduce the
 * CommitPayload / RevealPayload borsh, recompute the Blake3 commitment from
 * the vector's own (inner_tx, nonce), and compute the canonical outer tx hash
 * via the wasm — all must match the fixture byte-for-byte. Matching the
 * vectors == wire-correct.
 *
 * Excluded from npm publish — lives outside the `files` array.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { blake3 } from "@noble/hashes/blake3";
import {
  requiredBond,
  commitmentHash,
  encodeCommitPayload,
  encodeRevealPayload,
  MIN_COMMIT_BOND,
  COMMIT_BOND_BPS,
  COMMIT_REVEAL_WINDOW_WAVES,
  COMMITMENT_DOMAIN_TAG,
} from "./private-tx";
import { hashTransaction } from "./crypto";
import { TxType } from "./types";
import type { TxFields } from "./types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function hexToBytes(h: string): Uint8Array {
  const s = h.startsWith("0x") ? h.slice(2) : h;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function bytesToHex(b: Uint8Array): string {
  let out = "";
  for (const v of b) out += v.toString(16).padStart(2, "0");
  return out;
}
function u32le(b: Uint8Array, off: number): number {
  return (b[off] ?? 0) | ((b[off + 1] ?? 0) << 8) | ((b[off + 2] ?? 0) << 16) | ((b[off + 3] ?? 0) << 24);
}
function concatBytes(...arrs: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arrs) {
    out.set(a, o);
    o += a.length;
  }
  return out;
}

interface Vec {
  input: {
    name: string;
    from_hex: string;
    to_hex: string;
    value_dec: string;
    data_hex: string;
    gas_limit: number;
    nonce: number;
    chain_id: number;
    tx_type: string;
  };
  expected_tx_hash_hex: string;
}

// ---------------------------------------------------------------------------
// Pure primitives (always run)
// ---------------------------------------------------------------------------
describe("commit-reveal primitives", () => {
  it("constants match the engine (wire-frozen)", () => {
    expect(MIN_COMMIT_BOND).toBe(1_000_000_000n);
    expect(COMMIT_BOND_BPS).toBe(100n);
    expect(COMMIT_REVEAL_WINDOW_WAVES).toBe(120n);
    expect(COMMITMENT_DOMAIN_TAG).toBe("pyde-commit-reveal-v1");
  });

  it("requiredBond floors then scales (mirrors engine required_bond)", () => {
    expect(requiredBond(0n)).toBe(MIN_COMMIT_BOND);
    expect(requiredBond(1_000n)).toBe(MIN_COMMIT_BOND);
    const crossover = (MIN_COMMIT_BOND * 10_000n) / COMMIT_BOND_BPS; // ceiling × 1% == floor
    expect(requiredBond(crossover)).toBe(MIN_COMMIT_BOND);
    expect(requiredBond(crossover * 10n)).toBe(MIN_COMMIT_BOND * 10n);
    // The commit vector's ceiling (5e11) → 1% = 5e9 (its posted bond).
    expect(requiredBond(500_000_000_000n)).toBe(5_000_000_000n);
  });

  it("encodeCommitPayload = commitment[32] || value_ceiling (u128 LE, 16B)", () => {
    const commitment = new Uint8Array(32).fill(0xab);
    const enc = encodeCommitPayload({ commitment, valueCeiling: 1n });
    expect(enc.length).toBe(48);
    expect(bytesToHex(enc.subarray(0, 32))).toBe("ab".repeat(32));
    expect(bytesToHex(enc.subarray(32))).toBe("01" + "00".repeat(15));
  });

  it("encodeRevealPayload = commitment[32] || nonce[32] || u32 LE len || inner", () => {
    const commitment = new Uint8Array(32).fill(1);
    const nonce = new Uint8Array(32).fill(2);
    const enc = encodeRevealPayload({ commitment, nonce, innerTx: new Uint8Array([0xde, 0xad]) });
    expect(enc.length).toBe(32 + 32 + 4 + 2);
    expect(bytesToHex(enc.subarray(64, 68))).toBe("02000000");
    expect(bytesToHex(enc.subarray(68))).toBe("dead");
  });

  it("commitmentHash = Blake3(domain_tag || inner || nonce)", () => {
    const inner = new Uint8Array([1, 2, 3]);
    const nonce = new Uint8Array(32).fill(0x5a);
    const expected = blake3(concatBytes(new TextEncoder().encode("pyde-commit-reveal-v1"), inner, nonce));
    expect(bytesToHex(commitmentHash(inner, nonce))).toBe(bytesToHex(expected));
  });

  it("commitmentHash rejects a non-32-byte nonce; encoders reject bad lengths", () => {
    expect(() => commitmentHash(new Uint8Array(1), new Uint8Array(31))).toThrow();
    expect(() => encodeCommitPayload({ commitment: new Uint8Array(31), valueCeiling: 0n })).toThrow();
    expect(() =>
      encodeRevealPayload({ commitment: new Uint8Array(32), nonce: new Uint8Array(31), innerTx: new Uint8Array(0) }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Cross-repo wire parity
// ---------------------------------------------------------------------------
const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(
  here,
  "..",
  "..",
  "otigen",
  "crates",
  "otigen-tx-codec",
  "fixtures",
  "otigen_commit_reveal_vectors_v1.json",
);
const haveFixture = existsSync(FIXTURE);
if (!haveFixture) {
  console.warn(
    `[private-tx.test] canonical fixture not found at ${FIXTURE} — skipping wire parity ` +
      "(run inside the pyde-net monorepo to exercise it).",
  );
}
const dfix = haveFixture ? describe : describe.skip;

dfix("commit-reveal wire parity vs otigen_commit_reveal_vectors_v1.json", () => {
  const fixture = haveFixture
    ? (JSON.parse(readFileSync(FIXTURE, "utf-8")) as { vectors: Vec[] })
    : { vectors: [] as Vec[] };
  const byName = (n: string): Vec => {
    const v = fixture.vectors.find((x) => x.input.name === n);
    if (!v) throw new Error(`fixture missing vector: ${n}`);
    return v;
  };

  it("has the commit + reveal vectors", () => {
    expect(byName("commit_reserve").input.tx_type).toBe("commit");
    expect(byName("reveal_open").input.tx_type).toBe("reveal");
  });

  it("reveal payload round-trips + recomputes its embedded commitment", () => {
    const rv = byName("reveal_open");
    const data = hexToBytes(rv.input.data_hex);
    const commitment = data.subarray(0, 32);
    const nonce = data.subarray(32, 64);
    const innerLen = u32le(data, 64);
    const inner = data.subarray(68, 68 + innerLen);
    expect(68 + innerLen).toBe(data.length);

    // Recompute the commitment from this vector's own (inner, nonce).
    const recomputed = commitmentHash(new Uint8Array(inner), new Uint8Array(nonce));
    expect(bytesToHex(recomputed)).toBe(bytesToHex(commitment));

    // Re-encode the whole payload → must reproduce the fixture bytes.
    const reenc = encodeRevealPayload({
      commitment: new Uint8Array(commitment),
      nonce: new Uint8Array(nonce),
      innerTx: new Uint8Array(inner),
    });
    expect(bytesToHex(reenc)).toBe(rv.input.data_hex.replace(/^0x/, ""));
  });

  it("commit payload reproduces the fixture bytes + bond", () => {
    const cv = byName("commit_reserve");
    const data = hexToBytes(cv.input.data_hex);
    const commitment = data.subarray(0, 32);
    let ceiling = 0n;
    for (let i = 0; i < 16; i++) ceiling |= BigInt(data[32 + i] ?? 0) << BigInt(i * 8);

    const reenc = encodeCommitPayload({ commitment: new Uint8Array(commitment), valueCeiling: ceiling });
    expect(bytesToHex(reenc)).toBe(cv.input.data_hex.replace(/^0x/, ""));
    // The commit's value == required_bond(value_ceiling).
    expect(requiredBond(ceiling)).toBe(BigInt(cv.input.value_dec));
  });

  it("commit + reveal outer tx hashes match expected_tx_hash_hex", () => {
    for (const name of ["commit_reserve", "reveal_open"]) {
      const v = byName(name);
      const tx: TxFields = {
        from: "0x" + v.input.from_hex,
        to: "0x" + v.input.to_hex,
        value: v.input.value_dec,
        data: "0x" + v.input.data_hex,
        gasLimit: v.input.gas_limit,
        nonce: BigInt(v.input.nonce),
        chainId: v.input.chain_id,
        txType: name === "commit_reserve" ? TxType.Commit : TxType.Reveal,
      };
      expect(hashTransaction(tx).replace(/^0x/, "")).toBe(v.expected_tx_hash_hex);
    }
  });
});
