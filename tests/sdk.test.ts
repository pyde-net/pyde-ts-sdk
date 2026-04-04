import {
  generateKeypair,
  deriveAddress,
  signMessage,
  verifySignature,
  computeSelector,
  hashTransaction,
  Wallet,
  Contract,
  ContractCall,
  decodeU64,
  decodeBool,
  decodeString,
} from "../src";

describe("Crypto", () => {
  test("generateKeypair returns valid keypair", () => {
    const kp = generateKeypair();
    expect(kp.address).toMatch(/^0x[0-9a-f]{64}$/);
  });

  test("deriveAddress matches keypair", () => {
    const kp = generateKeypair();
    expect(deriveAddress(kp.publicKey)).toBe(kp.address);
  });

  test("sign and verify roundtrip", () => {
    const kp = generateKeypair();
    const msg = "0x" + "ab".repeat(32);
    const sig = signMessage(kp.secretKey, msg);
    expect(verifySignature(kp.publicKey, msg, sig)).toBe(true);
  });

  test("verify rejects wrong key", () => {
    const kp1 = generateKeypair();
    const kp2 = generateKeypair();
    const msg = "0x" + "cd".repeat(32);
    const sig = signMessage(kp1.secretKey, msg);
    expect(verifySignature(kp2.publicKey, msg, sig)).toBe(false);
  });

  test("computeSelector matches known values", () => {
    expect(computeSelector("get_count")).toBe(0xd9e32bf7);
    expect(computeSelector("increment")).toBe(0x3812e73e);
  });

  test("hashTransaction produces 32-byte hash", () => {
    const kp = generateKeypair();
    const hash = hashTransaction({
      from: kp.address,
      to: "0x" + "bb".repeat(32),
      value: 100,
      data: "0x",
      gasLimit: 21000,
      nonce: 0,
      chainId: 31337,
      txType: 0,
    });
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe("Wallet", () => {
  test("generate creates valid wallet", () => {
    const w = Wallet.generate();
    expect(w.address).toMatch(/^0x[0-9a-f]{64}$/);
  });

  test("fromPrivateKey roundtrip", () => {
    const w = Wallet.generate();
    const exported = w.exportPrivateKey();
    const restored = Wallet.fromPrivateKey(exported);
    expect(restored.address).toBe(w.address);
  });

  test("sign produces valid signature", () => {
    const w = Wallet.generate();
    const msg = "0x" + "42".repeat(32);
    const sig = w.sign(msg);
    expect(verifySignature(w.publicKey, msg, sig)).toBe(true);
  });
});

describe("Contract ABI encoding", () => {
  const abiJson = JSON.stringify({
    abi: {
      functions: [
        { name: "get_count", selector: "0xd9e32bf7", params: [], returns: "u64", view: true, constructor: false },
        { name: "deposit", selector: "0x28a1b7b5", params: [{ name: "amount", type: "u64" }], returns: "()", view: false, constructor: false },
        { name: "set_user", selector: "0x00000000", params: [{ name: "user", type: "UserInfo" }], returns: "()", view: false, constructor: false },
        { name: "set_status", selector: "0x00000000", params: [{ name: "status", type: "Status" }], returns: "()", view: false, constructor: false },
        { name: "set_scores", selector: "0x00000000", params: [{ name: "scores", type: "Vec<u64>" }], returns: "()", view: false, constructor: false },
      ],
      structs: [
        { name: "UserInfo", fields: [{ name: "name", type: "String" }, { name: "age", type: "u64" }, { name: "active", type: "bool" }] },
      ],
      enums: [
        { name: "Status", variants: [{ name: "Active", discriminant: 0 }, { name: "Inactive", discriminant: 1 }, { name: "Banned", discriminant: 2 }] },
      ],
    },
  });

  test("encodeCall validates missing param", () => {
    const c = Contract.fromJson(abiJson, "0x" + "aa".repeat(32), null as any);
    expect(() => c.encodeCall("deposit", {})).toThrow("missing required param 'amount'");
  });

  test("encodeCall validates wrong type", () => {
    const c = Contract.fromJson(abiJson, "0x" + "aa".repeat(32), null as any);
    expect(() => c.encodeCall("deposit", { amount: "not a number" })).toThrow("expected u64, got string");
  });

  test("encodeCall validates int range", () => {
    const c = Contract.fromJson(abiJson, "0x" + "aa".repeat(32), null as any);
    expect(() => c.encodeCall("deposit", { amount: -1 })).toThrow("out of range for u64");
  });

  test("encodeCall with u64 arg", () => {
    const c = Contract.fromJson(abiJson, "0x" + "aa".repeat(32), null as any);
    const data = c.encodeCall("deposit", { amount: 500 });
    expect(data).toMatch(/^0x[0-9a-f]+$/);
    expect(data.length).toBe(2 + 24); // 0x + 4 selector + 8 arg = 24 hex
  });

  test("encodeCall with struct arg", () => {
    const c = Contract.fromJson(abiJson, "0x" + "aa".repeat(32), null as any);
    const data = c.encodeCall("set_user", {
      user: { name: "alice", age: 25, active: true },
    });
    expect(data).toMatch(/^0x[0-9a-f]+$/);
  });

  test("encodeCall validates missing struct field", () => {
    const c = Contract.fromJson(abiJson, "0x" + "aa".repeat(32), null as any);
    expect(() => c.encodeCall("set_user", { user: { name: "alice" } }))
      .toThrow("missing field 'age'");
  });

  test("encodeCall with enum arg (by name)", () => {
    const c = Contract.fromJson(abiJson, "0x" + "aa".repeat(32), null as any);
    const data = c.encodeCall("set_status", { status: "Active" });
    expect(data).toMatch(/^0x[0-9a-f]+$/);
  });

  test("encodeCall validates unknown enum variant", () => {
    const c = Contract.fromJson(abiJson, "0x" + "aa".repeat(32), null as any);
    expect(() => c.encodeCall("set_status", { status: "Unknown" }))
      .toThrow("unknown variant 'Unknown'");
  });

  test("encodeCall with Vec<u64> arg", () => {
    const c = Contract.fromJson(abiJson, "0x" + "aa".repeat(32), null as any);
    const data = c.encodeCall("set_scores", { scores: [100, 200, 300] });
    expect(data).toMatch(/^0x[0-9a-f]+$/);
  });

  test("write without wallet throws", () => {
    const c = Contract.fromJson(abiJson, "0x" + "aa".repeat(32), null as any);
    expect(c.write("deposit", { amount: 500 })).rejects.toThrow("No wallet connected");
  });
});

describe("ContractCall (low-level)", () => {
  test("build with no args", () => {
    const data = new ContractCall("increment").build();
    expect(data).toMatch(/^0x[0-9a-f]{8}$/);
  });

  test("build with u64 arg", () => {
    const data = new ContractCall("deposit").argU64(500).build();
    expect(data.length).toBe(2 + 24);
  });

  test("build with string arg", () => {
    const data = new ContractCall("set_name").argString("hello").build();
    expect(data.length).toBe(2 + 40);
  });
});

describe("Decode", () => {
  test("decodeU64", () => {
    expect(decodeU64("0x2a00000000000000")).toBe(42n);
  });
  test("decodeBool", () => {
    expect(decodeBool("0x0100000000000000")).toBe(true);
    expect(decodeBool("0x0000000000000000")).toBe(false);
  });
  test("decodeString", () => {
    expect(decodeString("0x050000000000000068656c6c6f")).toBe("hello");
  });
});
