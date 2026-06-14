/**
 * Provider — read-side live tests against a spawned devnet.
 *
 * Engine-blocked surfaces (`describe.skip` until the engine ships):
 *   - pyde_getBaseFee / pyde_gasPrice — neither exposed.
 *   - pyde_getWaveNumber / pyde_blockNumber — no way to resolve the
 *     head wave id, so `getWave()` no-arg can't bind.
 *
 * Engine-supported now (un-skipped on this branch):
 *   - getNonce → pyde_getTransactionCount fallback works.
 *   - getAccount → wire-shape matches after the M-4 adapter.
 *   - getWave(specificId) → numeric param + tolerant wire-shape
 *     adapter (hex-or-bytes for anchor/state_root) lands here.
 *   - getLogs → SDK accepts both `entries` (engine) and `events`
 *     (older spec drafts) for the result envelope.
 *   - batch → composes the supported sub-methods.
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

  it("getAccount returns a default Account for an unknown address", async () => {
    const random = "0x" + "cd".repeat(32);
    const account = await devnet.provider.getAccount(random);
    expect(account).not.toBeNull();
    expect(account!.nonce).toBe(0n);
    expect(account!.balance).toBe(0n);
  });

  it("getNonce returns 0n for an unknown address", async () => {
    const random = "0x" + "ef".repeat(32);
    const nonce = await devnet.provider.getNonce(random);
    expect(nonce).toBe(0n);
  });

  it("batch returns results in the same order as the request", async () => {
    const random = "0x" + "12".repeat(32);
    const [chainId, balance, nonce] = await devnet.provider.batch([
      { method: "pyde_chainId", params: [] },
      { method: "pyde_getBalance", params: [random] },
      { method: "pyde_getTransactionCount", params: [random] },
    ]);
    expect(parseInt(chainId as string, 16)).toBe(devnet.chainId);
    expect(BigInt(balance as string)).toBe(0n);
    expect(parseInt(nonce as string, 16)).toBe(0);
  });

  it("getWave(0) decodes the genesis header once devnet ticks past it", async () => {
    // Helper-spawn races genesis publication; the chain-id RPC binds
    // before the genesis wave materialises in the RPC store. Poll up
    // to ~3s, then assert.
    let head = null;
    for (let i = 0; i < 30 && head === null; i++) {
      head = await devnet.provider.getWave(0n);
      if (head === null) await new Promise((r) => setTimeout(r, 100));
    }
    expect(head).not.toBeNull();
    expect(head!.waveId).toBe(0n);
    expect(head!.anchor.startsWith("0x")).toBe(true);
  });

  it("getLogs returns an empty page for a valid sub-cap wave range", async () => {
    const page = await devnet.provider.getLogs({
      fromWave: 0n,
      toWave: 100n,
    });
    expect(Array.isArray(page.events)).toBe(true);
    expect(page.events.length).toBeLessThanOrEqual(1_000);
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

  it("getWave() — no-arg latest — needs pyde_getWaveNumber", async () => {
    const head = await devnet.provider.getWave();
    expect(head).not.toBeNull();
  });
});
