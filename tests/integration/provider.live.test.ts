/**
 * Provider — read-side live tests against a spawned devnet.
 * No signing required; exercises every read path the SDK exposes.
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

describe("Provider — live RPC", () => {
  it("getChainId returns the configured chain id", async () => {
    const chainId = await devnet.provider.getChainId();
    expect(chainId).toBe(devnet.chainId);
  });

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

  it("getBalance returns 0n for an unknown address", async () => {
    const random = "0x" + "ab".repeat(32);
    const balance = await devnet.provider.getBalance(random);
    expect(balance).toBe(0n);
  });

  it("getAccount returns null for an unknown address", async () => {
    const random = "0x" + "cd".repeat(32);
    const account = await devnet.provider.getAccount(random);
    expect(account).toBeNull();
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

  it("getLogs returns a paginated empty page for a high wave window", async () => {
    const page = await devnet.provider.getLogs({
      fromWave: 100_000_000,
      toWave: 100_000_500,
    });
    expect(page.events.length).toBe(0);
    expect(page.nextCursor).toBeUndefined();
  });
});
