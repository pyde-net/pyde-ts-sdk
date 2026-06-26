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

describe("getWave — WaveHeader.stateRoot dual-hash struct (regression)", () => {
  it("decodes {blake3, poseidon2} string fields to a 32-byte hex string", async () => {
    // Engine ships state_root as `{blake3: "0x<hex>", poseidon2: "0x<hex>"}`
    // — both legs are strings, not byte arrays. Pre-fix `hexlifyAnchor`
    // only descended on array values and fell through to `String(raw)`,
    // emitting the literal `"[object Object]"`.
    const blake3Hex = "0x" + "d3".repeat(32);
    const poseidon2Hex = "0x" + "00".repeat(32);
    mockFetch({
      wave_id: "0x1",
      anchor: "0x" + "f5".repeat(32),
      state_root: { blake3: blake3Hex, poseidon2: poseidon2Hex },
      events_root: "0x" + "00".repeat(32),
      tx_count: "0x0",
      timestamp_secs: "0x0",
    });
    const provider = new Provider("https://rpc.example.com");
    const wave = await provider.getWave(1n);
    expect(wave).not.toBeNull();
    expect(wave!.stateRoot).toBe(blake3Hex);
    expect(wave!.stateRoot).not.toBe("[object Object]");
  });

  it("falls back to poseidon2 when blake3 is absent", async () => {
    const poseidon2Hex = "0x" + "aa".repeat(32);
    mockFetch({
      wave_id: "0x1",
      anchor: "0x" + "f5".repeat(32),
      state_root: { poseidon2: poseidon2Hex },
      tx_count: "0x0",
      timestamp_secs: "0x0",
    });
    const provider = new Provider("https://rpc.example.com");
    const wave = await provider.getWave(1n);
    expect(wave).not.toBeNull();
    expect(wave!.stateRoot).toBe(poseidon2Hex);
    expect(wave!.stateRoot).not.toBe("[object Object]");
  });

  it("still accepts byte-array legs (forward-compat with engine drift)", async () => {
    const blake3Bytes = Array.from({ length: 32 }, (_, i) => i);
    mockFetch({
      wave_id: "0x1",
      anchor: "0x" + "f5".repeat(32),
      state_root: { blake3: blake3Bytes },
      tx_count: "0x0",
      timestamp_secs: "0x0",
    });
    const provider = new Provider("https://rpc.example.com");
    const wave = await provider.getWave(1n);
    expect(wave).not.toBeNull();
    expect(wave!.stateRoot).toBe(
      "0x" + blake3Bytes.map((b) => b.toString(16).padStart(2, "0")).join(""),
    );
  });
});

describe("getAccount — wire field naming (regression)", () => {
  it("reads engine's canonical `state_root` field into `stateRoot`", async () => {
    const stateRootHex = "0x" + "ab".repeat(32);
    mockFetch({
      address: "0x" + "11".repeat(32),
      nonce: 0,
      balance: "0x0",
      code_hash: "0x" + "00".repeat(32),
      state_root: stateRootHex,
      account_type: "eoa",
    });
    const provider = new Provider("https://rpc.example.com");
    const account = await provider.getAccount("0x" + "11".repeat(32));
    expect(account).not.toBeNull();
    expect(account!.stateRoot).toBe(stateRootHex);
  });

  it("tolerates legacy `storage_root` for forward-compat", async () => {
    const stateRootHex = "0x" + "cd".repeat(32);
    mockFetch({
      address: "0x" + "11".repeat(32),
      nonce: 0,
      balance: "0x0",
      code_hash: "0x" + "00".repeat(32),
      storage_root: stateRootHex,
      account_type: "eoa",
    });
    const provider = new Provider("https://rpc.example.com");
    const account = await provider.getAccount("0x" + "11".repeat(32));
    expect(account!.stateRoot).toBe(stateRootHex);
  });

  it.each([
    ["eoa", 0],
    ["contract", 1],
    ["system", 2],
    ["EOA", 0],
    ["Contract", 1],
  ])("parses account_type string %s as discriminant %d", async (tag, expected) => {
    mockFetch({
      address: "0x" + "11".repeat(32),
      nonce: 0,
      balance: "0x0",
      code_hash: "0x" + "00".repeat(32),
      state_root: "0x" + "00".repeat(32),
      account_type: tag,
    });
    const provider = new Provider("https://rpc.example.com");
    const account = await provider.getAccount("0x" + "11".repeat(32));
    expect(account!.accountType).toBe(expected);
  });

  it("still accepts numeric account_type for legacy nodes", async () => {
    mockFetch({
      address: "0x" + "11".repeat(32),
      nonce: 0,
      balance: "0x0",
      code_hash: "0x" + "00".repeat(32),
      state_root: "0x" + "00".repeat(32),
      account_type: 1,
    });
    const provider = new Provider("https://rpc.example.com");
    const account = await provider.getAccount("0x" + "11".repeat(32));
    expect(account!.accountType).toBe(1);
  });
});

describe("resolveName — .pyde suffix stripping", () => {
  it("strips a trailing `.pyde` before hitting the engine", async () => {
    // The engine rejects `.` in names with `-32602 'invalid name format'`.
    // We mock the RPC to capture exactly what the SDK forwarded.
    let observedParams: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (_url, init) => {
        const body = JSON.parse((init as { body: string }).body);
        observedParams = body.params;
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          headers: new Headers(),
          json: async () => ({ jsonrpc: "2.0", id: body.id, result: "0x" + "22".repeat(32) }),
        };
      }),
    );
    const provider = new Provider("https://rpc.example.com");
    await provider.resolveName("alice.pyde");
    expect(observedParams).toEqual(["alice"]);
  });

  it("leaves bare labels untouched", async () => {
    let observedParams: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (_url, init) => {
        const body = JSON.parse((init as { body: string }).body);
        observedParams = body.params;
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          headers: new Headers(),
          json: async () => ({ jsonrpc: "2.0", id: body.id, result: null }),
        };
      }),
    );
    const provider = new Provider("https://rpc.example.com");
    await provider.resolveName("alice");
    expect(observedParams).toEqual(["alice"]);
  });
});

describe("callFunction — borsh-encoded CallPayload (regression)", () => {
  it("wraps function + calldata into the canonical CallPayload bytes", async () => {
    // Pin the borsh frame: CallPayload { function: "get", calldata: [] }
    // → 4-byte LE len + "get" UTF-8 + 4-byte LE 0 = 11 bytes
    //   = 0x03000000 67657400 000000 = 0x0300000067657400000000
    let capturedData: string | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string);
        capturedData = (body.params[0] as Record<string, string>).data;
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          headers: new Headers(),
          json: async () => ({ jsonrpc: "2.0", id: 1, result: "0x0000000000000000" }),
        };
      }),
    );
    const provider = new Provider("https://rpc.example.com");
    const out = await provider.callFunction("0x" + "ab".repeat(32), "get", "0x");
    expect(out).toBe("0x0000000000000000");
    expect(capturedData).toBe("0x0300000067657400000000");
  });

  it("propagates raw calldata bytes verbatim", async () => {
    let capturedData: string | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string);
        capturedData = (body.params[0] as Record<string, string>).data;
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          headers: new Headers(),
          json: async () => ({ jsonrpc: "2.0", id: 1, result: "0x" }),
        };
      }),
    );
    const provider = new Provider("https://rpc.example.com");
    // CallPayload { function: "x", calldata: [0xde, 0xad, 0xbe, 0xef] }
    //   4-byte LE len (1) + "x" UTF-8 + 4-byte LE len (4) + raw bytes
    //   = 0x01000000 78 04000000 deadbeef
    await provider.callFunction("0x" + "ab".repeat(32), "x", "0xdeadbeef");
    expect(capturedData).toBe("0x010000007804000000deadbeef");
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
