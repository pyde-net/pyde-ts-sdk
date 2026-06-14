# 07 — Wallet adapters

Dapps shouldn't import a specific wallet's SDK. Accept any `WalletAdapter` at runtime — the user's wallet provides one.

[← TOC](./README.md)

## The interface

```ts
interface WalletAdapter {
  readonly address: string | null;
  readonly publicKey: string | null;
  readonly connected: boolean;

  connect(): Promise<string>;              // returns address
  disconnect(): Promise<void>;

  signMessage(messageHex: string): Promise<string>;
  signTransaction(tx: TxFields): Promise<string>;
  sendTransaction(tx: TxFields, provider: Provider): Promise<Receipt>;

  on(event: "connect" | "disconnect" | "addressChange", listener: () => void): void;
  off(event: "connect" | "disconnect" | "addressChange", listener: () => void): void;
}
```

Dapp code:

```ts
import { type WalletAdapter } from "pyde-ts-sdk";

function connect(adapter: WalletAdapter) {
  await adapter.connect();
  adapter.on("addressChange", () => refetchAccount());
  return adapter;
}
```

## Two adapters in the box

### `InMemoryWalletAdapter`

```ts
import { InMemoryWalletAdapter, Wallet } from "pyde-ts-sdk";

const adapter = new InMemoryWalletAdapter(Wallet.generate());
await adapter.connect();
```

For backends, scripts, tests, CLI tools. Wraps a `Wallet` directly — no events, no external authority.

### `BrowserWalletAdapter`

```ts
import { BrowserWalletAdapter } from "pyde-ts-sdk";

const adapter = new BrowserWalletAdapter();
// Defaults to `window.pyde`. Pass an explicit namespace if needed:
// const adapter = new BrowserWalletAdapter({ namespace: "myWallet" });
```

Talks to an injected provider — the browser-extension pattern. The dapp never sees the secret key; signing happens in the wallet's process.

#### What `BrowserWalletAdapter` validates

When a wallet signs a transaction, the SDK does **not** trust the returned bytes blindly. After receiving a signed tx from the injected wallet, `BrowserWalletAdapter`:

1. Verifies the first 32 bytes of the wire tx (the `from` field) match the address the user expected to sign with.
2. Throws `SigningError("returned signed tx sender != requested sender")` if they differ.

This protects against a malicious wallet substituting a different sender. **Note: this is a partial defense** — full wallet-substitution protection would require decoding the wire signature against the expected public key. Full defense is queued behind a `pyde-crypto-wasm.decodeSignedTx` helper.

## Implementing a custom adapter

Community wallet SDKs ship a class implementing `WalletAdapter` directly. Skeleton:

```ts
import {
  type WalletAdapter,
  type WalletAdapterEvent,
  type EventListener,
  type TxFields,
  type Provider,
  type Receipt,
} from "pyde-ts-sdk";

export class MyWalletAdapter implements WalletAdapter {
  private _address: string | null = null;
  private listeners = new Map<WalletAdapterEvent, Set<EventListener>>();

  get address() { return this._address; }
  get publicKey() { return /* … */; }
  get connected() { return this._address !== null; }

  async connect(): Promise<string> {
    this._address = await /* … wallet flow … */;
    this.emit("connect");
    return this._address;
  }

  async disconnect(): Promise<void> {
    this._address = null;
    this.emit("disconnect");
  }

  async signMessage(messageHex: string): Promise<string> {
    return /* … forward to wallet … */;
  }

  async signTransaction(tx: TxFields): Promise<string> {
    return /* … forward to wallet, verify return … */;
  }

  async sendTransaction(tx: TxFields, provider: Provider): Promise<Receipt> {
    const signed = await this.signTransaction(tx);
    return provider.sendAndWait(signed);
  }

  on(event: WalletAdapterEvent, listener: EventListener) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(listener);
  }
  off(event: WalletAdapterEvent, listener: EventListener) {
    this.listeners.get(event)?.delete(listener);
  }
  private emit(event: WalletAdapterEvent) {
    this.listeners.get(event)?.forEach((fn) => fn());
  }
}
```

## Injected provider shape (`window.pyde`)

The contract `BrowserWalletAdapter` expects on `window.pyde`:

```ts
interface InjectedPydeProvider {
  address?: string;
  publicKey?: string;

  request(args: { method: "pyde_connect" }): Promise<string>;
  request(args: { method: "pyde_disconnect" }): Promise<void>;
  request(args: { method: "pyde_signMessage"; params: [string] }): Promise<string>;
  request(args: { method: "pyde_signTransaction"; params: [TxFields] }): Promise<string>;

  on(event: "connect" | "disconnect" | "addressChange", listener: () => void): void;
  off(event: "connect" | "disconnect" | "addressChange", listener: () => void): void;
}
```

This is the standard wallets target. Pyde wallets implementing this shape interoperate with any dapp using `BrowserWalletAdapter`.

## Gotchas

- **Adapters are stateful.** `connect()` mutates internal state, fires events. Don't construct one per render in React — hoist it.
- **`connect()` may prompt the user.** Treat it as a user-facing action; don't call it from a `useEffect` without intent.
- **`addressChange` fires when the user switches accounts in the wallet.** Re-fetch balance / nonce / account; do not assume the prior address still owns funds.
- **`InMemoryWalletAdapter` exposes the inner `Wallet`.** Treat it accordingly — it's strictly for trusted process contexts.
- **`BrowserWalletAdapter`'s sender-prefix check is a partial defense.** A malicious wallet could still substitute a different *signer* (same `from`, different SK) and fool downstream verification until pyde-crypto-wasm ships the full decoder.
