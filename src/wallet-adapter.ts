/**
 * Wallet adapter pattern — common interface for plugging external
 * wallets (browser extensions, hardware, MPC, custodial) into a dapp.
 *
 * Why an adapter pattern? Dapps shouldn't import a specific wallet's
 * SDK. They import the adapter interface from `pyde-ts-sdk` and accept
 * any adapter implementation at runtime. Each wallet ships its own
 * adapter under its own package, the dapp picks one at startup, and
 * the rest of the app code doesn't know which wallet it's talking to.
 *
 * Shape inspired by @solana/wallet-adapter and the wagmi connectors
 * pattern — battle-tested across the Ethereum / Solana ecosystems.
 *
 * What ships here:
 *   - `WalletAdapter` — the canonical interface community adapters
 *     implement.
 *   - `WalletAdapterEvents` + `EventListener` types.
 *   - `InMemoryWalletAdapter` — wraps the SDK's `Wallet` class. Use in
 *     scripts, tests, and Node services.
 *   - `BrowserWalletAdapter` — generic adapter that talks to a
 *     `window.pyde` provider injected by a browser extension. Useful
 *     scaffolding for community wallets following the convention.
 */

import type { Provider } from "./provider";
import type { Receipt, TxFields, TransactionResponse } from "./types";
import type { Wallet } from "./wallet";
import { SigningError } from "./errors";

// ============================================================================
// Adapter interface
// ============================================================================

export type WalletAdapterEvent = "connect" | "disconnect" | "addressChange";
export type EventListener = () => void;

/** Common surface a wallet adapter exposes to dapps. */
export interface WalletAdapter {
  /** Adapter identifier — `"in-memory"`, `"metamask-pyde"`, `"phantom-pyde"`. */
  readonly name: string;
  /** True once a wallet is bound + ready to sign. */
  readonly connected: boolean;
  /** Bound address, or null when disconnected. */
  readonly address: string | null;

  /** Connect / unlock the wallet. May prompt the user. Returns the bound address. */
  connect(): Promise<string>;
  /** Disconnect cleanly. */
  disconnect(): Promise<void>;

  /** Sign a message (returns FALCON sig hex). */
  signMessage(messageHex: string): Promise<string>;
  /** Sign a transaction (returns wire-encoded signed tx hex). */
  signTransaction(tx: TxFields): Promise<string>;
  /** Convenience: sign + submit via the given provider. Awaits the receipt. */
  sendTransaction(tx: TxFields, provider: Provider): Promise<Receipt>;

  /** Subscribe to adapter events. */
  on(event: WalletAdapterEvent, listener: EventListener): void;
  /** Unsubscribe. */
  off(event: WalletAdapterEvent, listener: EventListener): void;
}

// ============================================================================
// Event emitter — minimal, used by both built-in adapters
// ============================================================================

class Emitter {
  private listeners = new Map<WalletAdapterEvent, Set<EventListener>>();

  on(event: WalletAdapterEvent, listener: EventListener): void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
  }

  off(event: WalletAdapterEvent, listener: EventListener): void {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event: WalletAdapterEvent): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const l of set) {
      try {
        l();
      } catch {
        // Listener errors should not break other subscribers.
      }
    }
  }
}

// ============================================================================
// InMemoryWalletAdapter
// ============================================================================

/**
 * Reference adapter — wraps the SDK's `Wallet` class directly. Use in
 * Node services, scripts, integration tests, and any context where the
 * key material is held in-process.
 *
 * ```ts
 * const wallet = Wallet.generate();
 * const adapter = new InMemoryWalletAdapter(wallet);
 * await adapter.connect();
 * await adapter.signTransaction(tx);
 * ```
 */
export class InMemoryWalletAdapter implements WalletAdapter {
  readonly name = "in-memory";
  private emitter = new Emitter();
  private wallet: Wallet | null;
  private _connected = false;

  constructor(wallet: Wallet) {
    this.wallet = wallet;
  }

  get connected(): boolean {
    return this._connected;
  }

  get address(): string | null {
    return this._connected ? (this.wallet?.address ?? null) : null;
  }

  async connect(): Promise<string> {
    if (!this.wallet) throw new SigningError("InMemoryWalletAdapter: wallet was destroyed");
    this._connected = true;
    this.emitter.emit("connect");
    return this.wallet.address;
  }

  async disconnect(): Promise<void> {
    this._connected = false;
    this.emitter.emit("disconnect");
  }

  async signMessage(messageHex: string): Promise<string> {
    return this.requireWallet().sign(messageHex);
  }

  async signTransaction(tx: TxFields): Promise<string> {
    return this.requireWallet().signTransaction(tx);
  }

  async sendTransaction(tx: TxFields, provider: Provider): Promise<Receipt> {
    const signed = await this.signTransaction(tx);
    return provider.sendAndWait(signed);
  }

  on(event: WalletAdapterEvent, listener: EventListener): void {
    this.emitter.on(event, listener);
  }

  off(event: WalletAdapterEvent, listener: EventListener): void {
    this.emitter.off(event, listener);
  }

  private requireWallet(): Wallet {
    if (!this.wallet || !this._connected) {
      throw new SigningError("InMemoryWalletAdapter: not connected");
    }
    return this.wallet;
  }
}

// ============================================================================
// BrowserWalletAdapter
// ============================================================================

/**
 * The shape an injected provider on `window.pyde` (or similar) must
 * implement to plug into `BrowserWalletAdapter`. Community wallets pick
 * a namespace under `window` and expose this surface.
 */
export interface InjectedPydeProvider {
  /** Prompt the user to connect; return the bound address. */
  request(args: { method: "pyde_connect" }): Promise<string>;
  /** Disconnect cleanly. */
  request(args: { method: "pyde_disconnect" }): Promise<void>;
  /** Sign a message. */
  request(args: { method: "pyde_signMessage"; params: [string] }): Promise<string>;
  /** Sign a transaction (wallet may transform / canonicalise before signing). */
  request(args: { method: "pyde_signTransaction"; params: [TxFields] }): Promise<string>;

  /** Subscribe to provider-level events (connection, address changes). */
  on(event: "connect" | "disconnect" | "addressChange", listener: () => void): void;
  off(event: "connect" | "disconnect" | "addressChange", listener: () => void): void;
}

/**
 * Generic adapter for browser wallets that inject a provider object at
 * a known global. Defaults to `window.pyde`. Community wallets can use
 * this as-is or extend it with wallet-specific behaviour.
 *
 * ```ts
 * const adapter = new BrowserWalletAdapter();   // reads window.pyde
 * await adapter.connect();
 * ```
 */
export class BrowserWalletAdapter implements WalletAdapter {
  readonly name: string;
  private emitter = new Emitter();
  private injected: InjectedPydeProvider;
  private _address: string | null = null;

  constructor(options?: { name?: string; injected?: InjectedPydeProvider }) {
    this.name = options?.name ?? "browser";
    this.injected = options?.injected ?? defaultInjectedProvider();
    // Forward injected events through the adapter's emitter so dapp
    // UIs only need to subscribe to the adapter.
    this.injected.on("connect", () => this.emitter.emit("connect"));
    this.injected.on("disconnect", () => {
      this._address = null;
      this.emitter.emit("disconnect");
    });
    this.injected.on("addressChange", () => {
      // Address re-resolved on next access via connect(); for now flag
      // to listeners that something changed.
      this.emitter.emit("addressChange");
    });
  }

  get connected(): boolean {
    return this._address !== null;
  }

  get address(): string | null {
    return this._address;
  }

  async connect(): Promise<string> {
    const addr = await this.injected.request({ method: "pyde_connect" });
    this._address = addr;
    return addr;
  }

  async disconnect(): Promise<void> {
    await this.injected.request({ method: "pyde_disconnect" });
    this._address = null;
  }

  async signMessage(messageHex: string): Promise<string> {
    if (!this._address) throw new SigningError("BrowserWalletAdapter: not connected");
    return this.injected.request({ method: "pyde_signMessage", params: [messageHex] });
  }

  async signTransaction(tx: TxFields): Promise<string> {
    if (!this._address) throw new SigningError("BrowserWalletAdapter: not connected");
    if (tx.from.toLowerCase() !== this._address.toLowerCase()) {
      throw new SigningError(
        `BrowserWalletAdapter: tx.from (${tx.from}) does not match connected address (${this._address})`,
      );
    }
    const signed = await this.injected.request({ method: "pyde_signTransaction", params: [tx] });
    // Defense-in-depth: a malicious or buggy injected provider could
    // return a signed tx for a different sender. The wire format starts
    // with the sender's 32-byte address; verify those bytes match what
    // we asked for before forwarding to the chain. Full (to / value /
    // data / nonce) verification needs pyde-crypto-wasm to expose a
    // decoder — tracked separately. The sender check catches the most
    // common substitution attack today.
    assertSignedSenderMatches(signed, this._address);
    return signed;
  }

  async sendTransaction(tx: TxFields, provider: Provider): Promise<Receipt> {
    const signed = await this.signTransaction(tx);
    return provider.sendAndWait(signed);
  }

  on(event: WalletAdapterEvent, listener: EventListener): void {
    this.emitter.on(event, listener);
  }

  off(event: WalletAdapterEvent, listener: EventListener): void {
    this.emitter.off(event, listener);
  }
}

function assertSignedSenderMatches(signedHex: string, expectedAddress: string): void {
  const hex = signedHex.startsWith("0x") ? signedHex.slice(2) : signedHex;
  if (hex.length < 64) {
    throw new SigningError(
      `BrowserWalletAdapter: returned signed tx is too short to contain a sender (got ${hex.length / 2} bytes)`,
    );
  }
  const sender = "0x" + hex.slice(0, 64).toLowerCase();
  const expected = (
    expectedAddress.startsWith("0x") ? expectedAddress : "0x" + expectedAddress
  ).toLowerCase();
  if (sender !== expected) {
    throw new SigningError(
      `BrowserWalletAdapter: signed tx sender (${sender}) does not match connected wallet (${expected}). ` +
        `The injected provider may be malicious or buggy.`,
    );
  }
}

function defaultInjectedProvider(): InjectedPydeProvider {
  const g = globalThis as { pyde?: InjectedPydeProvider };
  if (!g.pyde) {
    throw new SigningError(
      "BrowserWalletAdapter: no `window.pyde` injected provider found. " +
        "Install a Pyde-compatible browser wallet or pass `options.injected` explicitly.",
    );
  }
  return g.pyde;
}

// ============================================================================
// Re-exports for compatibility with the TransactionResponse type
// ============================================================================

export type { TransactionResponse };
