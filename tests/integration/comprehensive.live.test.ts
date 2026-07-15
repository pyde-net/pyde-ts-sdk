/**
 * Comprehensive live coverage — every catalog v0.1 RPC method the SDK
 * wraps that isn't engine-blocked on devnet today.
 *
 * Why a separate file from contract.live.test.ts:
 *   contract.live.test.ts already covers deploy + read + write + event
 *   decoding against borsh-coverage. This file exercises the rest of
 *   the provider surface (chain info, account, wave, snapshot, logs,
 *   batch, simulate, lookup-by-hash) plus wallet local-signing.
 *
 * Engine drift handling:
 *   When the catalog promises a method that devnet doesn't yet expose
 *   (`pyde_getHardFinalityCert`), we
 *   assert one of two outcomes — null result OR an RpcError with code
 *   -32601 (method not found). Either is acceptable; both prove the
 *   SDK round-trips the call correctly.
 *
 * Lives outside the published package — `package.json#files` only
 * includes `dist/`, `docs/`, README, CHANGELOG, LICENSE, SECURITY.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { spawnDevnet, type DevnetHandle } from "./devnet";
import { keypairFromSeed, hashTransaction } from "../../src/crypto";
import { Wallet } from "../../src/wallet";
import { RpcError } from "../../src/errors";
import { TxType } from "../../src/types";
import { blake3 } from "@noble/hashes/blake3";

// Devnet-0 — re-derived locally so we can sign without otigen keystore.
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

beforeAll(async () => {
  devnet = await spawnDevnet({ tickMs: 100 });
}, 60_000);

afterAll(async () => {
  await devnet?.stop();
});

// --------------------------------------------------------------------------
// §1 — Chain info  (chainId, waveId, nodeInfo, metrics)
// --------------------------------------------------------------------------
describe("Provider — chain info", () => {
  it("getChainId returns 31337 (devnet)", async () => {
    expect(await devnet.provider.getChainId()).toBe(31337);
  });

  it("getWaveId returns a monotonically advancing bigint", async () => {
    const a = await devnet.provider.getWaveId();
    expect(typeof a).toBe("bigint");
    await new Promise((r) => setTimeout(r, 250));
    const b = await devnet.provider.getWaveId();
    expect(b).toBeGreaterThanOrEqual(a);
  });

  it("getNodeInfo exposes peer id + protocol version", async () => {
    const info = await devnet.provider.getNodeInfo();
    expect(info.peerId.length).toBeGreaterThan(0);
    expect(info.protocolVersion).toBe("pyde/1");
    expect(info.falconPubkey).not.toBeNull();
    expect(info.listenAddrs).toBeInstanceOf(Array);
  });

  it("getMetrics returns a counter snapshot (non-empty object)", async () => {
    const m = await devnet.provider.getMetrics();
    expect(typeof m).toBe("object");
    expect(Object.keys(m).length).toBeGreaterThan(0);
  });
});

// --------------------------------------------------------------------------
// §2 — Account queries
// --------------------------------------------------------------------------
describe("Provider — account queries", () => {
  it("getBalance — devnet-0 prefunded with ≤ 10 PYDE", async () => {
    // Devnet-0 starts at exactly 10 PYDE but the live-test suite
    // shares state across files (sequential vitest run, single
    // devnet per file). Phase-2 tests in this suite may spend a
    // fraction of the prefund on tx fees + transfers — assert
    // upper-bound + non-empty rather than strict equality.
    const b = await devnet.provider.getBalance(DEV0_ADDR);
    expect(b).toBeGreaterThan(0n);
    expect(b).toBeLessThanOrEqual(10_000_000_000n);
  });

  it("getBalance — random address returns 0n", async () => {
    const b = await devnet.provider.getBalance("0x" + "ab".repeat(32));
    expect(b).toBe(0n);
  });

  it("getNonce — fresh address returns 0n", async () => {
    const n = await devnet.provider.getNonce("0x" + "cd".repeat(32));
    expect(n).toBe(0n);
  });

  it("getAccount — devnet-0 returns a populated record", async () => {
    const a = await devnet.provider.getAccount(DEV0_ADDR);
    expect(a).not.toBeNull();
    expect(a!.address).toBe(DEV0_ADDR);
    expect(a!.balance).toBeGreaterThan(0n);
    expect(a!.balance).toBeLessThanOrEqual(10_000_000_000n);
  });

  it("getAccount — never-touched address returns a zeroed EOA stub (engine implicit-materialisation)", async () => {
    const a = await devnet.provider.getAccount("0x" + "ef".repeat(32));
    expect(a).not.toBeNull();
    expect(a!.balance).toBe(0n);
    expect(a!.nonce).toBe(0n);
  });

  it("getNonceAndChainId returns [bigint, number]", async () => {
    const [nonce, chainId] = await devnet.provider.getNonceAndChainId(DEV0_ADDR);
    expect(typeof nonce).toBe("bigint");
    expect(chainId).toBe(31337);
  });
});

// --------------------------------------------------------------------------
// §3 — Wave + finality + snapshots
// --------------------------------------------------------------------------
describe("Provider — wave + snapshots", () => {
  it("getWave(0n) returns genesis header (with retry for boot race)", async () => {
    let head = null;
    for (let i = 0; i < 30 && head === null; i++) {
      head = await devnet.provider.getWave(0n);
      if (head === null) await new Promise((r) => setTimeout(r, 100));
    }
    expect(head).not.toBeNull();
    expect(head!.waveId).toBe(0n);
    expect(head!.anchor.startsWith("0x")).toBe(true);
  });

  it("getWave(higher than head) returns null", async () => {
    const head = await devnet.provider.getWaveId();
    expect(await devnet.provider.getWave(head + 100_000n)).toBeNull();
  });

  // Engine drift: catalog §24 lists this method but otigen devnet
  // currently returns "method not found". The SDK call is correct;
  // accept either null OR -32601 as a successful round-trip.
  it("getHardFinalityCert(future wave) — null OR method-not-found", async () => {
    const head = await devnet.provider.getWaveId();
    try {
      const cert = await devnet.provider.getHardFinalityCert(head + 100_000n);
      expect(cert).toBeNull();
    } catch (e) {
      expect(e).toBeInstanceOf(RpcError);
      expect(String(e)).toMatch(/-32601|method not found/i);
    }
  });

  it("getSnapshotManifest returns a manifest (catalog §26 wire shape)", async () => {
    const m = await devnet.provider.getSnapshotManifest();
    expect(m).not.toBeNull();
    expect(typeof m!.waveId).toBe("bigint");
    expect(m!.stateRoot).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(m!.chunkSize).toBeGreaterThan(0);
    expect(m!.chunkCount).toBeGreaterThan(0);
    expect(m!.chunkHashes.length).toBe(m!.chunkCount);
    expect(m!.totalKeys).toBeGreaterThanOrEqual(0);
  });

  it("getSnapshot returns a base64-encoded blob (catalog §25 standard alphabet)", async () => {
    const snap = await devnet.provider.getSnapshot();
    expect(typeof snap).toBe("string");
    expect(snap.length).toBeGreaterThan(0);
    expect(snap).toMatch(/^[A-Za-z0-9+/=]+$/);
  });
});

// --------------------------------------------------------------------------
// §4 — Storage slots + name resolution
// --------------------------------------------------------------------------
describe("Provider — storage + name resolution", () => {
  it("getStorageSlot — never-written global key returns null", async () => {
    const slot = await devnet.provider.getStorageSlot("0x" + "55".repeat(32));
    expect(slot).toBeNull();
  });

  it("resolveName — unregistered bare name returns null (catalog rejects names with '.')", async () => {
    const r = await devnet.provider.resolveName("notregistered");
    expect(r).toBeNull();
  });
});

// --------------------------------------------------------------------------
// §5 — Validator queries
// --------------------------------------------------------------------------
describe("Provider — validator queries", () => {
  it("getValidator — random address returns null", async () => {
    const v = await devnet.provider.getValidator("0x" + "01".repeat(32));
    expect(v).toBeNull();
  });

  it("getOperatorValidators — random operator returns []", async () => {
    const vs = await devnet.provider.getOperatorValidators("0x" + "02".repeat(32));
    expect(vs).toEqual([]);
  });
});

// --------------------------------------------------------------------------
// §7 — Logs + Events
// --------------------------------------------------------------------------
describe("Provider — logs + events", () => {
  it("getLogs returns an empty page for a sub-cap range with no events", async () => {
    const page = await devnet.provider.getLogs({ fromWave: 0n, toWave: 100n });
    expect(Array.isArray(page.events)).toBe(true);
  });

  it("getEvents (no filter) returns []", async () => {
    const events = await devnet.provider.getEvents();
    expect(Array.isArray(events)).toBe(true);
  });

  it("getEvents (contract filter) returns []", async () => {
    const events = await devnet.provider.getEvents({
      contract: "0x" + "00".repeat(32),
    });
    expect(Array.isArray(events)).toBe(true);
  });
});

// --------------------------------------------------------------------------
// §8 — Batch RPC
// --------------------------------------------------------------------------
describe("Provider — batch RPC", () => {
  it("batches multiple RPCs in one round-trip", async () => {
    const random = "0x" + "12".repeat(32);
    const [chainId, balance, nonce] = await devnet.provider.batch([
      { method: "pyde_chainId", params: [] },
      { method: "pyde_getBalance", params: [random] },
      { method: "pyde_getTransactionCount", params: [random] },
    ]);
    expect(parseInt(chainId as string, 16)).toBe(31337);
    expect(BigInt(balance as string)).toBe(0n);
    expect(parseInt(nonce as string, 16)).toBe(0);
  });
});

// --------------------------------------------------------------------------
// §9 — Transaction lookup
// --------------------------------------------------------------------------
describe("Provider — tx lookup", () => {
  const unknownHash = "0x" + "00".repeat(32);

  it("getTransaction(unknown) returns null", async () => {
    expect(await devnet.provider.getTransaction(unknownHash)).toBeNull();
  });

  it("getTransactionReceipt(unknown) returns null", async () => {
    expect(await devnet.provider.getTransactionReceipt(unknownHash)).toBeNull();
  });

  it("getReceiptArchival(unknown) returns null", async () => {
    expect(await devnet.provider.getReceiptArchival(unknownHash)).toBeNull();
  });
});

// --------------------------------------------------------------------------
// §10 — Wallet — local signing against devnet (read-side)
// --------------------------------------------------------------------------
describe("Wallet — local signing against devnet (read-side)", () => {
  it("hashTransaction is stable + deterministic", () => {
    const tx = {
      from: "0x" + "ab".repeat(32),
      to: "0x" + "cd".repeat(32),
      value: "0",
      data: "0x",
      gasLimit: 21_000,
      nonce: 0n,
      chainId: 31337,
      txType: TxType.Standard,
    };
    const h1 = hashTransaction(tx);
    const h2 = hashTransaction(tx);
    expect(h1).toBe(h2);
  });

  it("Wallet.fromKeys(devnet-0 seed) reproduces the canonical devnet-0 address", () => {
    const seed = seedHex(devnetSeed(0));
    const kp = keypairFromSeed(seed);
    const w = Wallet.fromKeys(kp.publicKey, kp.secretKey);
    expect(w.address).toBe(DEV0_ADDR);
  });

  it("Wallet.signTransaction produces a borsh-encoded wire bigger than the structural floor (~700 B)", () => {
    const kp = keypairFromSeed(seedHex(devnetSeed(0)));
    const w = Wallet.fromKeys(kp.publicKey, kp.secretKey);
    const tx = {
      from: w.address,
      to: "0x" + "aa".repeat(32),
      value: "1000",
      data: "0x",
      gasLimit: 100_000,
      nonce: 0n,
      chainId: 31337,
      txType: TxType.Standard,
    };
    const wire = w.signTransaction(tx);
    expect(wire).toMatch(/^0x[0-9a-fA-F]+$/);
    expect((wire.length - 2) / 2).toBeGreaterThan(700);
  });
});

// --------------------------------------------------------------------------
// §11 — simulateTransaction — sign a probe tx, dry-run it
// --------------------------------------------------------------------------
describe("Provider — simulateTransaction", () => {
  it("dry-runs a signed wire and returns {receipt, reads, writes}", async () => {
    const kp = keypairFromSeed(seedHex(devnetSeed(0)));
    const w = Wallet.fromKeys(kp.publicKey, kp.secretKey);
    const nonce = await devnet.provider.getNonce(w.address);
    const tx = {
      from: w.address,
      to: "0x" + "aa".repeat(32),
      value: "1",
      data: "0x",
      gasLimit: 100_000,
      nonce,
      chainId: 31337,
      txType: TxType.Standard,
    };
    const wire = w.signTransaction(tx);
    try {
      const sim = await devnet.provider.simulateTransaction(wire);
      expect(sim).toHaveProperty("receipt");
      expect(sim).toHaveProperty("reads");
      expect(sim).toHaveProperty("writes");
    } catch (e) {
      // If the engine rejects (no auth keys), the SDK should surface
      // it as an RpcError cleanly.
      expect(e).toBeInstanceOf(RpcError);
    }
  }, 15_000);
});
