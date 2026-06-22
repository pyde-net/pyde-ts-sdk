/**
 * Unit tests for `fromWireReceipt`'s `revert_reason` parsing, exercised
 * via the public `Provider.getTransactionReceipt` surface. Mocks the
 * HTTP layer so each case asserts purely against the wire shape.
 *
 * Covers engine PR #349 (`revert_reason: Option<RevertReason>` on the
 * receipt wire) + backward-compat with pre-#349 builds that left
 * the field absent or shipped a bare string.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { Provider } from "./provider";

function mockFetch(result: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers(),
      json: async () => ({ jsonrpc: "2.0", id: 1, result }),
    }),
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getTransactionReceipt — structured revert_reason (engine PR #349)", () => {
  const TX_HASH = "0x" + "cc".repeat(32);
  const baseReceipt = {
    tx_hash: TX_HASH,
    wave_id: "0x10",
    tx_index: "0x0",
    gas_used: "0x5208",
    fee_paid: "0x5208",
    events: [],
    return_data: "0x",
  };

  it("revertReason is null on success receipts (field omitted from wire)", async () => {
    mockFetch({ ...baseReceipt, status: "success" });
    const provider = new Provider("https://rpc.example.com");
    const r = await provider.getTransactionReceipt(TX_HASH);
    expect(r).not.toBeNull();
    expect(r!.success).toBe(true);
    expect(r!.revertReason).toBeNull();
  });

  it("parses EngineValidation reverts with category + message", async () => {
    mockFetch({
      ...baseReceipt,
      status: "reverted",
      revert_reason: {
        category: "EngineValidation",
        message: "nonce out of window: provided=17, window_start=18",
      },
    });
    const provider = new Provider("https://rpc.example.com");
    const r = await provider.getTransactionReceipt(TX_HASH);
    expect(r!.success).toBe(false);
    expect(r!.revertReason).toEqual({
      category: "EngineValidation",
      message: "nonce out of window: provided=17, window_start=18",
    });
  });

  it("parses Contract reverts with the contract's revert string", async () => {
    mockFetch({
      ...baseReceipt,
      status: "reverted",
      revert_reason: {
        category: "Contract",
        message: "by must be non-zero",
      },
    });
    const provider = new Provider("https://rpc.example.com");
    const r = await provider.getTransactionReceipt(TX_HASH);
    expect(r!.revertReason!.category).toBe("Contract");
    expect(r!.revertReason!.message).toBe("by must be non-zero");
  });

  it("parses Vm traps", async () => {
    mockFetch({
      ...baseReceipt,
      status: "reverted",
      revert_reason: {
        category: "Vm",
        message: "Trap(MemoryOutOfBounds)",
      },
    });
    const provider = new Provider("https://rpc.example.com");
    const r = await provider.getTransactionReceipt(TX_HASH);
    expect(r!.revertReason!.category).toBe("Vm");
  });

  it("backward-compat: tolerates pre-#349 receipt with bare-string revert_reason", async () => {
    mockFetch({
      ...baseReceipt,
      status: "reverted",
      revert_reason: "insufficient balance",
    });
    const provider = new Provider("https://rpc.example.com");
    const r = await provider.getTransactionReceipt(TX_HASH);
    expect(r!.revertReason).toEqual({
      category: "EngineValidation",
      message: "insufficient balance",
    });
  });

  it("forward-compat: passes through unknown categories without crashing", async () => {
    mockFetch({
      ...baseReceipt,
      status: "reverted",
      revert_reason: { category: "FutureCategory", message: "wat" },
    });
    const provider = new Provider("https://rpc.example.com");
    const r = await provider.getTransactionReceipt(TX_HASH);
    expect(r!.revertReason!.category).toBe("FutureCategory");
    expect(r!.revertReason!.message).toBe("wat");
  });

  it("revert_reason absent (older builds) → null", async () => {
    mockFetch({ ...baseReceipt, status: "reverted" });
    const provider = new Provider("https://rpc.example.com");
    const r = await provider.getTransactionReceipt(TX_HASH);
    expect(r!.success).toBe(false);
    expect(r!.revertReason).toBeNull();
  });
});
