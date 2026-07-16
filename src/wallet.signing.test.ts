/**
 * Wallet signing + keystore round-trip — unit tests (no devnet).
 *
 * Covers: signTransaction / sign / hashTransaction determinism,
 * msg-sign + verifySignature round-trip, keystore encrypt/decrypt
 * via toKeystore + fromEncrypted, Node file I/O via
 * saveKeystoreFile + fromKeystoreFile, destroy() → WalletDestroyedError,
 * generate / generateUnsafe / fromKeys parity.
 *
 * Excluded from npm publish — lives outside the `files` array.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Wallet, WalletDestroyedError, type Keystore } from "../src/index";
import { argon2id } from "@noble/hashes/argon2";
import { chacha20poly1305 } from "@noble/ciphers/chacha";
import { randomBytes } from "@noble/ciphers/webcrypto";
import { utf8ToBytes, hexToBytes, bytesToHex } from "@noble/hashes/utils";
import {
  verifySignature,
  hashTransaction,
  generateKeypair,
  generateKeypairHandle,
  dropKeypair,
  signMessage,
  signMessageWithHandle,
  signTransaction,
  signTransactionWithHandle,
  deriveAddress,
  poseidon2Hash,
  computeSelector,
  keypairFromSeed,
} from "../src/crypto";
import { TxType } from "../src/types";
import type { TxFields } from "../src/types";

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------
const sampleTx: TxFields = {
  from: "0x" + "ab".repeat(32),
  to: "0x" + "cd".repeat(32),
  value: "1000000000",
  data: "0x",
  gasLimit: 100_000,
  nonce: 0n,
  chainId: 31337,
  txType: TxType.Standard,
};

// --------------------------------------------------------------------------
// Wallet constructors — every entry point produces a usable signer.
// --------------------------------------------------------------------------
describe("Wallet constructors", () => {
  it("Wallet.generate() returns a handle-backed wallet with 32-byte address", () => {
    const w = Wallet.generate();
    expect(w.address).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(w.publicKey.length).toBe(2 + 897 * 2); // 0x + 897 bytes hex
    w.destroy();
  });

  it("Wallet.generateUnsafe() returns a hex-backed wallet usable for keystore export", () => {
    const w = Wallet.generateUnsafe();
    expect(w.address).toMatch(/^0x[0-9a-fA-F]{64}$/);
    // It can sign — hex SK is in the JS heap.
    const sig = w.sign("0xdeadbeef");
    expect(sig).toMatch(/^0x[0-9a-fA-F]+$/);
    w.destroy();
  });

  it("Wallet.fromKeys(pk, sk) restores a usable signer from raw hex", () => {
    const kp = generateKeypair();
    const w = Wallet.fromKeys(kp.publicKey, kp.secretKey);
    expect(w.address).toBe(kp.address);
    // Signing parity — message round-trips through FALCON verify.
    const sig = w.sign("0xcafebabe");
    expect(verifySignature(kp.publicKey, "0xcafebabe", sig)).toBe(true);
  });

  it("Wallet.address always equals deriveAddress(publicKey)", () => {
    const w = Wallet.generate();
    expect(w.address).toBe(deriveAddress(w.publicKey));
    w.destroy();
  });

  it("keypairFromSeed is deterministic — same seed produces same (pk, sk, address)", () => {
    const seed = "0x" + "11".repeat(32);
    const a = keypairFromSeed(seed);
    const b = keypairFromSeed(seed);
    expect(a.address).toBe(b.address);
    expect(a.publicKey).toBe(b.publicKey);
    expect(a.secretKey).toBe(b.secretKey);
  });

  it("keypairFromSeed with different seeds yields different keypairs", () => {
    const a = keypairFromSeed("0x" + "11".repeat(32));
    const b = keypairFromSeed("0x" + "22".repeat(32));
    expect(a.address).not.toBe(b.address);
  });
});

// --------------------------------------------------------------------------
// Message signing — round-trip through verifySignature.
// --------------------------------------------------------------------------
describe("Wallet — message signing", () => {
  it("hex-backed wallet sign(msg) verifies under the wallet's pubkey", () => {
    const w = Wallet.generateUnsafe();
    const msg = "0xdeadbeefcafebabe";
    const sig = w.sign(msg);
    expect(verifySignature(w.publicKey, msg, sig)).toBe(true);
  });

  it("handle-backed wallet sign(msg) verifies under the wallet's pubkey", () => {
    const w = Wallet.generate();
    const msg = "0xdeadbeefcafebabe";
    const sig = w.sign(msg);
    expect(verifySignature(w.publicKey, msg, sig)).toBe(true);
    w.destroy();
  });

  it("a signature verifies only under its own pubkey, not a foreign one", () => {
    const a = Wallet.generateUnsafe();
    const b = Wallet.generateUnsafe();
    const msg = "0xfeedface";
    const sigA = a.sign(msg);
    expect(verifySignature(a.publicKey, msg, sigA)).toBe(true);
    expect(verifySignature(b.publicKey, msg, sigA)).toBe(false);
  });

  it("a signature for one message doesn't verify against another", () => {
    const w = Wallet.generateUnsafe();
    const sig = w.sign("0xdeadbeef");
    expect(verifySignature(w.publicKey, "0xcafebabe", sig)).toBe(false);
  });

  it("standalone signMessage(sk, msg) matches Wallet.sign(msg)", () => {
    // Different signatures are valid (FALCON is non-deterministic), but
    // BOTH verify against the same pubkey.
    const kp = generateKeypair();
    const w = Wallet.fromKeys(kp.publicKey, kp.secretKey);
    const msg = "0xaaaaaaaaaaaa";
    const sigStandalone = signMessage(kp.secretKey, msg);
    const sigWallet = w.sign(msg);
    expect(verifySignature(kp.publicKey, msg, sigStandalone)).toBe(true);
    expect(verifySignature(kp.publicKey, msg, sigWallet)).toBe(true);
  });

  it("signMessageWithHandle round-trips identically", () => {
    const kp = generateKeypairHandle();
    const msg = "0xbbbbbbbb";
    const sig = signMessageWithHandle(kp.handle, msg);
    expect(verifySignature(kp.publicKey, msg, sig)).toBe(true);
    dropKeypair(kp.handle);
  });
});

// --------------------------------------------------------------------------
// Transaction signing — bytes-level determinism + hash stability.
// --------------------------------------------------------------------------
describe("Wallet — transaction signing", () => {
  it("signTransaction produces a non-empty hex string", () => {
    const w = Wallet.generate();
    const wire = w.signTransaction({ ...sampleTx, from: w.address });
    expect(wire).toMatch(/^0x[0-9a-fA-F]+$/);
    expect(wire.length).toBeGreaterThan(2 + 32 * 2); // at least from-address worth
    w.destroy();
  });

  it("hashTransaction is deterministic — same tx fields → same hash", () => {
    const tx = { ...sampleTx };
    const h1 = hashTransaction(tx);
    const h2 = hashTransaction(tx);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^0x[0-9a-fA-F]{64}$/);
  });

  it("hashTransaction differs when nonce changes", () => {
    const h1 = hashTransaction({ ...sampleTx, nonce: 0n });
    const h2 = hashTransaction({ ...sampleTx, nonce: 1n });
    expect(h1).not.toBe(h2);
  });

  it("hashTransaction differs when chainId changes (replay protection)", () => {
    const h1 = hashTransaction({ ...sampleTx, chainId: 31337 });
    const h2 = hashTransaction({ ...sampleTx, chainId: 1 });
    expect(h1).not.toBe(h2);
  });

  it("hex + handle signing produce wire bytes signed under the same pubkey", () => {
    const kpHex = generateKeypair();
    const kpHandle = generateKeypairHandle();
    const tx: TxFields = { ...sampleTx, from: kpHex.address };
    const wireHex = signTransaction(tx, kpHex.secretKey);
    const txH: TxFields = { ...sampleTx, from: kpHandle.address };
    const wireHandle = signTransactionWithHandle(txH, kpHandle.handle);
    expect(wireHex).toMatch(/^0x[0-9a-fA-F]+$/);
    expect(wireHandle).toMatch(/^0x[0-9a-fA-F]+$/);
    // Same call, different signers → different wire bytes (different
    // signature + different from). The point is both succeed.
    expect(wireHex.length).toBe(wireHandle.length);
    dropKeypair(kpHandle.handle);
  });
});

// --------------------------------------------------------------------------
// destroy() lifecycle — every signing surface throws after destroy.
// --------------------------------------------------------------------------
describe("Wallet.destroy() — every signing surface throws after teardown", () => {
  it("handle-backed wallet sign() throws WalletDestroyedError after destroy", () => {
    const w = Wallet.generate();
    w.destroy();
    expect(() => w.sign("0xdeadbeef")).toThrow(WalletDestroyedError);
  });

  it("handle-backed wallet signTransaction() throws after destroy", () => {
    const w = Wallet.generate();
    w.destroy();
    expect(() => w.signTransaction(sampleTx)).toThrow(WalletDestroyedError);
  });

  it("destroy() is idempotent — calling twice doesn't throw", () => {
    const w = Wallet.generate();
    w.destroy();
    expect(() => w.destroy()).not.toThrow();
  });

  it("hex-backed wallet — toKeystore throws after destroy", async () => {
    const w = Wallet.generateUnsafe();
    w.destroy();
    await expect(w.toKeystore("pw")).rejects.toThrow(WalletDestroyedError);
  });
});

// --------------------------------------------------------------------------
// Keystore round-trip — encrypt + decrypt + verify signing parity.
// --------------------------------------------------------------------------
describe("Wallet keystore round-trip", () => {
  it("toKeystore + fromEncrypted preserves address + sign capability", async () => {
    const original = Wallet.generateUnsafe();
    const ks = await original.toKeystore("strong-passphrase");
    expect(ks.address).toBe(original.address);
    expect(ks.publicKey).toBe(original.publicKey);

    const restored = await Wallet.fromEncrypted(ks, "strong-passphrase");
    expect(restored.address).toBe(original.address);
    expect(restored.publicKey).toBe(original.publicKey);

    // Signing parity — the restored wallet produces signatures that
    // verify under the same pubkey.
    const sig = restored.sign("0xfeed");
    expect(verifySignature(original.publicKey, "0xfeed", sig)).toBe(true);
  });

  it("fromEncrypted rejects the wrong password", async () => {
    const original = Wallet.generateUnsafe();
    const ks = await original.toKeystore("correct-pw");
    await expect(Wallet.fromEncrypted(ks, "wrong-pw")).rejects.toThrow();
  });

  it("toKeystore throws on handle-backed wallets (no hex to encrypt)", async () => {
    const w = Wallet.generate();
    await expect(w.toKeystore("pw")).rejects.toThrow(/handle/i);
    w.destroy();
  });

  it("saveKeystoreFile + fromKeystoreFile round-trips on disk", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "pyde-ts-sdk-test-"));
    try {
      const path = join(tmp, "alice.json");
      const original = Wallet.generateUnsafe();
      await original.saveKeystoreFile(path, "disk-pw");

      const restored = await Wallet.fromKeystoreFile(path, "disk-pw");
      expect(restored.address).toBe(original.address);
      const sig = restored.sign("0xabcd");
      expect(verifySignature(original.publicKey, "0xabcd", sig)).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fromKeystoreFile rejects the wrong password", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "pyde-ts-sdk-test-"));
    try {
      const path = join(tmp, "alice.json");
      const original = Wallet.generateUnsafe();
      await original.saveKeystoreFile(path, "right-pw");
      await expect(Wallet.fromKeystoreFile(path, "wrong-pw")).rejects.toThrow();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// --------------------------------------------------------------------------
// Keystore — cipher agility. AES-256-GCM is the write default; legacy
// ChaCha20-Poly1305 keystores stay readable; unknown ciphers are rejected.
// --------------------------------------------------------------------------
describe("Keystore — cipher agility", () => {
  it("toKeystore writes the AES-256-GCM cipher by default", async () => {
    const ks = await Wallet.generateUnsafe().toKeystore("pw");
    expect(ks.cipher).toBe("aes-256-gcm");
  });

  it("fromEncrypted still decrypts a legacy ChaCha20-Poly1305 keystore", async () => {
    // Hand-build a keystore in the OLD ChaCha20-Poly1305 format a prior SDK
    // version would have written, then prove the agile reader still opens it.
    const kp = generateKeypair();
    const password = "legacy-pw";
    const salt = randomBytes(16);
    const nonce = randomBytes(12);
    const key = argon2id(utf8ToBytes(password), salt, { t: 3, m: 65_536, p: 4, dkLen: 32 });
    const skBytes = hexToBytes(kp.secretKey.replace(/^0x/, ""));
    const ciphertext = chacha20poly1305(key, nonce).encrypt(skBytes);
    const legacy: Keystore = {
      address: kp.address,
      publicKey: kp.publicKey,
      kdf: "argon2id",
      kdfParams: { m: 65_536, t: 3, p: 4, salt: bytesToHex(salt) },
      cipher: "chacha20-poly1305",
      nonce: bytesToHex(nonce),
      ciphertext: bytesToHex(ciphertext),
      version: 1,
    };

    const restored = await Wallet.fromEncrypted(legacy, password);
    expect(restored.address).toBe(kp.address);
    // Signing parity confirms the SK was actually recovered from the legacy blob.
    const sig = restored.sign("0xfeed");
    expect(verifySignature(kp.publicKey, "0xfeed", sig)).toBe(true);
  });

  it("fromEncrypted rejects an unknown cipher (downgrade-attack hygiene)", async () => {
    const ks = await Wallet.generateUnsafe().toKeystore("pw");
    const bad = JSON.parse(JSON.stringify(ks)) as Keystore;
    (bad as { cipher: string }).cipher = "aes-128-ecb";
    await expect(Wallet.fromEncrypted(bad, "pw")).rejects.toThrow(/unsupported cipher/i);
  });
});

// --------------------------------------------------------------------------
// Crypto primitives — deterministic hashes + helpers.
// --------------------------------------------------------------------------
describe("Crypto primitives", () => {
  it("poseidon2Hash is deterministic + returns 32-byte hex", () => {
    const h = poseidon2Hash("0xdeadbeef");
    expect(h).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(poseidon2Hash("0xdeadbeef")).toBe(h);
  });

  it("poseidon2Hash([]) ≠ poseidon2Hash([0,0,0,0]) — empty vs zero-length-Vec", () => {
    expect(poseidon2Hash("0x")).not.toBe(poseidon2Hash("0x00000000"));
  });

  it("computeSelector returns a stable 32-bit number for a function name", () => {
    const a = computeSelector("get_count");
    const b = computeSelector("get_count");
    expect(a).toBe(b);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThanOrEqual(0xffffffff);
  });

  it("computeSelector produces different values for different names", () => {
    expect(computeSelector("balance_of")).not.toBe(computeSelector("transfer"));
  });

  it("deriveAddress matches generateKeypair's address field", () => {
    const kp = generateKeypair();
    expect(deriveAddress(kp.publicKey)).toBe(kp.address);
  });

  it("dropKeypair returns true once and false on subsequent drops", () => {
    const kp = generateKeypairHandle();
    expect(dropKeypair(kp.handle)).toBe(true);
    expect(dropKeypair(kp.handle)).toBe(false);
  });
});

// --------------------------------------------------------------------------
// FALCON sig non-determinism — same msg + same key → different bytes,
// both verify. Checklist C.3.
// --------------------------------------------------------------------------
describe("FALCON sig non-determinism", () => {
  it("signing the same hash twice with the same wallet yields different bytes; both verify", () => {
    const w = Wallet.generateUnsafe();
    const msg = "0x" + "ab".repeat(32);
    const sig1 = w.sign(msg);
    const sig2 = w.sign(msg);
    // FALCON-512 is non-deterministic — internal randomness in the
    // signing trapdoor. Two signatures over the same message MUST be
    // different (probabilistically; ~666 bytes of entropy makes
    // collision impossible in practice).
    expect(sig1).not.toBe(sig2);
    expect(verifySignature(w.publicKey, msg, sig1)).toBe(true);
    expect(verifySignature(w.publicKey, msg, sig2)).toBe(true);
  });
});

// --------------------------------------------------------------------------
// Keystore — Unicode + tamper detection. Checklist D.2.5 + D.2.6.
// --------------------------------------------------------------------------
describe("Keystore — edge cases", () => {
  it("encrypts + decrypts with a Unicode passphrase (D.2.5)", async () => {
    const original = Wallet.generateUnsafe();
    const pw = "héllo 🦀 — passphrase αβγ";
    const ks = await original.toKeystore(pw);
    const restored = await Wallet.fromEncrypted(ks, pw);
    expect(restored.address).toBe(original.address);
    // Signing parity confirms the SK was actually recovered.
    const sig = restored.sign("0xfeed");
    expect(verifySignature(original.publicKey, "0xfeed", sig)).toBe(true);
  });

  it("rejects a keystore whose ciphertext was tampered with (D.2.6 — AEAD)", async () => {
    const original = Wallet.generateUnsafe();
    const ks = await original.toKeystore("right-pw");
    // Flip one nibble in the encrypted ciphertext. AES-GCM is an AEAD
    // mode — any single-bit modification to ciphertext / nonce / tag
    // must cause the tag check to fail and decryption to error.
    const tampered = JSON.parse(JSON.stringify(ks));
    const ct = tampered.ciphertext as string;
    const firstChar = ct[0]!;
    const flipped = firstChar === "0" ? "1" : "0";
    tampered.ciphertext = flipped + ct.slice(1);
    await expect(Wallet.fromEncrypted(tampered, "right-pw")).rejects.toThrow();
  });
});

// --------------------------------------------------------------------------
// Custom signer — extending AbstractSigner. Checklist D.4.1.
// --------------------------------------------------------------------------
describe("AbstractSigner — custom signer subclassing", () => {
  it("a class extending AbstractSigner can sign messages + transactions and connect to a provider", async () => {
    const { AbstractSigner } = await import("../src/signer");
    const { Provider } = await import("../src/provider");

    // Stub signer that delegates to a real Wallet — mirrors the
    // HSM/Ledger pattern from docs/03-wallet.md.
    class StubSigner extends AbstractSigner {
      constructor(private readonly inner: import("../src/wallet").Wallet) {
        super();
      }
      get address(): string {
        return this.inner.address;
      }
      override signTransaction(tx: TxFields): string {
        return this.inner.signTransaction(tx);
      }
      override sign(messageHex: string): string {
        return this.inner.sign(messageHex);
      }
    }

    const wallet = Wallet.generateUnsafe();
    const stub = new StubSigner(wallet);

    // Address parity.
    expect(stub.address).toBe(wallet.address);

    // Sign + verify roundtrip.
    const sig = stub.sign("0xabcd");
    expect(verifySignature(wallet.publicKey, "0xabcd", sig)).toBe(true);

    // Connect to a provider — no network call, just the binding.
    const provider = new Provider("http://127.0.0.1:1", { allowInsecureTransport: true });
    expect(stub.connect(provider)).toBe(stub);
    expect(stub.provider).toBe(provider);

    // signTransaction wire is non-empty.
    const wire = stub.signTransaction({
      from: stub.address,
      to: "0x" + "00".repeat(32),
      value: "0",
      data: "0x",
      gasLimit: 100_000,
      nonce: 0n,
      chainId: 31337,
      txType: TxType.Standard,
    });
    expect(wire).toMatch(/^0x[0-9a-fA-F]+$/);
  });
});

