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
  DeployData,
  decodeU64,
  decodeI64,
  decodeU128,
  decodeI128,
  decodeU256,
  decodeI256,
  decodeBool,
  decodeAddress,
  decodeString,
  decodeBytes,
} from "../src";
import type { Keystore } from "../src";
import { existsSync, unlinkSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

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

describe("Wallet Keystore", () => {
  const testDir = join(tmpdir(), "pyde-ts-sdk-test");
  const testPath = join(testDir, "test-wallet.json");

  beforeAll(() => mkdirSync(testDir, { recursive: true }));
  afterEach(() => { try { unlinkSync(testPath); } catch {} });

  test("toKeystore + fromEncrypted roundtrip", () => {
    const w = Wallet.generate();
    const ks = w.toKeystore("mypassword");
    expect(ks.version).toBe(1);
    expect(ks.address).toBe(w.address);
    expect(ks.public_key).toBe(w.publicKey);

    const restored = Wallet.fromEncrypted(ks, "mypassword");
    expect(restored.address).toBe(w.address);
    expect(restored.exportPrivateKey()).toBe(w.exportPrivateKey());
  });

  test("fromEncrypted rejects wrong password", () => {
    const w = Wallet.generate();
    const ks = w.toKeystore("correct");
    expect(() => Wallet.fromEncrypted(ks, "wrong")).toThrow("wrong password");
  });

  test("createEncrypted + fromKeystore file roundtrip", () => {
    const w = Wallet.createEncrypted(testPath, "pass123");
    expect(existsSync(testPath)).toBe(true);

    const loaded = Wallet.fromKeystore(testPath, "pass123");
    expect(loaded.address).toBe(w.address);
    expect(loaded.exportPrivateKey()).toBe(w.exportPrivateKey());
  });

  test("saveKeystore creates file", () => {
    const w = Wallet.generate();
    w.saveKeystore(testPath, "secret");
    expect(existsSync(testPath)).toBe(true);

    const loaded = Wallet.fromKeystore(testPath, "secret");
    expect(loaded.address).toBe(w.address);
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

  test("encodeCall validates u128 range", () => {
    const extAbi = JSON.stringify({
      abi: {
        functions: [
          { name: "set_big", selector: "0x00000000", params: [{ name: "val", type: "u128" }], returns: "()", view: false, constructor: false },
          { name: "set_signed", selector: "0x00000000", params: [{ name: "val", type: "i128" }], returns: "()", view: false, constructor: false },
        ],
        structs: [],
        enums: [],
      },
    });
    const c = Contract.fromJson(extAbi, "0x" + "aa".repeat(32), null as any);
    // u128 should reject negative
    expect(() => c.encodeCall("set_big", { val: -1n })).toThrow("out of range");
    // i128 should accept negative
    const data = c.encodeCall("set_signed", { val: -500n });
    expect(data).toMatch(/^0x[0-9a-f]+$/);
  });

  test("write without wallet throws", async () => {
    const c = Contract.fromJson(abiJson, "0x" + "aa".repeat(32), null as any);
    await expect(c.write("deposit", { amount: 500 })).rejects.toThrow("No wallet connected");
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

describe("ContractCall — extended builders", () => {
  test("argI128 encodes negative value", () => {
    const data = new ContractCall("fn").argI128(-1n).build();
    // -1 in two's complement i128 = all ff bytes (16 bytes)
    expect(data.length).toBe(2 + 8 + 32); // 0x + 4 selector + 16 arg = 0x prefix + hex
    const argHex = data.slice(10); // skip 0x + 4-byte selector hex
    expect(argHex).toBe("ff".repeat(16));
  });

  test("argI256 encodes negative value", () => {
    const data = new ContractCall("fn").argI256(-1n).build();
    const argHex = data.slice(10);
    expect(argHex).toBe("ff".repeat(32));
  });

  test("argU8 rejects out of range", () => {
    expect(() => new ContractCall("fn").argU8(256)).toThrow("out of range");
    expect(() => new ContractCall("fn").argU8(-1)).toThrow("out of range");
  });

  test("argI8 rejects out of range", () => {
    expect(() => new ContractCall("fn").argI8(128)).toThrow("out of range");
    expect(() => new ContractCall("fn").argI8(-129)).toThrow("out of range");
  });

  test("argAddress validates hex", () => {
    expect(() => new ContractCall("fn").argAddress("0xshort")).toThrow("64 hex chars");
    // Valid address should not throw
    new ContractCall("fn").argAddress("0x" + "ab".repeat(32));
  });

  test("argVecU64 builds correct layout", () => {
    const data = new ContractCall("fn").argVecU64([100, 200]).build();
    // 4 selector + 24 header + 16 elements = 44 bytes = 88 hex + 2 prefix
    expect(data.length).toBe(2 + 88);
  });

  test("argVecBool builds correct layout", () => {
    const data = new ContractCall("fn").argVecBool([true, false, true]).build();
    // 4 selector + 24 header + 24 elements = 52 bytes
    expect(data.length).toBe(2 + 104);
  });

  test("argVecAddress builds correct layout", () => {
    const addrs = ["0x" + "aa".repeat(32), "0x" + "bb".repeat(32)];
    const data = new ContractCall("fn").argVecAddress(addrs).build();
    // 4 selector + 24 header + 64 addresses = 92 bytes
    expect(data.length).toBe(2 + 184);
  });

  test("argVecOf with strings", () => {
    const data = new ContractCall("fn")
      .argVecOf(2, b => b.argString("hi").argString("yo"))
      .build();
    expect(data).toMatch(/^0x[0-9a-f]+$/);
  });

  test("argStruct builds with length prefix", () => {
    const data = new ContractCall("fn")
      .argStruct(s => s.argU64(42).argBool(true))
      .build();
    // 4 selector + 8 byte_len + 8 u64 + 8 bool = 28 bytes
    expect(data.length).toBe(2 + 56);
  });

  test("argTuple builds without length prefix", () => {
    const data = new ContractCall("fn")
      .argTuple(t => t.argU64(1).argU64(2))
      .build();
    // 4 selector + 8 + 8 = 20 bytes (no length prefix)
    expect(data.length).toBe(2 + 40);
  });

  test("nested Vec<Struct>", () => {
    const data = new ContractCall("fn")
      .argVecOf(2, b => b
        .argStruct(s => s.argString("alice").argU64(25))
        .argStruct(s => s.argString("bob").argU64(30)))
      .build();
    expect(data).toMatch(/^0x[0-9a-f]+$/);
  });
});

describe("DeployData", () => {
  test("build correct layout", () => {
    const data = new DeployData("0x010203", "0x04050607")
      .argU64(42)
      .build();
    // 0x + (8 header + 3 constructor + 4 runtime + 8 arg) * 2 hex = 2 + 46
    expect(data.length).toBe(2 + 46);
    // Check header: clen=3, rlen=4
    expect(data.slice(2, 10)).toBe("03000000"); // clen LE
    expect(data.slice(10, 18)).toBe("04000000"); // rlen LE
  });
});

describe("Decode", () => {
  test("decodeU64", () => {
    expect(decodeU64("0x2a00000000000000")).toBe(42n);
  });
  test("decodeI64 negative", () => {
    // -1 in i64 LE = ff ff ff ff ff ff ff ff
    expect(decodeI64("0x" + "ff".repeat(8))).toBe(-1n);
  });
  test("decodeU128", () => {
    // 1 as u128 LE
    expect(decodeU128("0x0100000000000000" + "00".repeat(8))).toBe(1n);
  });
  test("decodeI128 negative", () => {
    expect(decodeI128("0x" + "ff".repeat(16))).toBe(-1n);
  });
  test("decodeU256", () => {
    expect(decodeU256("0x0100000000000000" + "00".repeat(24))).toBe(1n);
  });
  test("decodeI256 negative", () => {
    expect(decodeI256("0x" + "ff".repeat(32))).toBe(-1n);
  });
  test("decodeBool", () => {
    expect(decodeBool("0x0100000000000000")).toBe(true);
    expect(decodeBool("0x0000000000000000")).toBe(false);
  });
  test("decodeAddress", () => {
    const addr = "0x" + "ab".repeat(32);
    expect(decodeAddress(addr)).toBe(addr);
  });
  test("decodeString", () => {
    expect(decodeString("0x050000000000000068656c6c6f")).toBe("hello");
  });
  test("decodeBytes", () => {
    const hex = "0x0300000000000000aabbcc";
    const result = decodeBytes(hex);
    expect(result.toString("hex")).toBe("aabbcc");
  });
});
