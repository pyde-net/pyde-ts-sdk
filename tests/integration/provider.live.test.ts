/**
 * Provider — read-side live tests against a spawned devnet.
 *
 * Some methods are gated as `it.skip` until the engine implements them
 * (or renames its existing RPC surfaces to match chapter 17.4):
 *
 *   - pyde_getBaseFee   — chain currently exposes neither this nor the
 *                         pre-pivot `pyde_gasPrice` fallback.
 *   - pyde_getNonce     — chain has neither this nor pre-pivot
 *                         `pyde_getTransactionCount`.
 *   - pyde_getWave      — chain doesn't accept the no-arg form (no
 *                         "latest" support yet) and we can't resolve
 *                         the head wave id either (no
 *                         pyde_blockNumber).
 *   - pyde_getLogs      — chain ignores the `from_wave` field and
 *                         treats every query as `[0, current_head]`,
 *                         which always exceeds the 5,000-wave cap.
 *
 * The SDK code calls the spec-correct names with sensible fallbacks
 * — the integration tests will flip green once the engine catches up.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnDevnet, type DevnetHandle } from "./devnet";

let devnet: DevnetHandle;

beforeAll(async () => {
  devnet = await spawnDevnet();
}, 60_000);

afterAll(async () => {
  await devnet?.stop();
});

describe("Provider — live RPC (chain-implemented surfaces)", () => {
  it("getChainId returns the configured chain id", async () => {
    const chainId = await devnet.provider.getChainId();
    expect(chainId).toBe(devnet.chainId);
  });

  it("getBalance returns 0n for an unknown address", async () => {
    const random = "0x" + "ab".repeat(32);
    const balance = await devnet.provider.getBalance(random);
    expect(balance).toBe(0n);
  });
});

describe.skip("Provider — live RPC (waiting on engine to implement)", () => {
  it("getBaseFee returns a non-zero bigint", async () => {
    const baseFee = await devnet.provider.getBaseFee();
    expect(typeof baseFee).toBe("bigint");
    expect(baseFee > 0n).toBe(true);
  });

  it("getFeeData exposes equal gasPrice + baseFee in v1 (no tips)", async () => {
    const fd = await devnet.provider.getFeeData();
    expect(fd.baseFee).toBe(fd.gasPrice);
  });

  it("getWave returns the latest wave header with anchor + timestamp", async () => {
    const head = await devnet.provider.getWave();
    expect(head).not.toBeNull();
    expect(head!.waveId).toBeGreaterThanOrEqual(0);
    expect(typeof head!.timestamp).toBe("string");
    expect(head!.anchor.startsWith("0x")).toBe(true);
  });

  it("getWave(specificId) returns that wave's header (or null)", async () => {
    const head = await devnet.provider.getWave();
    if (!head) return;
    const specific = await devnet.provider.getWave(head.waveId);
    expect(specific?.waveId).toBe(head.waveId);
  });

  it("getAccount returns a default Account for an unknown address", async () => {
    // The chain returns a partial response for unknown addresses; the
    // SDK parser fills zero-valued defaults so callers get a stable
    // Account shape (nonce: 0, balance: 0n, codeHash: 0x00..00, ...).
    const random = "0x" + "cd".repeat(32);
    const account = await devnet.provider.getAccount(random);
    expect(account).not.toBeNull();
    expect(account!.nonce).toBe(0);
    expect(account!.balance).toBe(0n);
  });

  it("getNonce returns 0 for an unknown address", async () => {
    const random = "0x" + "ef".repeat(32);
    const nonce = await devnet.provider.getNonce(random);
    expect(nonce).toBe(0);
  });

  it("batch returns results in the same order as the request", async () => {
    const random = "0x" + "12".repeat(32);
    const [chainId, balance, nonce] = await devnet.provider.batch([
      { method: "pyde_chainId", params: [] },
      { method: "pyde_getBalance", params: [random] },
      { method: "pyde_getNonce", params: [random] },
    ]);
    expect(parseInt(chainId as string, 16)).toBe(devnet.chainId);
    expect(BigInt(balance as string)).toBe(0n);
    expect(parseInt(nonce as string, 16)).toBe(0);
  });

  it("getLogs returns a page (possibly empty) for a small valid wave range", async () => {
    const page = await devnet.provider.getLogs({
      fromWave: 0,
      toWave: 100,
    });
    expect(Array.isArray(page.events)).toBe(true);
    expect(page.events.length).toBeLessThanOrEqual(1_000);
  });
});
