import {
  generateKeypair,
  deriveAddress,
  signMessage,
  verifySignature,
  computeSelector,
  hashTransaction,
  Wallet,
  ContractCall,
  decodeU64,
  decodeBool,
  decodeString,
} from "../src";

describe("Crypto", () => {
  test("generateKeypair returns valid keypair", () => {
    const kp = generateKeypair();
    expect(kp.address).toMatch(/^0x[0-9a-f]{64}$/);
    expect(kp.publicKey).toMatch(/^0x[0-9a-f]+$/);
    expect(kp.secretKey).toMatch(/^0x[0-9a-f]+$/);
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

  test("fromKeys restores same address", () => {
    const w1 = Wallet.generate();
    const w2 = Wallet.fromKeys(w1.publicKey, (w1 as any).secretKey);
    expect(w2.address).toBe(w1.address);
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

describe("ContractCall", () => {
  test("build with no args", () => {
    const data = new ContractCall("increment").build();
    expect(data).toMatch(/^0x[0-9a-f]{8}$/); // just selector
  });

  test("build with u64 arg", () => {
    const data = new ContractCall("deposit").argU64(500).build();
    // 4 selector + 8 arg = 12 bytes = 24 hex + "0x"
    expect(data.length).toBe(2 + 24);
  });

  test("build with string arg", () => {
    const data = new ContractCall("set_name").argString("hello").build();
    // 4 selector + 8 len + 8 data(5+3pad) = 20 bytes = 40 hex + "0x"
    expect(data.length).toBe(2 + 40);
  });
});

describe("Decode", () => {
  test("decodeU64", () => {
    // 42 as u64 LE
    const hex = "0x2a00000000000000";
    expect(decodeU64(hex)).toBe(42n);
  });

  test("decodeBool true", () => {
    expect(decodeBool("0x0100000000000000")).toBe(true);
  });

  test("decodeBool false", () => {
    expect(decodeBool("0x0000000000000000")).toBe(false);
  });

  test("decodeString", () => {
    // len=5 + "hello"
    const hex = "0x050000000000000068656c6c6f";
    expect(decodeString(hex)).toBe("hello");
  });
});
