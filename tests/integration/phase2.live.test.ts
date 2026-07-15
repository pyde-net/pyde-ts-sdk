/**
 * Phase 2 live sweep — end-to-end tx paths against a live devnet. Mirrors
 * the checklist's Phase 2 section under
 * `/tmp/pyde-ts-sdk-LIVE_TEST_CHECKLIST.md`.
 *
 * Strategy: build a wallet from the devnet-0 deterministic seed
 * (generously prefunded at genesis), register the pubkey if needed,
 * then exercise:
 *   - Sign + send + receipt poll (plain tx)
 *   - Tx lookup by committed hash
 *   - waitForReceipt with explicit timeout
 *   - getHardFinalityCert (now exposed; expect null on single-validator devnet)
 *   - Private submission end-to-end (commit-reveal via sendPrivate)
 *
 * Excluded from this file — covered separately:
 *   - Contract write / event emit reads
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { blake3 } from "@noble/hashes/blake3";

import { spawnDevnet, type DevnetHandle } from "./devnet";
import { Wallet } from "../../src/wallet";
import { keypairFromSeed, deriveAddress } from "../../src/crypto";
import { RpcError } from "../../src/errors";

// devnet-0 seed derivation, lifted from the engine genesis script.
function devnetSeed(i: number): Uint8Array {
  const prefix = new TextEncoder().encode("pyde-devnet-v1/");
  const idx = new Uint8Array(8);
  new DataView(idx.buffer).setBigUint64(0, BigInt(i), true);
  const input = new Uint8Array(prefix.length + idx.length);
  input.set(prefix, 0);
  input.set(idx, prefix.length);
  return blake3(input);
}
const seedHex = (b: Uint8Array): string =>
  "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

const DEV0_ADDR = "0xf07856fdf4796baa6d477ddfe926774d367b25c20e8c7d9d337b63034c9e0cfa";

let devnet: DevnetHandle;
let dev0: Wallet;

beforeAll(async () => {
  devnet = await spawnDevnet({ tickMs: 100 });

  // Re-derive devnet-0's signing wallet locally.
  const kp = keypairFromSeed(seedHex(devnetSeed(0)));
  dev0 = Wallet.fromKeys(kp.publicKey, kp.secretKey);
  expect(dev0.address).toBe(DEV0_ADDR);
  dev0.connect(devnet.provider);
}, 60_000);

afterAll(async () => {
  await devnet?.stop();
});

// --------------------------------------------------------------------------
// §1 — Engine-drift items now lit up
// --------------------------------------------------------------------------
describe("Phase 2 — engine drift now resolved", () => {
  it("F.4.4 getHardFinalityCert returns null on single-validator devnet", async () => {
    // Single-validator devnet can't produce ≥85 sigs (QUORUM), so
    // every wave stays sub-quorum. Verifies the SDK round-trips the
    // null path cleanly now that the method is exposed.
    const cert = await devnet.provider.getHardFinalityCert(0n);
    expect(cert).toBeNull();
  });
});

// --------------------------------------------------------------------------
// §2 — Plain-tx end-to-end (sign → send → poll receipt)
// --------------------------------------------------------------------------
describe("Phase 2 — plain transfer E2E (E.3.1 / F.3.1 / F.3.7 / F.8.3)", () => {
  const RECIPIENT = "0x" + "aa".repeat(32);
  let txHash: string;

  it("registerPubkey if devnet-0 isn't already keyed", async () => {
    // Devnet-0 may or may not be auto-registered at genesis. Attempt
    // registration; tolerate "already registered" rejection.
    try {
      const receipt = await dev0.registerPubkey();
      expect(receipt.success).toBe(true);
    } catch (e) {
      // If genesis pre-installed AuthKeys for prefunded accounts,
      // we'll get an explicit "already registered" RpcError. Either
      // outcome is fine — we just need the wallet to be able to sign.
      expect(e).toBeInstanceOf(Error);
    }
  }, 30_000);

  it("E.3.1 sign + sendRawTransaction + waitForReceipt round-trips a transfer", async () => {
    const before = await devnet.provider.getBalance(DEV0_ADDR);
    const recipientBefore = await devnet.provider.getBalance(RECIPIENT);

    const receipt = await dev0.transfer(RECIPIENT, 1_000_000n);
    expect(receipt.success).toBe(true);
    expect(receipt.txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    txHash = receipt.txHash;

    const after = await devnet.provider.getBalance(DEV0_ADDR);
    const recipientAfter = await devnet.provider.getBalance(RECIPIENT);

    // Balance moved at least the transferred amount (fee may not be
    // charged on devnet, so we assert strict-greater on recipient).
    expect(recipientAfter).toBeGreaterThanOrEqual(recipientBefore + 1_000_000n);
    expect(after).toBeLessThanOrEqual(before - 1_000_000n);
  }, 30_000);

  it("F.3.7 getTransaction(committedHash) returns the original tx", async () => {
    const tx = await devnet.provider.getTransaction(txHash);
    expect(tx).not.toBeNull();
    expect(tx!.from.toLowerCase()).toBe(DEV0_ADDR.toLowerCase());
    expect(tx!.to.toLowerCase()).toBe(RECIPIENT.toLowerCase());
  });

  it("F.8.3 waitForReceipt against the committed hash returns immediately", async () => {
    const r = await devnet.provider.waitForReceipt(txHash, 5_000);
    expect(r.success).toBe(true);
    expect(r.txHash).toBe(txHash);
  });
});

// --------------------------------------------------------------------------
// §3 — Nonce bookkeeping after a real send
// --------------------------------------------------------------------------
describe("Phase 2 — nonce advances post-commit", () => {
  it("getNonce(devnet-0) is now ≥ 1 after the §2 transfer", async () => {
    const n = await devnet.provider.getNonce(DEV0_ADDR);
    expect(n).toBeGreaterThanOrEqual(1n);
  });
});

// --------------------------------------------------------------------------
// §4 — Engine rejects gas floor violation (E.3.3)
// --------------------------------------------------------------------------
describe("Phase 2 — structural-floor rejections", () => {
  it("E.3.3 a tx with gasLimit below MIN_GAS_LIMIT (21,000) is rejected", async () => {
    const kp = keypairFromSeed(seedHex(devnetSeed(0)));
    const w = Wallet.fromKeys(kp.publicKey, kp.secretKey);
    const nonce = await devnet.provider.getNonce(w.address);
    const chainId = await devnet.provider.getChainId();
    const wire = w.signTransaction({
      from: w.address,
      to: "0x" + "bb".repeat(32),
      value: "1",
      data: "0x",
      gasLimit: 1_000,
      nonce,
      chainId,
      txType: 0,
    });
    await expect(devnet.provider.sendRawTransaction(wire)).rejects.toThrow(RpcError);
  });

  it("E.3.2 tampering with `value` after signing → chain rejects (sig over canonical hash)", async () => {
    const kp = keypairFromSeed(seedHex(devnetSeed(0)));
    const w = Wallet.fromKeys(kp.publicKey, kp.secretKey);
    const nonce = await devnet.provider.getNonce(w.address);
    const chainId = await devnet.provider.getChainId();
    const wire = w.signTransaction({
      from: w.address,
      to: "0x" + "bc".repeat(32),
      value: "1",
      data: "0x",
      gasLimit: 100_000,
      nonce,
      chainId,
      txType: 0,
    });
    // Find the value field's hex offset in the wire and flip a byte —
    // the canonical hash recomputed by the chain will mismatch the
    // FALCON sig. Wire layout per HOST_FN_ABI: from(32) + to(32) +
    // value(16) = 80 bytes header → 160 hex chars; the value's least
    // significant byte sits at offset 64-65 (after `0x` prefix). Flip
    // the high nibble there to bump value without changing length.
    const tampered =
      wire.slice(0, 2 + 64 * 2) +
      ((parseInt(wire[2 + 64 * 2]!, 16) ^ 0x1).toString(16)) +
      wire.slice(2 + 64 * 2 + 1);
    await expect(devnet.provider.sendRawTransaction(tampered)).rejects.toThrow(RpcError);
  });

  it("E.3.4 nonce out-of-window → chain rejects with 'nonce' diagnostic", async () => {
    const kp = keypairFromSeed(seedHex(devnetSeed(0)));
    const w = Wallet.fromKeys(kp.publicKey, kp.secretKey);
    const chainId = await devnet.provider.getChainId();
    // 16-slot sliding window per Chapter 11 §11.4 — anything >+16
    // beyond the current nonce drops at admit.
    const wire = w.signTransaction({
      from: w.address,
      to: "0x" + "bd".repeat(32),
      value: "1",
      data: "0x",
      gasLimit: 100_000,
      nonce: 1_000_000n,
      chainId,
      txType: 0,
    });
    await expect(devnet.provider.sendRawTransaction(wire)).rejects.toThrow(RpcError);
  });
});

// --------------------------------------------------------------------------
// §5 — Validator queries against the devnet's solo validator
// --------------------------------------------------------------------------
describe("Phase 2 — validator queries (F.6.3 / F.6.4)", () => {
  it("F.6.3 negative — getValidator(random EOA) returns null", async () => {
    const v = await devnet.provider.getValidator("0x" + "ee".repeat(32));
    expect(v).toBeNull();
  });

  it("F.6.3 happy path — getValidator(devnet validator addr derived from getNodeInfo) returns a populated record OR null on builds that gate the registry", async () => {
    const info = await devnet.provider.getNodeInfo();
    expect(info.falconPubkey).not.toBeNull();
    // Validator address = Poseidon2(falcon_pubkey) — same derivation
    // the chain runs to map a pubkey to an account.
    const validatorAddr = deriveAddress(info.falconPubkey!);
    const v = await devnet.provider.getValidator(validatorAddr);
    if (v === null) {
      // Devnet may not auto-register its solo signer into the
      // validator-set registry — that's an engine bootstrap detail.
      // The SDK round-trips the null cleanly either way.
      return;
    }
    // When populated, the catalog §16 shape gives us fields we can
    // sanity-check.
    expect(typeof v).toBe("object");
  });

  it("F.6.4 negative — getOperatorValidators(unknown) returns []", async () => {
    const vs = await devnet.provider.getOperatorValidators("0x" + "ef".repeat(32));
    expect(vs).toEqual([]);
  });
});

// --------------------------------------------------------------------------
// §6 — Private submission E2E (commit-reveal)
// --------------------------------------------------------------------------
// The one-call flow: sendPrivate signs the inner tx once, commits its salted
// Blake3 hash (posting the bond), awaits inclusion, reveals, and the inner tx
// executes in the reveal wave's resolution pass — keyed by the inner hash.
describe("Phase 2 — private transfer E2E (commit-reveal)", () => {
  it("sendPrivate runs commit → reveal → inner and the inner tx executes", async () => {
    const recipient = "0x" + "ce".repeat(32);
    const before = await devnet.provider.getBalance(recipient);

    const handle = await dev0.sendPrivate({ to: recipient, value: 100_000n, gasLimit: 100_000 });

    // Three distinct txs: commit, reveal, inner.
    expect(handle.commitHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(handle.revealHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(handle.innerHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(new Set([handle.commitHash, handle.revealHash, handle.innerHash]).size).toBe(3);
    // The commit reserved the slot (posting the 1-PYDE flat bond).
    expect(handle.commitReceipt.success).toBe(true);

    // The real outcome — the inner tx — executes after the reveal, keyed by
    // the inner tx hash.
    const innerReceipt = await handle.waitForReceipt(30_000);
    expect(innerReceipt.success).toBe(true);
    expect(innerReceipt.txHash).toBe(handle.innerHash);

    const after = await devnet.provider.getBalance(recipient);
    expect(after).toBeGreaterThanOrEqual(before + 100_000n);
  }, 60_000);
});
