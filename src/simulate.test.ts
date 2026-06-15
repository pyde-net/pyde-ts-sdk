import { describe, it, expect } from "vitest";

import { simulateTransaction, previewTransaction, applySimulation } from "./simulate";
import type { TxFields } from "./types";
import { TxType } from "./types";

// Minimal provider stub. Only what simulateTransaction calls.
function stubProvider() {
  return {
    estimateGas: async () => 42_000,
    estimateAccess: async () => [],
    call: async () => "0x",
    getBalance: async () => 1_000_000_000n,
  } as unknown as Parameters<typeof simulateTransaction>[1]["provider"];
}

const tx: TxFields = {
  from: "0x" + "11".repeat(32),
  to: "0x" + "22".repeat(32),
  value: "1000",
  data: "0x",
  gasLimit: 21_000,
  nonce: 0n,
  chainId: 31337,
  txType: TxType.Standard,
};

describe("simulate — Tier 1 stub gates against accidental 'local' regression", () => {
  it("simulateTransaction always returns source: 'rpc' today", async () => {
    const result = await simulateTransaction(tx, { provider: stubProvider() });
    expect(result.source).toBe("rpc");
  });

  it("previewTransaction always returns source: 'rpc' today", async () => {
    const result = await previewTransaction(tx, stubProvider());
    expect(result.source).toBe("rpc");
  });

  it("returns the conservative gas default (engine has no estimateGas yet)", async () => {
    const result = await simulateTransaction(tx, { provider: stubProvider() });
    // tx.data === "0x" → 100k plain-transfer floor; calldata-bearing
    // calls would return 5M. Once Tier-2 wires `pyde_simulateTransaction`
    // this falls back to the real chain estimate.
    expect(result.gasEstimate).toBe(100_000);
    expect(result.willRevert).toBe(false);
  });

  it("applySimulation patches the gas multiplier onto the tx", () => {
    const t = { ...tx };
    applySimulation(
      t,
      {
        willRevert: false,
        gasEstimate: 100_000,
        accessList: [],
        events: [],
        returnData: "0x",
        source: "rpc",
      },
      { gasMultiplier: 1.5 },
    );
    expect(t.gasLimit).toBe(150_000);
  });
});
