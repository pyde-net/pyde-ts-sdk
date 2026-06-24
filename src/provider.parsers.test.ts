/**
 * Provider wire-shape parser tests. Cover the tolerances the SDK
 * added during the Phase 2 engine sweep:
 *   - byte-array vs hex-string address fields (catalog §22 archival)
 *   - PascalCase TxType enums (`"Standard"` / `"Deploy"` / ...)
 *   - ThresholdPublicKey scheme passthrough (kyber-768-goldilocks etc.)
 *   - getTransaction's missing-`hash` fallback to the queried hash
 *
 * Mocks `fetch` rather than hitting a devnet — exercises the parsers
 * directly with hand-built wire payloads.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { Provider } from "./provider";
import { TxType } from "./types";

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

describe("getTransaction — archival wire shape (catalog §22)", () => {
  const TX_HASH = "0x" + "ab".repeat(32);
  const SENDER_BYTES = Array.from({ length: 32 }, (_, i) => i + 1); // 0x010203…
  const SENDER_HEX = "0x" + SENDER_BYTES.map((b) => b.toString(16).padStart(2, "0")).join("");
  const TO_BYTES = Array.from({ length: 32 }, () => 0xff);
  const TO_HEX = "0x" + "ff".repeat(32);

  it("accepts byte-array `sender` + `to` fields and emits canonical hex", async () => {
    mockFetch({
      sender: SENDER_BYTES,
      to: TO_BYTES,
      value: "0x1",
      data: [],
      gas_limit: 100_000,
      nonce: 5,
      chain_id: 31337,
      tx_type: "Standard",
    });
    const provider = new Provider("https://rpc.example.com");
    const tx = await provider.getTransaction(TX_HASH);
    expect(tx).not.toBeNull();
    expect(tx!.from).toBe(SENDER_HEX);
    expect(tx!.to).toBe(TO_HEX);
    expect(tx!.hash).toBe(TX_HASH); // fallback to queried hash
    expect(tx!.data).toBe("0x");
    expect(tx!.gasLimit).toBe("0x186a0");
    expect(tx!.chainId).toBe(31337);
    expect(tx!.txType).toBe(TxType.Standard);
  });

  it("accepts already-hex `sender` and `tx_hash` fields", async () => {
    mockFetch({
      tx_hash: TX_HASH,
      sender: SENDER_HEX,
      to: TO_HEX,
      value: "0x100",
      data: "0xdeadbeef",
      gas_limit: 21_000,
      nonce: 0,
      chain_id: 1,
      tx_type: "RegisterPubkey",
    });
    const provider = new Provider("https://rpc.example.com");
    const tx = await provider.getTransaction(TX_HASH);
    expect(tx!.from).toBe(SENDER_HEX);
    expect(tx!.data).toBe("0xdeadbeef");
    expect(tx!.txType).toBe(TxType.RegisterPubkey);
  });

  it("maps every PascalCase TxType variant", async () => {
    const cases: Array<[string, number]> = [
      ["Standard", TxType.Standard],
      ["Deploy", TxType.Deploy],
      ["StakeDeposit", TxType.StakeDeposit],
      ["StakeWithdraw", TxType.StakeWithdraw],
      ["Slash", TxType.Slash],
      ["ClaimReward", TxType.ClaimReward],
      ["ClaimAirdrop", TxType.ClaimAirdrop],
      ["SweepAirdrop", TxType.SweepAirdrop],
      ["MultisigTx", TxType.MultisigTx],
      ["RotateMultisig", TxType.RotateMultisig],
      ["EmergencyPause", TxType.EmergencyPause],
      ["EmergencyResume", TxType.EmergencyResume],
      ["RegisterPubkey", TxType.RegisterPubkey],
    ];
    for (const [name, expected] of cases) {
      mockFetch({
        sender: SENDER_BYTES,
        to: TO_BYTES,
        value: "0x0",
        data: [],
        gas_limit: 100_000,
        nonce: 0,
        chain_id: 31337,
        tx_type: name,
      });
      const p = new Provider("https://rpc.example.com");
      const tx = await p.getTransaction(TX_HASH);
      expect(tx!.txType, `tx_type=${name}`).toBe(expected);
    }
  });

  it("rejects an unknown PascalCase TxType variant with a clear error", async () => {
    mockFetch({
      sender: SENDER_BYTES,
      to: TO_BYTES,
      value: "0x0",
      data: [],
      gas_limit: 100_000,
      nonce: 0,
      chain_id: 31337,
      tx_type: "FreshlyInvented",
    });
    const provider = new Provider("https://rpc.example.com");
    await expect(provider.getTransaction(TX_HASH)).rejects.toThrow(/unknown enum variant.*FreshlyInvented/);
  });

  it("returns null when the wire result is null (tx not on chain)", async () => {
    mockFetch(null);
    const provider = new Provider("https://rpc.example.com");
    expect(await provider.getTransaction(TX_HASH)).toBeNull();
  });

  it("accepts numeric hex-string `tx_type` too (mixed-wire builds)", async () => {
    mockFetch({
      sender: SENDER_BYTES,
      to: TO_BYTES,
      value: "0x0",
      data: [],
      gas_limit: 100_000,
      nonce: 0,
      chain_id: 31337,
      tx_type: "0x0d", // 13 = RegisterPubkey
    });
    const provider = new Provider("https://rpc.example.com");
    const tx = await provider.getTransaction(TX_HASH);
    expect(tx!.txType).toBe(TxType.RegisterPubkey);
  });
});

describe("getThresholdPublicKey — scheme passthrough (no coercion)", () => {
  it("passes 'kyber-768-goldilocks' through verbatim", async () => {
    mockFetch({
      epoch: "0x0",
      scheme: "kyber-768-goldilocks",
      public_key: "0x010000",
    });
    const provider = new Provider("https://rpc.example.com");
    const k = await provider.getThresholdPublicKey();
    expect(k).not.toBeNull();
    expect(k!.scheme).toBe("kyber-768-goldilocks");
    expect(k!.epoch).toBe(0n);
    expect(k!.publicKey).toBe("0x010000");
  });

  it("passes 'kyber-768' through verbatim", async () => {
    mockFetch({ epoch: "0x1", scheme: "kyber-768", public_key: "0x00" });
    const provider = new Provider("https://rpc.example.com");
    const k = await provider.getThresholdPublicKey();
    expect(k!.scheme).toBe("kyber-768");
    expect(k!.epoch).toBe(1n);
  });

  it("passes 'mock' through verbatim", async () => {
    mockFetch({ epoch: "0x0", scheme: "mock", public_key: "0x00" });
    const provider = new Provider("https://rpc.example.com");
    const k = await provider.getThresholdPublicKey();
    expect(k!.scheme).toBe("mock");
  });

  it("returns null when the chain reports no DKG yet", async () => {
    mockFetch(null);
    const provider = new Provider("https://rpc.example.com");
    expect(await provider.getThresholdPublicKey()).toBeNull();
  });

  it("accepts `publicKey` alias if the chain ships camelCase", async () => {
    mockFetch({ epoch: "0x0", scheme: "kyber-768", publicKey: "0xabcd" });
    const provider = new Provider("https://rpc.example.com");
    const k = await provider.getThresholdPublicKey();
    expect(k!.publicKey).toBe("0xabcd");
  });
});

describe("getNodeInfo — agentVersion vs protocolVersion", () => {
  it("parses snake_case fields + accepts null falcon_pubkey", async () => {
    mockFetch({
      peer_id: "00abcd",
      falcon_pubkey: null,
      listen_addrs: ["/ip4/127.0.0.1/tcp/30303"],
      agent_version: "pyde/0.1.0",
      protocol_version: "pyde/1",
    });
    const provider = new Provider("https://rpc.example.com");
    const info = await provider.getNodeInfo();
    expect(info.peerId).toBe("00abcd");
    expect(info.falconPubkey).toBeNull();
    expect(info.listenAddrs).toEqual(["/ip4/127.0.0.1/tcp/30303"]);
    expect(info.agentVersion).toBe("pyde/0.1.0");
    expect(info.protocolVersion).toBe("pyde/1");
  });

  it("handles non-null falcon_pubkey on validator nodes", async () => {
    mockFetch({
      peer_id: "00deadbeef",
      falcon_pubkey: "0x1234",
      listen_addrs: [],
      agent_version: "pyde/0.1.0",
      protocol_version: "pyde/1",
    });
    const provider = new Provider("https://rpc.example.com");
    const info = await provider.getNodeInfo();
    expect(info.falconPubkey).toBe("0x1234");
  });
});

describe("HTTP 429 retry with native backoff", () => {
  it("retries on 429 then succeeds on a subsequent 200", async () => {
    const responses = [
      { ok: false, status: 429, statusText: "Too Many Requests", headers: new Headers([["retry-after", "1"]]), json: async () => null },
      { ok: true, status: 200, statusText: "OK", headers: new Headers(), json: async () => ({ jsonrpc: "2.0", id: 1, result: "0x7a69" }) },
    ];
    let i = 0;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => responses[i++]!));
    const provider = new Provider("https://rpc.example.com");
    expect(await provider.getChainId()).toBe(31337);
    expect(i).toBe(2); // first 429, then success
  });

  it("eventually surfaces 429 as RpcError after exhausting retries", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
        headers: new Headers(),
        json: async () => null,
      }),
    );
    const provider = new Provider("https://rpc.example.com");
    await expect(provider.getChainId()).rejects.toThrow(/429/);
  }, 30_000);
});
