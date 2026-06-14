# 06 — React hooks

Optional React integration. Same RPC + signing surface as the rest of the SDK, exposed through hooks. SSR-safe — no `window` access during render.

[← TOC](./README.md)

---

## Table of contents

- [Install + setup](#install--setup)
- [`<PydeProvider>` — context root](#pydeprovider--context-root)
  - [Props reference](#props-reference)
- Escape hatches
  - [`usePydeProvider()`](#usepydeprovider)
  - [`usePydeWebSocket()`](#usepydewebsocket)
  - [`usePydeSigner()`](#usepydesigner)
- Read hooks
  - [`AsyncState<T>` — the read hook return shape](#asyncstatet--the-read-hook-return-shape)
  - [`useBalance(address)`](#usebalanceaddress)
  - [`useNonce(address)`](#usenonceaddress)
  - [`useAccount(address)`](#useaccountaddress)
  - [`useWave(waveId?)`](#usewavewaveid)
- Live subscriptions
  - [`useLiveWave()`](#uselivewave)
  - [`useEvents(filter)`](#useeventsfilter)
- Contract hooks
  - [`useContract(args)`](#usecontractargs)
- [SSR + cleanup](#ssr--cleanup)
- [Recipe — dapp skeleton](#recipe--dapp-skeleton)
- [Gotchas](#gotchas)

---

## Install + setup

The React surface is a **subpath export**:

```ts
import { PydeProvider, useBalance } from "pyde-ts-sdk/react";
```

`react` is a **peer dependency** (`>=18.0.0`). The main SDK doesn't pull it in.

```bash
npm install pyde-ts-sdk react
```

---

## `<PydeProvider>` — context root

Wrap your app:

```tsx
import { PydeProvider } from "pyde-ts-sdk/react";

function App() {
  return (
    <PydeProvider
      rpcUrl="https://rpc.pyde.network"
      wsUrl="wss://rpc.pyde.network"
    >
      <Dapp />
    </PydeProvider>
  );
}
```

### Props reference

```ts
interface PydeProviderProps {
  children: React.ReactNode;
  rpcUrl: string;
  wsUrl?: string;
  signer?: Wallet;
}
```

| Prop | Type | Required | Description |
|---|---|---|---|
| `children` | `ReactNode` | yes | Your app. |
| `rpcUrl` | `string` | yes | HTTPS RPC endpoint. `Provider` is constructed under the hood. |
| `wsUrl` | `string` | no | Optional WSS URL. If omitted, `useLiveWave` / `useEvents` fall back to polling over HTTP. |
| `signer` | `Wallet` | no | Optional bound wallet — surfaced via `usePydeSigner()`. |

**Notes:**
- `Provider` is reconstructed if `rpcUrl` changes between renders.
- `WebSocketProvider` is constructed in a `useEffect` (SSR-safe).

---

## `usePydeProvider()`

Get the raw `Provider`. Use when you need a method that doesn't have a dedicated hook.

**Signature:**

```ts
function usePydeProvider(): Provider
```

**Throws** when used outside `<PydeProvider>`.

**Example:**

```tsx
function CustomQuery() {
  const provider = usePydeProvider();
  const [code, setCode] = useState<string | null>(null);

  useEffect(() => {
    provider.getContractCode("0xcontract...").then(setCode);
  }, [provider]);

  return <pre>{code ?? "loading…"}</pre>;
}
```

---

## `usePydeWebSocket()`

Get the `WebSocketProvider` (or `null` if `wsUrl` wasn't passed).

**Signature:**

```ts
function usePydeWebSocket(): WebSocketProvider | null
```

**Example:**

```tsx
function CustomSub() {
  const ws = usePydeWebSocket();
  useEffect(() => {
    if (!ws) return;
    let unsub: () => void | undefined;
    ws.subscribeNewHeads((header) => console.log("wave", header.waveId)).then(
      (u) => { unsub = u; },
    );
    return () => unsub?.();
  }, [ws]);
  return null;
}
```

---

## `usePydeSigner()`

Get the `Wallet` (or `null` if `signer` wasn't passed).

**Signature:**

```ts
function usePydeSigner(): Wallet | null
```

---

## `AsyncState<T>` — the read hook return shape

All read hooks return:

```ts
interface AsyncState<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  refetch: () => Promise<T | null>;
}
```

| Field | Type | Description |
|---|---|---|
| `data` | `T \| null` | The fetched value or `null` (before initial load or on error). |
| `error` | `Error \| null` | Caught error from the fetch. |
| `loading` | `boolean` | `true` during in-flight fetch. |
| `refetch` | `() => Promise<T \| null>` | Manually re-run the fetcher. Returns the new value or throws. |

**Standard pattern:**

```tsx
function BalanceBox({ address }: { address: string }) {
  const { data: balance, loading, error, refetch } = useBalance(address);
  if (loading) return <span>loading…</span>;
  if (error) return <button onClick={() => refetch()}>retry</button>;
  return <span>{balance!.toString()} quanta</span>;
}
```

---

## `useBalance(address)`

Fetch and react-render an address's balance.

**Signature:**

```ts
function useBalance(address: string | undefined): AsyncState<bigint>
```

**Args:**

| Name | Type | Description |
|---|---|---|
| `address` | `string \| undefined` | Address to query. Pass `undefined` to skip the fetch (useful while a wallet is loading). |

**Returns:** `AsyncState<bigint>` — balance in quanta.

**Example:**

```tsx
function Balance() {
  const signer = usePydeSigner();
  const { data: balance, loading } = useBalance(signer?.address);
  if (loading || balance == null) return <span>—</span>;
  return <span>{formatQuanta(balance)} PYDE</span>;
}
```

**Re-runs when:** `address` changes, the bound provider changes.

---

## `useNonce(address)`

Fetch an address's nonce.

**Signature:**

```ts
function useNonce(address: string | undefined): AsyncState<bigint>
```

**Example:**

```tsx
const { data: nonce } = useNonce("0xabc...");
console.log(nonce);
// → 42n
```

---

## `useAccount(address)`

Fetch an address's full account record.

**Signature:**

```ts
function useAccount(address: string | undefined): AsyncState<Account | null>
```

**Returns:** `AsyncState<Account | null>` — `data` is the `Account` or `null` if not on chain.

**Example:**

```tsx
const { data: account, loading } = useAccount("0xabc...");

if (loading) return <p>loading…</p>;
if (!account) return <p>not registered</p>;
return (
  <ul>
    <li>nonce: {account.nonce.toString()}</li>
    <li>balance: {formatQuanta(account.balance)} PYDE</li>
  </ul>
);
```

---

## `useWave(waveId?)`

Fetch a specific wave header.

**Signature:**

```ts
function useWave(waveId?: Wave): AsyncState<WaveHeader | null>
```

**Args:**

| Name | Type | Description |
|---|---|---|
| `waveId` | `bigint` (optional) | Specific wave id. Omit for "latest" — currently engine-blocked. |

**Example:**

```tsx
const { data: header } = useWave(0n);
console.log(header?.anchor);
```

---

## `useLiveWave()`

Push-subscribe to new wave commits. Re-renders every wave.

**Signature:**

```ts
function useLiveWave(): WaveHeader | null
```

**Returns:** the latest `WaveHeader` (or `null` before the first commit arrives).

**Backing transport:**
- If `wsUrl` was passed to `<PydeProvider>`: subscribes via `WebSocketProvider.subscribeNewHeads`.
- Otherwise: polls `provider.getWave()` every ~2 s.

**Example:**

```tsx
function LiveWave() {
  const wave = useLiveWave();
  return <p>wave: {wave?.waveId?.toString() ?? "—"}</p>;
}
```

**Expected behavior:**

```
wave: 100
wave: 101
wave: 102
...
```

---

## `useEvents(filter)`

Subscribe to live event logs. Accumulates as they arrive.

**Signature:**

```ts
function useEvents(filter: LogSubscriptionFilter): Log[]
```

**`LogSubscriptionFilter`:**

```ts
interface LogSubscriptionFilter {
  topics?: (string[] | null)[]; // 4 positional slots, null = any
  contract?: string;
  from?: EventCursor; // resume cursor
}
```

**Returns:** `Log[]` — accumulating array.

**Example:**

```tsx
function TransferFeed({ token }: { token: Contract }) {
  const transferTopic = token.getEventTopic("Transfer");
  const logs = useEvents({
    contract: token.address,
    topics: [[transferTopic]],
  });

  return (
    <ul>
      {logs.map((log, i) => {
        const ev = token.parseLog(log);
        return (
          <li key={`${log.waveId}-${log.eventIndex}`}>
            {ev?.args.from} → {ev?.args.to}: {ev?.args.amount.toString()}
          </li>
        );
      })}
    </ul>
  );
}
```

**Backing transport:**
- If `wsUrl` was passed: WebSocket subscription.
- Otherwise: polls historical `getLogs`.

**Important — accumulates forever.** Pages with long sessions should reset state at a wave threshold to avoid unbounded growth.

---

## `useContract(args)`

Load an ABI + bind the current provider in one hook.

**Signature:**

```ts
function useContract(args: {
  abiJson: string;
  address: string;
}): { contract: Contract | null; ready: boolean; error: Error | null }
```

**Args:**

| Name | Type | Description |
|---|---|---|
| `abiJson` | `string` | Raw ABI JSON string. |
| `address` | `string` | Contract address. |

**Returns:**
- `contract` — `null` until `ready === true`.
- `ready` — `true` after ABI is parsed.
- `error` — populated if loading failed.

**If `usePydeSigner()` resolves a wallet**, the hook auto-binds it via `contract.connect(wallet)` so `contract.write(...)` works without further setup.

**Example:**

```tsx
import abiJson from "./counter.abi.json?raw";

function CounterUI() {
  const { contract, ready } = useContract({
    abiJson,
    address: "0xcontract...",
  });

  const [count, setCount] = useState<bigint | null>(null);

  useEffect(() => {
    if (!ready || !contract) return;
    contract.read("get_count").then(setCount);
  }, [ready, contract]);

  async function increment() {
    if (!contract) return;
    await contract.write("increment");
    const next = await contract.read("get_count");
    setCount(next);
  }

  return (
    <>
      <p>count: {count?.toString() ?? "—"}</p>
      <button onClick={increment}>+1</button>
    </>
  );
}
```

---

## SSR + cleanup

- `<PydeProvider>` never touches `window` during render.
- `WebSocketProvider` instantiation is deferred to a `useEffect`, so server-side renders don't crash on missing `WebSocket`.
- HTTP polling fallbacks also defer to `useEffect`.
- `<PydeProvider>` tears down the `WebSocketProvider` on unmount / `wsUrl` change.
- Hooks abort in-flight HTTP requests when their dep arrays change.

---

## Recipe — dapp skeleton

```tsx
import {
  PydeProvider,
  useBalance,
  useLiveWave,
  usePydeSigner,
} from "pyde-ts-sdk/react";
import { Wallet, formatPyde } from "pyde-ts-sdk";
import { useEffect, useState } from "react";

function App() {
  const [signer, setSigner] = useState<Wallet | null>(null);
  useEffect(() => {
    const w = Wallet.generate();
    setSigner(w);
    return () => w.destroy();
  }, []);

  if (!signer) return <p>loading…</p>;

  return (
    <PydeProvider
      rpcUrl="https://rpc.pyde.network"
      wsUrl="wss://rpc.pyde.network"
      signer={signer}
    >
      <Dapp />
    </PydeProvider>
  );
}

function Dapp() {
  const signer = usePydeSigner();
  const { data: balance } = useBalance(signer?.address);
  const wave = useLiveWave();

  return (
    <>
      <p>address: {signer?.address}</p>
      <p>balance: {balance != null && formatPyde(balance)} PYDE</p>
      <p>wave: {wave?.waveId.toString()}</p>
    </>
  );
}
```

---

## Gotchas

- **`useLiveWave` polls every 2 s if `wsUrl` is omitted.** Pass `wsUrl` for push semantics in dapps that need real-time freshness.
- **`useContract` re-runs on every `abiJson` change.** Memoize the ABI string outside the component or use a top-level constant.
- **`useEvents` accumulates indefinitely.** Pages with long sessions should reset state (e.g., clear after a wave threshold).
- **No automatic retries** on error — call `refetch()` from your error UI.
- **`signer` prop is optional.** If your app derives the wallet asynchronously (e.g., after `fromKeystoreFile`), pass `signer` from state once loaded.
- **Hooks that fetch an address won't run** if you pass `undefined`. Useful while loading the wallet.
- **WebSocket subscriptions are engine-side-blocked** as of this writing. `useLiveWave` / `useEvents` fall back to polling cleanly when `subscribe*` returns `method not found`.
