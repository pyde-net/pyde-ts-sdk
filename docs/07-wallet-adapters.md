# 07 — Wallet adapters

Dapps shouldn't import a specific wallet's SDK. Accept any `WalletAdapter` at runtime — the user's wallet provides one.

[← TOC](./README.md)

---

## Table of contents

- [The interface](#the-interface)
- Two adapters in the box
  - [`InMemoryWalletAdapter`](#inmemorywalletadapter)
  - [`BrowserWalletAdapter`](#browserwalletadapter)
- [What `BrowserWalletAdapter` validates](#what-browserwalletadapter-validates)
- [Implementing a custom adapter](#implementing-a-custom-adapter)
- [Injected provider shape (`window.pyde`)](#injected-provider-shape-windowpyde)
- [Events](#events)
- [Gotchas](#gotchas)

---

## The interface

```ts
interface WalletAdapter {
  readonly name: string;
  readonly address: string | null;
  readonly connected: boolean;

  connect(): Promise<string>;
  disconnect(): Promise<void>;

  signMessage(messageHex: string): Promise<string>;
  signTransaction(tx: TxFields): Promise<string>;
  sendTransaction(tx: TxFields, provider: Provider): Promise<Receipt>;

  on(event: WalletAdapterEvent, listener: () => void): void;
  off(event: WalletAdapterEvent, listener: () => void): void;
}

type WalletAdapterEvent = "connect" | "disconnect" | "addressChange";
```

| Member                          | Type               | Description                                                      |
| ------------------------------- | ------------------ | ---------------------------------------------------------------- |
| `name`                          | `string`           | Adapter identifier, e.g. `"in-memory"`, `"browser"`.             |
| `address`                       | `string \| null`   | The connected address, or `null` before `connect()`.             |
| `connected`                     | `boolean`          | True iff a wallet is bound + ready to sign.                      |
| `connect()`                     | `Promise<string>`  | Initiates connection (may prompt UI). Resolves with the address. |
| `disconnect()`                  | `Promise<void>`    | Tear down the connection.                                        |
| `signMessage(hex)`              | `Promise<string>`  | Sign arbitrary bytes. Returns FALCON-512 signature hex.          |
| `signTransaction(tx)`           | `Promise<string>`  | Sign a tx. Returns wire-encoded signed tx hex.                   |
| `sendTransaction(tx, provider)` | `Promise<Receipt>` | Convenience — sign + submit + wait.                              |
| `on(event, listener)`           | `void`             | Subscribe to lifecycle events.                                   |
| `off(event, listener)`          | `void`             | Unsubscribe.                                                     |

Dapp code:

```ts
import { type WalletAdapter } from "pyde-ts-sdk";

async function connect(adapter: WalletAdapter): Promise<WalletAdapter> {
  await adapter.connect();
  adapter.on("addressChange", () => refetchAccount());
  return adapter;
}
```

---

## `InMemoryWalletAdapter`

```ts
import { InMemoryWalletAdapter, Wallet } from "pyde-ts-sdk";

const wallet = Wallet.generate();
const adapter = new InMemoryWalletAdapter(wallet);
```

For **backends, scripts, tests, CLI tools**. Wraps a `Wallet` directly — no events, no external authority.

**Constructor:**

```ts
new InMemoryWalletAdapter(wallet: Wallet)
```

**Example:**

```ts
const adapter = new InMemoryWalletAdapter(wallet);
await adapter.connect();
console.log("connected as:", adapter.address);

const receipt = await adapter.sendTransaction(tx, provider);
console.log("ok:", receipt.success);
```

**Expected output:**

```
connected as: 0x0cf4448bb99519a4aa04c7a5ee740483434f1b4bd234dc50e5032af30815e250
ok: true
```

**Notes:**

- `disconnect()` doesn't call `wallet.destroy()` — the caller controls the wallet's lifecycle.
- `addressChange` event never fires (the wallet is fixed).

---

## `BrowserWalletAdapter`

```ts
import { BrowserWalletAdapter } from "pyde-ts-sdk";

// Defaults to reading the provider from `window.pyde`.
const adapter = new BrowserWalletAdapter();

// Or pass a name + explicit injected provider (useful for tests
// or wallets that namespace under their own global):
// const adapter = new BrowserWalletAdapter({
//   name: "myWallet",
//   injected: (window as any).myWallet,
// });
```

Talks to an injected provider — the **browser-extension pattern**. The dapp never sees the secret key; signing happens in the wallet's process.

**Constructor:**

```ts
new BrowserWalletAdapter(options?: {
  name?: string;
  injected?: InjectedPydeProvider;
})
```

**Args:**

| Name       | Type                   | Default       | Description                                                                            |
| ---------- | ---------------------- | ------------- | -------------------------------------------------------------------------------------- |
| `name`     | `string`               | `"browser"`   | Identifier surfaced via `adapter.name`. Useful when multiple adapters coexist in a UI. |
| `injected` | `InjectedPydeProvider` | `window.pyde` | Explicit injected provider. When omitted, reads `globalThis.pyde`.                     |

**Example:**

```ts
const adapter = new BrowserWalletAdapter();

try {
  await adapter.connect(); // wallet UI pops here
} catch (e) {
  if (isError(e, "SIGNING_ERROR") && (e as Error).message.includes("user rejected")) {
    console.log("user cancelled");
    return;
  }
  throw e;
}

adapter.on("addressChange", () => location.reload());
adapter.on("disconnect", () => console.log("wallet disconnected"));

const receipt = await adapter.sendTransaction(tx, provider);
```

**Throws:**

- `SigningError("BrowserWalletAdapter: no \`window.pyde\` injected provider found. ...")`when no provider is on`window.pyde`and none was passed via`options.injected`.
- `SigningError` on user rejection or any signer failure.

---

## What `BrowserWalletAdapter` validates

When a wallet signs a transaction, the SDK does **not** trust the returned bytes blindly. After receiving a signed tx from the injected wallet, `BrowserWalletAdapter`:

1. Extracts the first 32 bytes of the wire tx (the `from` field).
2. Verifies they match the address the user expected to sign with.
3. Throws `SigningError("returned signed tx sender != requested sender")` if they differ.

**This protects against** a malicious wallet substituting a different sender.

**Partial defense — full wallet-substitution protection** would require decoding the wire signature against the expected public key. Full defense is queued behind a `pyde-crypto-wasm.decodeSignedTx` helper.

---

## Implementing a custom adapter

Community wallet SDKs ship a class implementing `WalletAdapter` directly. Skeleton:

```ts
import {
  type WalletAdapter,
  type WalletAdapterEvent,
  type TxFields,
  type Provider,
  type Receipt,
} from "pyde-ts-sdk";

type EventListener = () => void;

export class MyWalletAdapter implements WalletAdapter {
  readonly name = "my-wallet";
  private _address: string | null = null;
  private listeners = new Map<WalletAdapterEvent, Set<EventListener>>();

  get address() { return this._address; }
  get connected() { return this._address !== null; }

  async connect(): Promise<string> {
    const { address } = await /* … your wallet's auth flow … */;
    this._address = address;
    this.emit("connect");
    return address;
  }

  async disconnect(): Promise<void> {
    this._address = null;
    this.emit("disconnect");
  }

  async signMessage(messageHex: string): Promise<string> {
    return /* … forward to wallet, return sig hex … */;
  }

  async signTransaction(tx: TxFields): Promise<string> {
    if (!this._address) throw new Error("not connected");
    if (tx.from.toLowerCase() !== this._address.toLowerCase()) {
      throw new Error("from doesn't match adapter address");
    }
    const signed = await /* … forward to wallet … */;
    // Verify the wallet didn't substitute a different sender:
    const senderFromWire = "0x" + signed.slice(2, 2 + 64);
    if (senderFromWire.toLowerCase() !== this._address.toLowerCase()) {
      throw new Error("returned signed tx sender != requested sender");
    }
    return signed;
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

---

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

This is the **standard wallets target**. Pyde wallets implementing this shape interoperate with any dapp using `BrowserWalletAdapter`.

---

## Events

```ts
adapter.on("connect", () => {
  console.log("connected:", adapter.address);
});

adapter.on("disconnect", () => {
  console.log("disconnected");
});

adapter.on("addressChange", () => {
  console.log("user switched account; address is now:", adapter.address);
});
```

**Event semantics:**

| Event           | When                                                           | Receiver should                                                           |
| --------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `connect`       | After `connect()` resolves.                                    | Re-fetch balance / nonce / account.                                       |
| `disconnect`    | After `disconnect()` resolves OR the wallet drops the session. | Clear cached state, show "connect" UI.                                    |
| `addressChange` | User switches accounts in the wallet.                          | **Don't assume the prior address still owns funds.** Re-fetch everything. |

---

## Gotchas

- **Adapters are stateful.** `connect()` mutates internal state, fires events. Don't construct one per render in React — hoist it.
- **`connect()` may prompt the user.** Treat it as a user-facing action; don't call it from a `useEffect` without intent.
- **`addressChange` fires when the user switches accounts in the wallet.** Re-fetch balance / nonce / account; do not assume the prior address still owns funds.
- **`InMemoryWalletAdapter` exposes the inner `Wallet`.** Treat it accordingly — it's strictly for trusted process contexts.
- **`BrowserWalletAdapter`'s sender-prefix check is a partial defense.** A malicious wallet could still substitute a different _signer_ (same `from`, different SK) and fool downstream verification until pyde-crypto-wasm ships the full decoder.
- **No injected wallet exists yet.** `BrowserWalletAdapter` is ready; the ecosystem hasn't shipped a Pyde browser extension. Until then, use `InMemoryWalletAdapter` for testing.
