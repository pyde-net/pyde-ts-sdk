import { Provider } from "./provider";
import type { TxFields } from "./types";

/**
 * Abstract signer interface. Wallet implements this.
 * Extend this to build hardware wallets, remote signers, or custodial signers.
 *
 * ```ts
 * class LedgerSigner extends AbstractSigner {
 * get address() { return this.ledgerAddress; }
 * async signTransaction(tx: TxFields) { return this.ledger.sign(tx); }
 * async sign(messageHex: string) { return this.ledger.signMessage(messageHex); }
 * }
 * ```
 */
export abstract class AbstractSigner {
  abstract readonly address: string;
  protected _provider: Provider | null = null;

  /** Bind a provider. */
  connect(provider: Provider): this {
    this._provider = provider;
    return this;
  }

  get provider(): Provider {
    if (!this._provider) throw new Error("No provider connected.");
    return this._provider;
  }

  /** Sign a transaction. Returns signed tx hex (wire format). */
  abstract signTransaction(tx: TxFields): string;

  /** Sign an arbitrary message. Returns signature hex. */
  abstract sign(messageHex: string): string;
}
