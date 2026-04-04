import { Provider } from "./provider";
import { Receipt, TxFields } from "./types";
import * as crypto from "./crypto";

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

  /** Export combined private key (pk + sk) as hex. */
  exportPrivateKey(): string {
    const pk = this.publicKey.startsWith("0x") ? this.publicKey.slice(2) : this.publicKey;
    const sk = this.secretKey.startsWith("0x") ? this.secretKey.slice(2) : this.secretKey;
    return "0x" + pk + sk;
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
