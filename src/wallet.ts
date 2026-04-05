import { Provider } from "./provider";
import { Receipt, TxFields } from "./types";
import * as crypto from "./crypto";
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "fs";
import { dirname } from "path";

/** Encrypted keystore format (JSON file). Cross-compatible with Rust SDK. */
export interface Keystore {
  address: string;
  public_key: string;
  encrypted_secret_key: string;
  salt: string;
  nonce: string;
  version: number;
}

/** FALCON-512 wallet for signing transactions. */
export class Wallet {
  readonly address: string;
  readonly publicKey: string;
  private secretKey: string;

  private constructor(address: string, publicKey: string, secretKey: string) {
    this.address = address;
    this.publicKey = publicKey;
    this.secretKey = secretKey;
  }

  /** Generate a new random wallet. */
  static generate(): Wallet {
    const kp = crypto.generateKeypair();
    return new Wallet(kp.address, kp.publicKey, kp.secretKey);
  }

  /** Create from existing keys. */
  static fromKeys(publicKey: string, secretKey: string): Wallet {
    const address = crypto.deriveAddress(publicKey);
    return new Wallet(address, publicKey, secretKey);
  }

  /** Create from combined private key hex (pk + sk concatenated). */
  static fromPrivateKey(privateKeyHex: string): Wallet {
    const hex = privateKeyHex.startsWith("0x") ? privateKeyHex.slice(2) : privateKeyHex;
    // FALCON: pk = 897 bytes (1794 hex), sk = 1281 bytes (2562 hex)
    if (hex.length !== (897 + 1281) * 2) {
      throw new Error(`Invalid private key length: expected ${(897 + 1281) * 2} hex chars, got ${hex.length}`);
    }
    const publicKey = "0x" + hex.slice(0, 897 * 2);
    const secretKey = "0x" + hex.slice(897 * 2);
    const address = crypto.deriveAddress(publicKey);
    return new Wallet(address, publicKey, secretKey);
  }

  /** Create from an encrypted Keystore object (already in memory). */
  static fromEncrypted(keystore: Keystore, password: string): Wallet {
    const sk = decryptKey(keystore, password);
    const address = crypto.deriveAddress(keystore.public_key);
    return new Wallet(address, keystore.public_key, sk);
  }

  /** Load a wallet from an encrypted keystore JSON file. */
  static fromKeystore(path: string, password: string): Wallet {
    const content = readFileSync(path, "utf-8");
    const keystore: Keystore = JSON.parse(content);
    return Wallet.fromEncrypted(keystore, password);
  }

  /** Generate a new wallet and save encrypted to a file. */
  static createEncrypted(path: string, password: string): Wallet {
    const wallet = Wallet.generate();
    const keystore = wallet.toKeystore(password);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(keystore, null, 2));
    try { chmodSync(path, 0o600); } catch { /* non-unix */ }
    return wallet;
  }

  /** Export combined private key (pk + sk) as hex. */
  exportPrivateKey(): string {
    const pk = this.publicKey.startsWith("0x") ? this.publicKey.slice(2) : this.publicKey;
    const sk = this.secretKey.startsWith("0x") ? this.secretKey.slice(2) : this.secretKey;
    return "0x" + pk + sk;
  }

  /** Export wallet as encrypted Keystore object. */
  toKeystore(password: string): Keystore {
    return encryptKeystore(this.publicKey, this.secretKey, this.address, password);
  }

  /** Export wallet as encrypted keystore and save to a file. */
  saveKeystore(path: string, password: string): void {
    const keystore = this.toKeystore(password);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(keystore, null, 2));
    try { chmodSync(path, 0o600); } catch { /* non-unix */ }
  }

  /** Sign a transaction. Returns signed tx hex (wire format). */
  signTransaction(tx: TxFields): string {
    return crypto.signTransaction(tx, this.secretKey);
  }

  /** Compute tx hash without signing. */
  hashTransaction(tx: TxFields): string {
    return crypto.hashTransaction(tx);
  }

  /** Sign arbitrary message. Returns signature hex. */
  sign(messageHex: string): string {
    return crypto.signMessage(this.secretKey, messageHex);
  }

  // ========================================================================
  // High-level helpers
  // ========================================================================

  /** Build, sign, send a native transfer. Returns receipt. */
  async transfer(provider: Provider, to: string, amount: bigint | number): Promise<Receipt> {
    const nonce = await provider.getNonce(this.address);
    const chainId = await provider.getChainId();

    const tx: TxFields = {
      from: this.address,
      to,
      value: amount.toString(),
      data: "0x",
      gasLimit: 21000,
      nonce,
      chainId,
      txType: 0,
    };

    const signedHex = this.signTransaction(tx);
    return provider.sendAndWait(signedHex);
  }

  /** Build, sign, send a contract call. Returns receipt. */
  async sendCall(
    provider: Provider,
    to: string,
    data: string,
    gasLimit = 100_000_000
  ): Promise<Receipt> {
    const nonce = await provider.getNonce(this.address);
    const chainId = await provider.getChainId();

    const tx: TxFields = {
      from: this.address,
      to,
      value: "0",
      data,
      gasLimit,
      nonce,
      chainId,
      txType: 0,
    };

    const signedHex = this.signTransaction(tx);
    return provider.sendAndWait(signedHex);
  }

  /** Build, sign, send a contract deployment. Returns receipt. */
  async deploy(
    provider: Provider,
    deployData: string,
    gasLimit = 100_000_000
  ): Promise<Receipt> {
    const nonce = await provider.getNonce(this.address);
    const chainId = await provider.getChainId();

    const tx: TxFields = {
      from: this.address,
      to: "0x" + "00".repeat(32),
      value: "0",
      data: deployData,
      gasLimit,
      nonce,
      chainId,
      txType: 1, // Deploy
    };

    const signedHex = this.signTransaction(tx);
    return provider.sendAndWait(signedHex);
  }
}

// ============================================================================
// Encryption (AES-256-GCM + Poseidon2 key derivation)
// Compatible with the Rust SDK keystore format.
// ============================================================================

function hexToBytes(hex: string): Buffer {
  return Buffer.from(hex.startsWith("0x") ? hex.slice(2) : hex, "hex");
}

function bytesToHex(buf: Buffer): string {
  return "0x" + buf.toString("hex");
}

function deriveAesKey(password: string, salt: Buffer): Buffer {
  const passBytes = Buffer.from(password, "utf-8");
  const combined = Buffer.concat([passBytes, salt]);
  const hashHex = crypto.poseidon2Hash(bytesToHex(combined));
  return hexToBytes(hashHex);
}

function encryptKeystore(
  publicKey: string,
  secretKey: string,
  address: string,
  password: string,
): Keystore {
  const salt = randomBytes(16);
  const nonceBytes = randomBytes(12);
  const aesKey = deriveAesKey(password, salt);

  const cipher = createCipheriv("aes-256-gcm", aesKey, nonceBytes);
  const skBuf = hexToBytes(secretKey);
  const encrypted = Buffer.concat([cipher.update(skBuf), cipher.final()]);
  const tag = cipher.getAuthTag(); // 16 bytes
  const ciphertext = Buffer.concat([encrypted, tag]);

  return {
    address,
    public_key: publicKey,
    encrypted_secret_key: bytesToHex(ciphertext),
    salt: bytesToHex(salt),
    nonce: bytesToHex(nonceBytes),
    version: 1,
  };
}

function decryptKey(keystore: Keystore, password: string): string {
  const salt = hexToBytes(keystore.salt);
  const nonceBytes = hexToBytes(keystore.nonce);
  const ciphertext = hexToBytes(keystore.encrypted_secret_key);

  if (nonceBytes.length !== 12) {
    throw new Error("bad nonce length");
  }

  const aesKey = deriveAesKey(password, salt);

  // Last 16 bytes = GCM auth tag
  const encrypted = ciphertext.subarray(0, ciphertext.length - 16);
  const tag = ciphertext.subarray(ciphertext.length - 16);

  const decipher = createDecipheriv("aes-256-gcm", aesKey, nonceBytes);
  decipher.setAuthTag(tag);

  let decrypted: Buffer;
  try {
    decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  } catch {
    throw new Error("decryption failed — wrong password?");
  }

  return bytesToHex(decrypted);
}
